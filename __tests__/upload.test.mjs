import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { uploadIndex } from '../scripts/upload.mjs';
import { sha256Hex } from '../scripts/hash.mjs';

const UPLOAD = { uploadId: 'up_1', putUrl: 'https://x/put', maxBytes: 10_000_000 };

function fakeDoor({ completeResp = { status: 200, body: { id: 'up_1', status: 'uploaded' } }, putOk = true } = {}) {
  const calls = { complete: [], fail: [], put: [] };
  return {
    calls,
    async completeUpload(id, payload) {
      calls.complete.push({ id, payload });
      return completeResp;
    },
    async failUpload(id, reason) {
      calls.fail.push({ id, reason });
      return { status: 200, body: {} };
    },
    async putIndex(url, buf) {
      calls.put.push({ url, bytes: buf.length });
      return { status: putOk ? 200 : 500, ok: putOk, text: putOk ? undefined : 'put failed' };
    },
  };
}

async function withTmpFile(content, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-upload-'));
  const scipPath = path.join(dir, 'index.scip');
  await writeFile(scipPath, content);
  try {
    await fn(scipPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('uploadIndex reports "skipped" and /fails the upload when there is no index file', async () => {
  const door = fakeDoor();
  const result = await uploadIndex(door, 'typescript', '/nonexistent/index.scip', {}, UPLOAD);
  assert.equal(result.status, 'skipped');
  assert.equal(result.uploadId, 'up_1');
  assert.equal(door.calls.put.length, 0);
  assert.equal(door.calls.fail.length, 1);
  assert.equal(door.calls.fail[0].id, 'up_1');
});

test('uploadIndex fails soft via /fail when the gzip exceeds max_bytes, without ever PUTting', () =>
  withTmpFile(Buffer.alloc(10_000, 'x'), async (scipPath) => {
    const door = fakeDoor();

    const result = await uploadIndex(door, 'typescript', scipPath, {}, { ...UPLOAD, maxBytes: 5 });

    assert.equal(result.status, 'failed');
    assert.equal(door.calls.put.length, 0);
    assert.equal(door.calls.fail.length, 1);
    assert.equal(door.calls.fail[0].id, 'up_1');
  }));

test('uploadIndex succeeds: PUT -> complete with the raw (pre-gzip) sha256', () =>
  withTmpFile('hello scip', async (scipPath) => {
    const expectedSha256 = await sha256Hex(scipPath);
    const door = fakeDoor();

    const result = await uploadIndex(
      door,
      'typescript',
      scipPath,
      { indexerName: 'scip-typescript', indexerVersion: '0.4.0', actionVersion: 'code-intel-action@0.1.0' },
      UPLOAD,
    );

    assert.equal(result.status, 'uploaded');
    assert.equal(result.uploadId, 'up_1');
    assert.equal(door.calls.put.length, 1);
    assert.equal(door.calls.put[0].url, 'https://x/put');
    assert.equal(door.calls.complete[0].id, 'up_1');
    assert.equal(door.calls.complete[0].payload.sha256, expectedSha256);
    assert.equal(door.calls.complete[0].payload.indexer_name, 'scip-typescript');
    assert.equal(door.calls.fail.length, 0);
  }));

test('uploadIndex fails soft (and reports /fail once) when the PUT itself fails', () =>
  withTmpFile('hello scip', async (scipPath) => {
    const door = fakeDoor({ putOk: false });

    const result = await uploadIndex(door, 'typescript', scipPath, {}, UPLOAD);

    assert.equal(result.status, 'failed');
    assert.equal(door.calls.fail.length, 1);
  }));

test('uploadIndex fails soft (and reports /fail once) when complete does not return 200', () =>
  withTmpFile('hello scip', async (scipPath) => {
    const door = fakeDoor({ completeResp: { status: 500, body: { error: 'internal_error' } } });

    const result = await uploadIndex(door, 'typescript', scipPath, {}, UPLOAD);

    assert.equal(result.status, 'failed');
    assert.equal(door.calls.fail.length, 1);
  }));
