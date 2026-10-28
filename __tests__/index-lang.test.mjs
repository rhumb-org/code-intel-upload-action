import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runIndexer, computeMaxOldSpaceMb, KNOWN_GOOD_MAX_OLD_SPACE_MB, SCIP_OUTPUT_NAME } from '../scripts/index-lang.mjs';
import { INDEXER_TIMEOUT_MS } from '../scripts/timeouts.mjs';

test('computeMaxOldSpaceMb returns the known-good floor on a standard 7GB-ish runner', () => {
  const sevenGb = 7 * 1024 * 1024 * 1024;
  assert.equal(computeMaxOldSpaceMb(sevenGb), KNOWN_GOOD_MAX_OLD_SPACE_MB);
});

test('computeMaxOldSpaceMb scales up on a larger runner instead of capping at the floor', () => {
  const sixtyFourGb = 64 * 1024 * 1024 * 1024;
  const result = computeMaxOldSpaceMb(sixtyFourGb);
  assert.ok(result > KNOWN_GOOD_MAX_OLD_SPACE_MB, `expected ${result} > ${KNOWN_GOOD_MAX_OLD_SPACE_MB}`);
  assert.equal(result, Math.floor((sixtyFourGb / (1024 * 1024)) * 0.8));
});

test('computeMaxOldSpaceMb never drops below the known-good floor even on a tiny/unreadable value', () => {
  assert.equal(computeMaxOldSpaceMb(1 * 1024 * 1024 * 1024), KNOWN_GOOD_MAX_OLD_SPACE_MB);
  assert.equal(computeMaxOldSpaceMb(0), KNOWN_GOOD_MAX_OLD_SPACE_MB);
  assert.equal(computeMaxOldSpaceMb(NaN), KNOWN_GOOD_MAX_OLD_SPACE_MB);
  assert.equal(computeMaxOldSpaceMb(-1), KNOWN_GOOD_MAX_OLD_SPACE_MB);
});

test('runIndexer sets NODE_OPTIONS with a computed --max-old-space-size for the typescript (Node) child', async () => {
  let seenEnv;
  const execFileImpl = async (bin, args, opts) => {
    seenEnv = opts.env;
  };
  await runIndexer('typescript', '/repo/root', { scipTypescript: 'scip-typescript' }, { execFileImpl });
  assert.match(seenEnv.NODE_OPTIONS, /--max-old-space-size=\d+/);
  const mb = Number(seenEnv.NODE_OPTIONS.match(/--max-old-space-size=(\d+)/)[1]);
  assert.ok(mb >= KNOWN_GOOD_MAX_OLD_SPACE_MB);
});

test('runIndexer sets NODE_OPTIONS for the python (Node) child too', async () => {
  let seenEnv;
  const execFileImpl = async (bin, args, opts) => {
    seenEnv = opts.env;
  };
  await runIndexer('python', '/repo/root', { scipPython: 'scip-python' }, { execFileImpl });
  assert.match(seenEnv.NODE_OPTIONS, /--max-old-space-size=\d+/);
});

test('runIndexer appends onto (never replaces) a caller-supplied NODE_OPTIONS', async () => {
  const savedNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--stack-trace-limit=100';
  try {
    let seenEnv;
    const execFileImpl = async (bin, args, opts) => {
      seenEnv = opts.env;
    };
    await runIndexer('typescript', '/repo/root', { scipTypescript: 'scip-typescript' }, { execFileImpl });
    assert.match(seenEnv.NODE_OPTIONS, /--stack-trace-limit=100/);
    assert.match(seenEnv.NODE_OPTIONS, /--max-old-space-size=\d+/);
  } finally {
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
  }
});

test('runIndexer never sets NODE_OPTIONS for rust-analyzer (a native binary, not a Node process)', async () => {
  let seenOpts;
  const execFileImpl = async (bin, args, opts) => {
    seenOpts = opts;
  };
  await runIndexer('rust', '/repo/root', { rustAnalyzer: 'rust-analyzer' }, { execFileImpl });
  assert.equal(seenOpts.env, undefined);
});

test('runIndexer bounds every indexer child with a timeout', async () => {
  const seen = [];
  const execFileImpl = async (bin, args, opts) => {
    seen.push(opts.timeout);
  };
  await runIndexer('typescript', '/repo/root', { scipTypescript: 'scip-typescript' }, { execFileImpl });
  await runIndexer('python', '/repo/root', { scipPython: 'scip-python' }, { execFileImpl });
  await runIndexer('rust', '/repo/root', { rustAnalyzer: 'rust-analyzer' }, { execFileImpl });
  assert.deepEqual(seen, [INDEXER_TIMEOUT_MS, INDEXER_TIMEOUT_MS, INDEXER_TIMEOUT_MS]);
});

