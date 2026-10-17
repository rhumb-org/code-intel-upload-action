import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processRoot } from '../scripts/run.mjs';

function fakeDoor({ createResp = { status: 201, body: { upload_id: 'up_1', put_url: 'https://x/put', max_bytes: 1e9 } } } = {}) {
  const calls = { create: [], fail: [] };
  return {
    calls,
    async createUpload(lang, roots) {
      calls.create.push({ lang, roots });
      return createResp;
    },
    async failUpload(id, reason) {
      calls.fail.push({ id, reason });
      return { status: 200, body: {} };
    },
  };
}

function ensureInstalledOk() {
  return async () => ({ scipTypescript: '/fake/scip-typescript' });
}

/** The shape `execFile` rejects with when the child exits non-zero. */
function childExitError({ code, signal = null, stderr = 'src/secret-module.ts: error TS2322' }) {
  return Object.assign(new Error(`Command failed: /runner/work/repo/.rci-cache/bin/scip-typescript index\n${stderr}`), {
    cmd: '/runner/work/repo/.rci-cache/bin/scip-typescript index',
    code,
    signal,
    killed: false,
    stderr,
  });
}

test('processRoot: an indexer child that dies (non-zero exit) becomes a /fail row, without its command line or stderr', async () => {
  const door = fakeDoor();

  const { label, result } = await processRoot({
    door,
    lang: 'typescript',
    root: '.',
    absoluteRoot: '/repo',
    ensureInstalled: ensureInstalledOk(),
    meta: {},
    runIndexerImpl: async () => {
      throw childExitError({ code: 134 });
    },
  });

  assert.equal(label, 'typescript @ .');
  assert.equal(door.calls.create.length, 1, 'an upload row must be minted BEFORE indexing runs');
  assert.equal(door.calls.fail.length, 1, 'the crash must be reported to /fail, not swallowed');
  assert.equal(door.calls.fail[0].id, 'up_1');
  assert.match(door.calls.fail[0].reason, /exit code 134/);
  assert.doesNotMatch(door.calls.fail[0].reason, /secret-module|\/runner\//);
  assert.equal(result.status, 'failed');
  assert.equal(result.uploadId, 'up_1');
  assert.equal(result.recorded, true);
  assert.match(result.reason, /secret-module/, 'the full detail stays in the caller-side result for the step summary');
});

test('processRoot: an install failure (before any indexing) is also recorded, not just indexer crashes', async () => {
  const door = fakeDoor();

  const { result } = await processRoot({
    door,
    lang: 'typescript',
    root: '.',
    absoluteRoot: '/repo',
    ensureInstalled: async () => {
      throw new Error('registry metadata fetch failed: 500');
    },
    meta: {},
  });

  assert.equal(door.calls.fail.length, 1);
  assert.match(door.calls.fail[0].reason, /registry metadata fetch failed/);
  assert.equal(result.status, 'failed');
  assert.equal(result.recorded, true);
});

test('processRoot: door unreachable at creation time stops there and says so honestly', async () => {
  let installCalls = 0;
  const door = {
    calls: { fail: [] },
    async createUpload() {
      throw new Error('fetch failed: ECONNREFUSED');
    },
    async failUpload(id, reason) {
      this.calls.fail.push({ id, reason });
      return { status: 200, body: {} };
    },
  };

  const { result } = await processRoot({
    door,
    lang: 'typescript',
    root: '.',
    absoluteRoot: '/repo',
    ensureInstalled: async () => {
      installCalls += 1;
      return {};
    },
    meta: {},
  });

  assert.equal(installCalls, 0, 'nothing is installed or indexed when the upload cannot be created');
  assert.equal(door.calls.fail.length, 0, 'nothing to /fail against when creation itself never minted an id');
  assert.equal(result.status, 'failed');
  assert.equal(result.uploadId, null);
  assert.equal(result.recorded, false, 'must not claim a row exists when none does');
  assert.match(result.reason, /ECONNREFUSED/);
});

test('processRoot: a rejected create (403) surfaces its status and body in the result', async () => {
  const door = fakeDoor({ createResp: { status: 403, body: { error: 'repository_not_registered' } } });

  const { result } = await processRoot({
    door,
    lang: 'typescript',
    root: '.',
    absoluteRoot: '/repo',
    ensureInstalled: ensureInstalledOk(),
    meta: {},
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.recorded, false);
  assert.match(result.reason, /HTTP 403/);
  assert.match(result.reason, /repository_not_registered/);
  assert.match(result.reason, /id-token: write/);
  assert.equal(door.calls.fail.length, 0);
});

test('processRoot: a rejected create caps how much of the response body it echoes', async () => {
  const door = fakeDoor({ createResp: { status: 500, body: { raw: 'x'.repeat(5000) } } });

  const { result } = await processRoot({
    door,
    lang: 'typescript',
    root: '.',
    absoluteRoot: '/repo',
    ensureInstalled: ensureInstalledOk(),
    meta: {},
  });

  assert.ok(result.reason.length < 800, `reason should be bounded, got ${result.reason.length} chars`);
});

test('processRoot: the happy path threads the created upload into uploadIndex', async () => {
  const door = fakeDoor();
  let uploadIndexArgs;

  const { result } = await processRoot({
    door,
    lang: 'typescript',
    root: '.',
    absoluteRoot: '/repo',
    ensureInstalled: ensureInstalledOk(),
    meta: { indexerName: 'scip-typescript' },
    runIndexerImpl: async () => '/repo/index.scip',
    uploadIndexImpl: async (d, lang, scipPath, meta, upload) => {
      uploadIndexArgs = { lang, scipPath, meta, upload };
      return { lang, status: 'uploaded', uploadId: upload.uploadId, rawBytes: 10, compressedBytes: 5, durationMs: 1 };
    },
  });

  assert.equal(door.calls.create.length, 1);
  assert.deepEqual(uploadIndexArgs.upload, { uploadId: 'up_1', putUrl: 'https://x/put', maxBytes: 1e9 });
  assert.equal(result.status, 'uploaded');
  assert.equal(result.uploadId, 'up_1');
});

test("processRoot: a root's project file reaches the indexer; a bare root passes none", async () => {
  const seen = [];
  const run = (project) =>
    processRoot({
      door: fakeDoor(),
      lang: 'typescript',
      root: '.',
      absoluteRoot: '/repo',
      project,
      ensureInstalled: ensureInstalledOk(),
      meta: {},
      runIndexerImpl: async (lang, absoluteRoot, bins, opts) => {
        seen.push(opts);
        return '/repo/index.scip';
      },
      uploadIndexImpl: async (d, lang) => ({ lang, status: 'uploaded', uploadId: 'up_1' }),
    });

  const named = await run('tsconfig.graph.json');
  await run(undefined);

  assert.deepEqual(seen, [{ project: 'tsconfig.graph.json' }, { project: undefined }]);
  assert.equal(named.label, 'typescript @ .', 'the label (and so the outputs keys) stays keyed by root alone');
});
