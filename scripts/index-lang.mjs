/**
 * index-lang.mjs -- runs one SCIP indexer over one root. The command line
 * for each language is its row in languages.mjs: TypeScript, Python and Java
 * run with `cwd` set to the project root (they read tsconfig.json /
 * pyproject.toml / the Maven or Gradle build from cwd); rust-analyzer takes
 * the root as its own positional argument instead, per its own CLI shape.
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
import { INDEXER_TIMEOUT_MS } from './timeouts.mjs';
import { languageDef } from './languages.mjs';
import { dirHasAnyAlternative } from './detect.mjs';

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

/** How much of a failed build step's output reaches the step summary. */
const MAX_STEP_MESSAGE_CHARS = 4000;

/**
 * A build step's captured output can be megabytes. The failure is at its end,
 * so keep the command line and the last part of the output; the exit code and
 * signal on the error are untouched.
 */
function keepMessageTail(err) {
  if (!(err instanceof Error) || err.message.length <= MAX_STEP_MESSAGE_CHARS) return err;
  const [firstLine, ...rest] = err.message.split('\n');
  err.message = `${firstLine}\n...\n${rest.join('\n').slice(-MAX_STEP_MESSAGE_CHARS)}`;
  return err;
}

/**
 * `project` (TypeScript only) is a project file path relative to the root;
 * see the typescript row in languages.mjs.
 *
 * The index lands in `<outputDir>/index.scip`, `outputDir` defaulting to the
 * root. A language that runs the repository's build gets a caller-supplied
 * scratch directory instead, so its build never sees (or cleans away) the
 * index.
 *
 * A root of such a language must carry one of its build markers: declared
 * roots are the user's word, but an indexer run over a directory with no
 * build would only fail with the build tool's own message.
 */
export async function runIndexer(lang, absoluteRootDir, bins, { project, outputDir, execFileImpl = execFile } = {}) {
  const def = languageDef(lang);
  if (def.runsBuild && !(await dirHasAnyAlternative(absoluteRootDir, def.markers))) {
    const wanted = def.markers.map((group) => group.join(' + ')).join(', ');
    throw new Error(`the root has none of ${lang}'s build files (${wanted}); declare the directory that holds the build`);
  }

  const output = path.join(outputDir ?? absoluteRootDir, SCIP_OUTPUT_NAME);
  const { args, cwd, maxBuffer } = def.command({ absoluteRoot: absoluteRootDir, output, project });

  const options = { timeout: INDEXER_TIMEOUT_MS };
  if (cwd !== undefined) options.cwd = cwd;
  if (maxBuffer !== undefined) options.maxBuffer = maxBuffer;
  if (def.nodeIndexer) options.env = nodeIndexerEnv();
  try {
    await execFileImpl(bins[def.binKey], args, options);
  } catch (err) {
    throw maxBuffer === undefined ? err : keepMessageTail(err);
  }

  return output;
}
