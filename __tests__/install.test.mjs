import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import {
  installNpmIndexer,
  installRustAnalyzer,
  detectRustAnalyzerPlatformKey,
  IndexerIntegrityError,
} from '../scripts/install.mjs';
import { npmIntegrityOfBuffer, sha256HexOfBuffer } from '../scripts/hash.mjs';

const RA_URL = 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-06/rust-analyzer-x86_64-unknown-linux-gnu.gz';

function bufToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function withTmpDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-install-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('installNpmIndexer throws IndexerIntegrityError on a hash mismatch, before ever invoking npm', () =>
  withTmpDir(async (dir) => {
    const tarball = Buffer.from('not-the-real-tarball-bytes');
    let execCalled = false;
    const fetchImpl = async (url) => {
      if (!url.endsWith('.tgz')) {
        return { ok: true, json: async () => ({ dist: { tarball: 'https://registry.npmjs.org/pkg/-/pkg-0.4.0.tgz' } }) };
      }
      return { ok: true, arrayBuffer: async () => bufToArrayBuffer(tarball) };
    };
    const execFileImpl = async () => {
      execCalled = true;
    };

    await assert.rejects(
      () =>
        installNpmIndexer(
          { npmPackage: '@sourcegraph/scip-typescript', version: '0.4.0', integrity: 'sha512-deadbeef==' },
          dir,
          { fetchImpl, execFileImpl },
        ),
      IndexerIntegrityError,
    );
    assert.equal(execCalled, false);
  }));

test('installNpmIndexer verifies integrity then installs from the local (already-downloaded) tarball', () =>
  withTmpDir(async (dir) => {
    const tarball = Buffer.from('pretend-tarball-bytes');
    const integrity = npmIntegrityOfBuffer(tarball);
    let execArgs;
    const fetchImpl = async (url) => {
      if (!url.endsWith('.tgz')) {
        return { ok: true, json: async () => ({ dist: { tarball: 'https://registry.npmjs.org/pkg/-/pkg-0.4.0.tgz' } }) };
      }
      return { ok: true, arrayBuffer: async () => bufToArrayBuffer(tarball) };
    };
    const execFileImpl = async (cmd, args) => {
      execArgs = [cmd, ...args];
    };

    const binPath = await installNpmIndexer(
      { npmPackage: '@sourcegraph/scip-typescript', version: '0.4.0', integrity },
      dir,
      { fetchImpl, execFileImpl },
    );

    assert.equal(execArgs[0], 'npm');
    assert.deepEqual(execArgs.slice(1, 4), ['install', '-g', '--prefix']);
    assert.equal(execArgs[4], dir);
    assert.ok(execArgs[5].endsWith('.tgz'));
    assert.equal(binPath, path.join(dir, 'bin', 'scip-typescript'));
  }));

test('installNpmIndexer surfaces a non-ok registry metadata response', () =>
  withTmpDir(async (dir) => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    await assert.rejects(
      () => installNpmIndexer({ npmPackage: '@sourcegraph/scip-python', version: '0.6.6', integrity: 'sha512-x' }, dir, { fetchImpl }),
      /registry metadata fetch failed/,
    );
  }));

test('installRustAnalyzer throws IndexerIntegrityError on a sha256 mismatch', () =>
  withTmpDir(async (dir) => {
    const asset = Buffer.from('not-the-real-binary-gz-bytes');
    const pin = {
      releaseTag: '2026-07-06',
      platforms: { 'x86_64-unknown-linux-gnu': { url: RA_URL, sha256: 'deadbeef' } },
    };
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => bufToArrayBuffer(asset) });

    await assert.rejects(() => installRustAnalyzer(pin, dir, 'x86_64-unknown-linux-gnu', fetchImpl), IndexerIntegrityError);
  }));

