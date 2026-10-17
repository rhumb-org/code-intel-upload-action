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
