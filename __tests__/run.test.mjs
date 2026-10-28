import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { processLanguage, installIndexerFor } from '../scripts/run.mjs';

function fakeDoor({ createResp = { status: 201, body: { upload_id: 'up_1', put_url: 'https://x/put', max_bytes: 1e9 } } } = {}) {
  const calls = { create: [], fail: [], put: [], complete: [] };
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
    async putIndex(url, body) {
      calls.put.push({ url, body });
      return { status: 200, ok: true };
    },
    async completeUpload(id, payload) {
      calls.complete.push({ id, payload });
      return { status: 200, body: { status: 'uploaded' } };
    },
  };
}

function ensureInstalledOk() {
  return async () => ({ scipTypescript: '/fake/scip-typescript' });
}

const roots = (...names) => names.map((root) => ({ root, project: undefined }));

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

/** Runs `fn(tempDir)` with RUNNER_TEMP pointing at a fresh directory, so scratch space is observable. */
async function withRunnerTemp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-test-'));
  const previous = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const quiet = () => {};

test('processLanguage: an indexer child that dies (non-zero exit) becomes a /fail row, without its command line or stderr', async () => {
  const door = fakeDoor();

  const { label, result, rootLines } = await processLanguage({
    door,
    lang: 'typescript',
    roots: roots('.'),
    repoRoot: '/repo',
    ensureInstalled: ensureInstalledOk(),
    meta: {},
    runIndexerImpl: async () => {
      throw childExitError({ code: 134 });
    },
    log: quiet,
  });

  assert.equal(label, 'typescript');
  assert.equal(door.calls.create.length, 1, 'an upload row must be minted BEFORE indexing runs');
  assert.equal(door.calls.fail.length, 1, 'the crash must be reported to /fail, not swallowed');
  assert.equal(door.calls.fail[0].id, 'up_1');
  assert.equal(door.calls.fail[0].reason, '.: child process failed (exit code 134)');
  assert.doesNotMatch(door.calls.fail[0].reason, /secret-module|\/runner\//);
  assert.equal(result.status, 'failed');
  assert.equal(result.uploadId, 'up_1');
  assert.equal(result.recorded, true);
  assert.match(result.reason, /failed: \./);
  assert.match(rootLines.join('\n'), /FAILED {2}typescript @ \.: [\s\S]*secret-module/, 'the full detail stays caller-side, in the step summary');
});

test('processLanguage: an install failure (before any indexing) is also recorded, not just indexer crashes', async () => {
  const door = fakeDoor();

  const { result } = await processLanguage({
    door,
    lang: 'typescript',
    roots: roots('.'),
    repoRoot: '/repo',
    ensureInstalled: async () => {
      throw new Error('registry metadata fetch failed: 500');
    },
    meta: {},
    log: quiet,
  });

  assert.equal(door.calls.fail.length, 1);
  assert.match(door.calls.fail[0].reason, /registry metadata fetch failed/);
  assert.equal(result.status, 'failed');
  assert.equal(result.recorded, true);
});

test('processLanguage: door unreachable at creation time stops there and says so honestly', async () => {
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

  const { result } = await processLanguage({
    door,
    lang: 'typescript',
    roots: roots('.'),
    repoRoot: '/repo',
    ensureInstalled: async () => {
      installCalls += 1;
      return {};
    },
    meta: {},
    log: quiet,
  });

  assert.equal(installCalls, 0, 'nothing is installed or indexed when the upload cannot be created');
  assert.equal(door.calls.fail.length, 0, 'nothing to /fail against when creation itself never minted an id');
  assert.equal(result.status, 'failed');
  assert.equal(result.uploadId, null);
  assert.equal(result.recorded, false, 'must not claim a row exists when none does');
  assert.match(result.reason, /ECONNREFUSED/);
});

test('processLanguage: a rejected create (403) surfaces its status and body in the result', async () => {
  const door = fakeDoor({ createResp: { status: 403, body: { error: 'repository_not_registered' } } });

  const { result } = await processLanguage({
    door,
    lang: 'typescript',
    roots: roots('.'),
    repoRoot: '/repo',
    ensureInstalled: ensureInstalledOk(),
    meta: {},
    log: quiet,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.recorded, false);
  assert.match(result.reason, /HTTP 403/);
  assert.match(result.reason, /repository_not_registered/);
  assert.match(result.reason, /id-token: write/);
  assert.equal(door.calls.fail.length, 0);
});

test('processLanguage: a rejected create caps how much of the response body it echoes', async () => {
  const door = fakeDoor({ createResp: { status: 500, body: { raw: 'x'.repeat(5000) } } });

  const { result } = await processLanguage({
    door,
    lang: 'typescript',
    roots: roots('.'),
    repoRoot: '/repo',
    ensureInstalled: ensureInstalledOk(),
    meta: {},
    log: quiet,
  });

  assert.ok(result.reason.length < 800, `reason should be bounded, got ${result.reason.length} chars`);
});

test('processLanguage: several roots make one create, one merge and one upload; each root is indexed into its own scratch dir outside the checkout, removed afterwards', async () => {
  await withRunnerTemp(async (runnerTemp) => {
    const door = fakeDoor();
    const outputDirs = [];
    const indexerCalls = [];
    let mergeInput;
    const uploads = [];

    const { label, result } = await processLanguage({
      door,
      lang: 'java',
      roots: roots('maven', 'gradle'),
      repoRoot: '/repo',
      ensureInstalled: async () => ({ scipJava: '/fake/scip-java' }),
      meta: { indexerName: 'scip-java' },
      runIndexerImpl: async (lang, absoluteRoot, bins, opts) => {
        indexerCalls.push({ lang, absoluteRoot });
        outputDirs.push(opts.outputDir);
        assert.equal((await stat(opts.outputDir)).isDirectory(), true);
        return `${opts.outputDir}/index.scip`;
      },
      mergeImpl: async (args) => {
        mergeInput = args;
        return { path: `${args.outputPath}`, passthrough: false };
      },
      uploadIndexImpl: async (d, lang, scipPath, meta, upload) => {
        uploads.push({ scipPath, upload });
        return { lang, status: 'uploaded', uploadId: upload.uploadId, rawBytes: 9, compressedBytes: 5, durationMs: 1 };
      },
      log: quiet,
    });

    assert.deepEqual(door.calls.create, [{ lang: 'java', roots: ['maven', 'gradle'] }], 'one create per language, naming every root');
    assert.equal(label, 'java');
    assert.deepEqual(indexerCalls, [
      { lang: 'java', absoluteRoot: path.resolve('/repo', 'maven') },
      { lang: 'java', absoluteRoot: path.resolve('/repo', 'gradle') },
    ]);
    assert.equal(new Set(outputDirs).size, 2, 'every root has a scratch dir of its own');
    for (const dir of outputDirs) assert.ok(dir.startsWith(runnerTemp), 'scratch lives under RUNNER_TEMP, not in the checkout');
    assert.deepEqual(
      mergeInput.inputs.map(({ root }) => root),
      ['maven', 'gradle'],
      'roots reach the merge in declared order',
    );
    assert.equal(mergeInput.projectRootUri, 'file:///repo');
    assert.equal(uploads.length, 1, 'one upload for the language');
    assert.equal(uploads[0].scipPath, mergeInput.outputPath);
    assert.deepEqual(uploads[0].upload, { uploadId: 'up_1', putUrl: 'https://x/put', maxBytes: 1e9 });
    assert.equal(result.status, 'uploaded');
    for (const dir of outputDirs) await assert.rejects(() => stat(dir), { code: 'ENOENT' });
    assert.deepEqual(await readdir(runnerTemp), [], 'no scratch left behind');
  });
});

test('processLanguage: any failed root fails the language -- nothing is merged or uploaded, each failed root is named, indexed roots are listed', async () => {
  await withRunnerTemp(async (runnerTemp) => {
    const door = fakeDoor();
    const lines = [];
    let merged = false;
    let uploaded = false;
    const attempted = [];

    const { result, rootLines } = await processLanguage({
      door,
      lang: 'java',
      roots: roots('a', 'b', 'c', 'd'),
      repoRoot: '/repo',
      ensureInstalled: async () => ({ scipJava: '/fake/scip-java' }),
      meta: {},
      runIndexerImpl: async (lang, absoluteRoot, bins, opts) => {
        const name = path.basename(absoluteRoot);
        attempted.push(name);
        if (name === 'b') throw childExitError({ code: 1, stderr: 'BUILD FAILURE' });
        if (name === 'd') throw new Error('the root has none of java\'s build files');
        return `${opts.outputDir}/index.scip`;
      },
      mergeImpl: async () => {
        merged = true;
      },
      uploadIndexImpl: async () => {
        uploaded = true;
      },
      log: (line) => lines.push(line),
    });

    assert.deepEqual(attempted, ['a', 'b', 'c', 'd'], 'every root is attempted so every failure is named');
    assert.equal(merged, false);
    assert.equal(uploaded, false, 'nothing partial is uploaded');
    assert.deepEqual(door.calls.fail, [{ id: 'up_1', reason: "b: child process failed (exit code 1); d: the root has none of java's build files" }]);
    assert.equal(result.status, 'failed');
    assert.equal(result.recorded, true);
    assert.equal(result.uploadId, 'up_1');
    assert.match(result.reason, /failed: b, d/);
    assert.match(result.reason, /indexed but not uploaded: a, c/);
    assert.deepEqual(lines, rootLines, 'per-root lines reach the log as they happen and come back for the summary');
    assert.match(lines[0], /^OK {6}java @ a: indexed in \d+\.\ds$/);
    assert.match(lines[1], /^FAILED {2}java @ b: [\s\S]*BUILD FAILURE/);
    assert.deepEqual(await readdir(runnerTemp), [], 'scratch removed after a failure too');
  });
});

test('processLanguage: the reason sent to the door is capped', async () => {
  const names = Array.from({ length: 40 }, (_, i) => `services/some-long-module-name-${i}`);
  const door = fakeDoor();

  await processLanguage({
    door,
    lang: 'typescript',
    roots: roots(...names),
    repoRoot: '/repo',
    ensureInstalled: ensureInstalledOk(),
    meta: {},
    runIndexerImpl: async () => {
      throw new Error('boom');
    },
    log: quiet,
  });

  assert.equal(door.calls.fail.length, 1);
  assert.equal(door.calls.fail[0].reason.length, 500);
  assert.match(door.calls.fail[0].reason, /^services\/some-long-module-name-0: boom; /);
});

test('processLanguage: a merge or upload that throws is recorded against the upload and the scratch is still removed', async () => {
  await withRunnerTemp(async (runnerTemp) => {
    const door = fakeDoor();
    const { result } = await processLanguage({
      door,
      lang: 'rust',
      roots: roots('crates/a', 'crates/b'),
      repoRoot: '/repo',
      ensureInstalled: async () => ({}),
      meta: {},
      runIndexerImpl: async (lang, absoluteRoot, bins, opts) => `${opts.outputDir}/index.scip`,
      mergeImpl: async () => {
        throw new Error('truncated SCIP index: a field runs past the end of the file');
      },
      log: quiet,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.recorded, true);
    assert.match(door.calls.fail[0].reason, /truncated SCIP index/);
    assert.deepEqual(await readdir(runnerTemp), []);
  });
});

test("processLanguage: each root's project file reaches its own indexer run; a bare root passes none", async () => {
  const seen = [];
  await processLanguage({
    door: fakeDoor(),
    lang: 'typescript',
    roots: [
      { root: 'a', project: 'tsconfig.graph.json' },
      { root: 'b', project: undefined },
    ],
    repoRoot: '/repo',
    ensureInstalled: ensureInstalledOk(),
    meta: {},
    runIndexerImpl: async (lang, absoluteRoot, bins, opts) => {
      seen.push(opts.project);
      return `${opts.outputDir}/index.scip`;
    },
    mergeImpl: async () => ({ path: '/x', passthrough: false }),
    uploadIndexImpl: async (d, lang) => ({ lang, status: 'uploaded', uploadId: 'up_1' }),
    log: quiet,
  });

  assert.deepEqual(seen, ['tsconfig.graph.json', undefined]);
});

test('installIndexerFor rejects a language with no table row', async () => {
  await assert.rejects(() => installIndexerFor('go', {}, '/bins'), /unknown language "go"/);
});

// End to end through the real merge and the real upload, with only the indexer and the network faked.
const varint = (n) => Buffer.from([n]);
const lenField = (field, payload) => {
  const bytes = Buffer.from(payload);
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
};
const indexOf = (...docPaths) =>
  Buffer.concat([lenField(1, Buffer.concat([lenField(2, 'tool'), lenField(3, 'file:///indexer/root')])), ...docPaths.map((p) => lenField(2, lenField(1, p)))]);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

test('a single root `.` uploads exactly the bytes the indexer wrote (same sha256, raw bytes and body)', async () => {
  await withRunnerTemp(async () => {
    const door = fakeDoor();
    const written = indexOf('src/a.ts', 'src/b.ts');

    const { result } = await processLanguage({
      door,
      lang: 'typescript',
      roots: roots('.'),
      repoRoot: '/repo',
      ensureInstalled: ensureInstalledOk(),
      meta: { indexerName: 'scip-typescript', indexerVersion: '1', actionVersion: 'code-intel-action@test' },
      runIndexerImpl: async (lang, absoluteRoot, bins, opts) => {
        const file = path.join(opts.outputDir, 'index.scip');
        await writeFile(file, written);
        return file;
      },
      log: quiet,
    });

    assert.equal(result.status, 'uploaded');
    assert.equal(door.calls.complete.length, 1);
    assert.equal(door.calls.complete[0].payload.sha256, sha256(written));
    assert.equal(door.calls.complete[0].payload.raw_bytes, written.length);
    assert.ok(gunzipSync(door.calls.put[0].body).equals(written));
  });
});

test('several roots upload one merged index with each root in front of its paths', async () => {
  await withRunnerTemp(async () => {
    const door = fakeDoor();
    const byRoot = { 'lib/a': indexOf('src/x.rs'), 'lib/b': indexOf('src/y.rs') };

    const { result } = await processLanguage({
      door,
      lang: 'rust',
      roots: roots('lib/a', 'lib/b'),
      repoRoot: '/work/repo',
      ensureInstalled: async () => ({}),
      meta: {},
      runIndexerImpl: async (lang, absoluteRoot, bins, opts) => {
        const file = path.join(opts.outputDir, 'index.scip');
        await writeFile(file, byRoot[path.relative('/work/repo', absoluteRoot)]);
        return file;
      },
      log: quiet,
    });

    assert.equal(result.status, 'uploaded');
    assert.equal(door.calls.put.length, 1);
    const uploaded = gunzipSync(door.calls.put[0].body);
    assert.equal(door.calls.complete[0].payload.sha256, sha256(uploaded));
    const text = uploaded.toString('latin1');
    assert.ok(text.includes('lib/a/src/x.rs') && text.includes('lib/b/src/y.rs'));
    assert.ok(text.includes('file:///work/repo'), 'project_root is the workspace');
    assert.ok(!text.includes('file:///indexer/root'));
    assert.ok(text.indexOf('lib/a/src/x.rs') < text.indexOf('lib/b/src/y.rs'));
  });
});

test('the merged upload leaves nothing in the checkout', async () => {
  await withRunnerTemp(async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'run-test-repo-'));
    try {
      await processLanguage({
        door: fakeDoor(),
        lang: 'python',
        roots: roots('a', 'b'),
        repoRoot: repo,
        ensureInstalled: async () => ({}),
        meta: {},
        runIndexerImpl: async (lang, absoluteRoot, bins, opts) => {
          const file = path.join(opts.outputDir, 'index.scip');
          await writeFile(file, indexOf('m.py'));
          return file;
        },
        log: quiet,
      });
      assert.deepEqual(await readdir(repo), []);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
