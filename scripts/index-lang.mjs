/**
 * index-lang.mjs -- runs one SCIP indexer over one root. TypeScript and
 * Python run with `cwd` set to the project root (scip-typescript and
 * scip-python read tsconfig.json / pyproject.toml from cwd, unless a
 * TypeScript root names its project file or declares a pnpm workspace);
 * rust-analyzer takes the root as its own positional argument instead,
 * per its own CLI shape.
 *
 * HEAP SIZING. scip-typescript and scip-python are themselves Node
 * processes that build a full type-checked program over the target root --
 * the same cost class as `tsc` -- and inherit Node's default old-space
 * ceiling unless told otherwise. A large TypeScript monorepo can exceed
 * that default and be killed with an out-of-memory abort (exit 134), so
 * every run gets a 6144 MB ceiling as a floor; measured peak RSS on such a
 * repository was about 4.3-4.8 GB. There is no reliable per-repository
 * signal to size a smaller number safely (TypeScript memory cost tracks
 * type and generic complexity, not file count or byte size). What is a
 * checkable signal is how much memory the runner itself has: a bigger
 * runner gets proportionally more headroom. Raising the ceiling costs
 * nothing for a repository too small to need it -- `--max-old-space-size`
 * is a limit V8 grows into lazily, never a pre-allocation.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { INDEXER_TIMEOUT_MS } from './timeouts.mjs';

const execFile = promisify(execFileCb);

export const SCIP_OUTPUT_NAME = 'index.scip';

/** Measured floor -- see the module doc's HEAP SIZING section. */
export const KNOWN_GOOD_MAX_OLD_SPACE_MB = 6144;

/** Leave headroom for the OS, the parent `run.mjs` process, and V8's own
 *  overhead above the requested old-space ceiling. */
const MAX_OLD_SPACE_MEMORY_FRACTION = 0.8;

/**
 * The old-space ceiling (MB) to hand the scip-typescript/scip-python child
 * via `NODE_OPTIONS`: the larger of the measured floor and a fraction of
 * the runner's own total memory, so a bigger runner gets more headroom
 * instead of being capped at the same number a standard hosted runner
 * needs. Falls back to the floor when total memory can't be read.
 */
export function computeMaxOldSpaceMb(totalMemBytes = os.totalmem()) {
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return KNOWN_GOOD_MAX_OLD_SPACE_MB;
  const totalMemMb = Math.floor(totalMemBytes / (1024 * 1024));
  const memoryHeadroomMb = Math.floor(totalMemMb * MAX_OLD_SPACE_MEMORY_FRACTION);
  return Math.max(KNOWN_GOOD_MAX_OLD_SPACE_MB, memoryHeadroomMb);
}

/** Appends (never replaces) the computed heap flag onto any `NODE_OPTIONS`
 *  the calling environment already set, for the two indexers that are
 *  themselves Node processes. rust-analyzer is a native binary -- it never
 *  reads `NODE_OPTIONS` and has no V8 heap to size. */
function nodeIndexerEnv(totalMemBytes) {
  const flag = `--max-old-space-size=${computeMaxOldSpaceMb(totalMemBytes)}`;
  const existing = process.env.NODE_OPTIONS;
  return { ...process.env, NODE_OPTIONS: existing ? `${existing} ${flag}` : flag };
}

/**
 * `project` (TypeScript only) is a project file path relative to the root,
 * passed as scip-typescript's positional project argument; without it
 * a pnpm workspace marker selects all its members; other roots use
 * `<root>/tsconfig.json`. An explicit project takes precedence over the
 * workspace marker and is resolved against the root.
 */
export async function runIndexer(lang, absoluteRootDir, bins, { project, execFileImpl = execFile } = {}) {
  const output = path.join(absoluteRootDir, SCIP_OUTPUT_NAME);

  if (lang === 'typescript') {
    const projectArgs = project === undefined ? [] : [project];
    if (project === undefined && existsSync(path.join(absoluteRootDir, 'pnpm-workspace.yaml'))) {
      projectArgs.push('--pnpm-workspaces');
    }
    await execFileImpl(bins.scipTypescript, ['index', '--output', output, ...projectArgs], {
      cwd: absoluteRootDir,
      env: nodeIndexerEnv(),
      timeout: INDEXER_TIMEOUT_MS,
    });
  } else if (lang === 'python') {
    await execFileImpl(bins.scipPython, ['index', '--output', output], {
      cwd: absoluteRootDir,
      env: nodeIndexerEnv(),
      timeout: INDEXER_TIMEOUT_MS,
    });
  } else if (lang === 'rust') {
    await execFileImpl(bins.rustAnalyzer, ['scip', absoluteRootDir, '--output', output], { timeout: INDEXER_TIMEOUT_MS });
  } else {
    throw new Error(`unknown language "${lang}"`);
  }

  return output;
}