test('runIndexer writes the index to SCIP_OUTPUT_NAME under the root for every language', async () => {
  const calls = [];
  const execFileImpl = async (bin, args) => {
    calls.push({ bin, args });
  };
  await runIndexer('typescript', '/repo/root', { scipTypescript: 'scip-typescript' }, { execFileImpl });
  assert.ok(calls[0].args.includes(`/repo/root/${SCIP_OUTPUT_NAME}`));
});

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

test('runIndexer runs scip-java in the build root, writing into the given output dir, bounded and without a Node heap', async () => {
  const root = `${FIXTURES}java-maven-repo`;
  const calls = [];
  const output = await runIndexer('java', root, { scipJava: '/bin/scip-java' }, {
    outputDir: '/scratch/pair',
    execFileImpl: async (bin, args, opts) => calls.push({ bin, args, opts }),
  });
  assert.equal(output, `/scratch/pair/${SCIP_OUTPUT_NAME}`);
  assert.deepEqual(calls, [
    { bin: '/bin/scip-java', args: ['index', '--output', `/scratch/pair/${SCIP_OUTPUT_NAME}`], opts: { cwd: root, timeout: INDEXER_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 } },
  ]);
});

test('runIndexer keeps only the tail of a failed Java build, with the command line and exit code intact', async () => {
  const output = `${'compiling\n'.repeat(5000)}BUILD FAILED: the last line`;
  const failure = Object.assign(new Error(`Command failed: /bin/scip-java index\n${output}`), { code: 1 });
  await assert.rejects(
    () =>
      runIndexer('java', `${FIXTURES}java-maven-repo`, { scipJava: '/bin/scip-java' }, {
        execFileImpl: async () => {
          throw failure;
        },
      }),
    (err) => {
      assert.equal(err, failure);
      assert.equal(err.code, 1);
      assert.match(err.message, /^Command failed: \/bin\/scip-java index\n\.\.\.\n/);
      assert.match(err.message, /BUILD FAILED: the last line$/);
      assert.ok(err.message.length < 4100, `message is ${err.message.length} chars`);
      return true;
    },
  );
});

test('runIndexer leaves a typescript failure message as the child produced it', async () => {
  const failure = new Error(`Command failed: scip-typescript\n${'x'.repeat(10000)}`);
  await assert.rejects(
    () => runIndexer('typescript', '/repo/root', { scipTypescript: 'scip-typescript' }, { execFileImpl: async () => { throw failure; } }),
    (err) => err === failure && err.message.length > 10000,
  );
});

test('runIndexer on a java root without a build file fails with that reason and starts nothing', async () => {
  let started = false;
  await assert.rejects(
    () =>
      runIndexer('java', `${FIXTURES}empty-repo`, { scipJava: '/bin/scip-java' }, {
        execFileImpl: async () => {
          started = true;
        },
      }),
    /none of java's build files \(pom\.xml, build\.gradle, build\.gradle\.kts, settings\.gradle, settings\.gradle\.kts\)/,
  );
  assert.equal(started, false);
});

test('runIndexer rejects a language with no table row', async () => {
  await assert.rejects(() => runIndexer('go', '/repo/root', {}, { execFileImpl: async () => {} }), /unknown language "go"/);
});

test('runIndexer without a project runs bare `index` -- scip-typescript resolves <root>/tsconfig.json itself', async () => {
  const calls = [];
  const execFileImpl = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
  };
  await runIndexer('typescript', '/repo/root', { scipTypescript: 'scip-typescript' }, { execFileImpl });
  assert.deepEqual(calls[0].args, ['index', '--output', `/repo/root/${SCIP_OUTPUT_NAME}`]);
});

test('runIndexer selects pnpm workspace mode for a workspace root without a project', async () => {
  const root = fileURLToPath(new URL('./fixtures/pnpm-monorepo-repo', import.meta.url));
  const calls = [];
  await runIndexer('typescript', root, { scipTypescript: 'scip-typescript' }, {
    execFileImpl: async (bin, args, opts) => calls.push({ bin, args, opts }),
  });
  assert.deepEqual(calls[0].args, ['index', '--output', `${root}/${SCIP_OUTPUT_NAME}`, '--pnpm-workspaces']);
  assert.equal(calls[0].opts.cwd, root);
});

test('runIndexer preserves an explicit project instead of selecting pnpm workspace mode', async () => {
  const root = fileURLToPath(new URL('./fixtures/pnpm-monorepo-repo', import.meta.url));
  const calls = [];
  const execFileImpl = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
  };
  await runIndexer('typescript', root, { scipTypescript: 'scip-typescript' }, { project: 'apps/web/tsconfig.json', execFileImpl });
  assert.deepEqual(calls[0].args, ['index', '--output', `${root}/${SCIP_OUTPUT_NAME}`, 'apps/web/tsconfig.json']);
  assert.equal(calls[0].opts.cwd, root);
});