test('installRustAnalyzer verifies sha256 then writes the gunzipped, executable binary', () =>
  withTmpDir(async (dir) => {
    const original = Buffer.from('#!/bin/sh\necho hi\n');
    const gz = zlib.gzipSync(original);
    const sha256 = sha256HexOfBuffer(gz);
    const pin = { releaseTag: '2026-07-06', platforms: { 'x86_64-unknown-linux-gnu': { url: RA_URL, sha256 } } };
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => bufToArrayBuffer(gz) });

    const binPath = await installRustAnalyzer(pin, dir, 'x86_64-unknown-linux-gnu', fetchImpl);

    const written = await readFile(binPath);
    assert.deepEqual(written, original);
    const st = await stat(binPath);
    assert.ok((st.mode & 0o111) !== 0, 'binary should be executable');
  }));

test('installRustAnalyzer refuses a download URL outside the official rust-analyzer releases, before fetching', () =>
  withTmpDir(async (dir) => {
    const badUrls = [
      'https://example.test/ra.gz',
      'http://github.com/rust-lang/rust-analyzer/releases/download/2026-07-06/ra.gz',
      'https://github.com/someone-else/rust-analyzer/releases/download/2026-07-06/ra.gz',
      'https://github.com.evil.test/rust-lang/rust-analyzer/releases/download/2026-07-06/ra.gz',
      'not a url',
    ];
    for (const url of badUrls) {
      let fetched = false;
      const pin = { releaseTag: '2026-07-06', platforms: { 'x86_64-unknown-linux-gnu': { url, sha256: 'x' } } };
      await assert.rejects(
        () =>
          installRustAnalyzer(pin, dir, 'x86_64-unknown-linux-gnu', async () => {
            fetched = true;
            return { ok: true };
          }),
        /rust-analyzer pin url/,
        url,
      );
      assert.equal(fetched, false, `${url} must not be fetched`);
    }
  }));

test('install fetches and child processes are bounded by timeouts', () =>
  withTmpDir(async (dir) => {
    const tarball = Buffer.from('pretend-tarball-bytes');
    const signals = [];
    const fetchImpl = async (url, opts) => {
      signals.push(opts?.signal);
      if (!url.endsWith('.tgz')) {
        return { ok: true, json: async () => ({ dist: { tarball: 'https://registry.npmjs.org/pkg/-/pkg-0.4.0.tgz' } }) };
      }
      return { ok: true, arrayBuffer: async () => bufToArrayBuffer(tarball) };
    };
    let execOpts;
    const execFileImpl = async (cmd, args, opts) => {
      execOpts = opts;
    };

    await installNpmIndexer(
      { npmPackage: '@sourcegraph/scip-typescript', version: '0.4.0', integrity: npmIntegrityOfBuffer(tarball) },
      dir,
      { fetchImpl, execFileImpl },
    );

    assert.equal(signals.length, 2);
    for (const signal of signals) assert.ok(signal instanceof AbortSignal, 'every fetch carries an abort signal');
    assert.equal(typeof execOpts.timeout, 'number');
  }));

test('installRustAnalyzer throws for a platform absent from the pin', () =>
  withTmpDir(async (dir) => {
    const pin = { releaseTag: '2026-07-06', platforms: {} };
    await assert.rejects(() => installRustAnalyzer(pin, dir, 'x86_64-unknown-linux-gnu', async () => ({ ok: true })), /no entry for platform/);
  }));

test('detectRustAnalyzerPlatformKey maps node platform/arch to a rust target triple', () => {
  assert.equal(detectRustAnalyzerPlatformKey('linux', 'x64'), 'x86_64-unknown-linux-gnu');
  assert.equal(detectRustAnalyzerPlatformKey('linux', 'arm64'), 'aarch64-unknown-linux-gnu');
  assert.equal(detectRustAnalyzerPlatformKey('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.equal(detectRustAnalyzerPlatformKey('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.throws(() => detectRustAnalyzerPlatformKey('win32', 'x64'), /unsupported platform/);
});
