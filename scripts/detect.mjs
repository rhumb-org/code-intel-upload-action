/**
 * detect.mjs -- language + root detection at the checked-out tree.
 *
 * Root markers: TypeScript's project boundary is a root `tsconfig.json`
 * ALONE -- scip-typescript resolves a project from it directly and does not
 * need a sibling package.json -- OR a `pnpm-workspace.yaml` alone
 * (scip-typescript's `--pnpm-workspaces` mode indexes every declared member
 * from that one marker even with no root tsconfig, so the workspace root
 * itself -- not each member -- is the root); Python's is pyproject.toml,
 * setup.py, or setup.cfg; Rust's is a Cargo.toml; Java's is a pom.xml,
 * build.gradle, build.gradle.kts, settings.gradle, or settings.gradle.kts;
 * C#'s is any `*.sln`, `*.slnx` or `*.csproj` file (a marker written `*.ext`
 * matches by extension, case-insensitively). The markers live in
 * languages.mjs, one row per language.
 *
 * Java's and C#'s roots are detected here only so the run can tell the user
 * what it skipped: indexing them runs the repository's own build, so they are
 * opt-in and
 * `withholdBuildRoots` removes detected roots of such languages before they
 * can be indexed.
 *
 * TOPMOST MARKER WINS: once a directory matches a language's root marker,
 * the walk stops looking for that SAME language any further down that
 * directory's own subtree -- a nested marker there belongs to the project
 * the topmost marker already declares, not a second independent root. This
 * collapses a multi-crate Cargo workspace (root Cargo.toml + N member
 * crates, each with their own Cargo.toml) to the ONE root the workspace
 * actually builds as, and a pnpm workspace's per-member tsconfig.json files
 * to the ONE root `--pnpm-workspaces` already covers; without it a workspace
 * of N crates would run N competing rust-analyzer passes and upload N
 * competing indexes per commit. The rule applies independently per language
 * and per branch of the tree: two sibling directories (packages/api's
 * tsconfig.json and services/worker's pyproject.toml) are each still their
 * own root, since neither is nested inside the other's matched subtree.
 *
 * RUST'S ONE EXCEPTION: a nested Cargo.toml that itself declares a BARE
 * `[workspace]` table breaks back OUT of an ancestor workspace's
 * suppression, because it IS a second independent root -- `cargo metadata`
 * (which `rust-analyzer scip` shells out to) refuses to resolve a crate
 * that "believes it's in a workspace when it's not" unless that nested
 * Cargo.toml declares its own `[workspace]`. A nested `[package]`-only
 * Cargo.toml (an ordinary MEMBER crate) never breaks the suppression --
 * only a nested `[workspace]` does, and it in turn suppresses ITS OWN
 * members the same way, recursively.
 *
 * `pyproject.toml` and `Cargo.toml` additionally get a CONTENT check: a
 * `pyproject.toml` only counts when it declares a `[project]` or
 * `[build-system]` table (a tool-config-only file, e.g. pytest's
 * `[tool.pytest.ini_options]`, is not a python project marker), and a
 * `Cargo.toml` only counts when it declares a BARE `[package]` or
 * `[workspace]` table header (a dotted child like `[workspace.metadata]`
 * does not count -- see `CARGO_TOML_PROJECT_TABLE_RE` below). Every other
 * marker file (`tsconfig.json`, `pnpm-workspace.yaml`, `setup.py`,
 * `setup.cfg`) is existence-only.
 *
 * A layout this walk still gets wrong (unbounded depth, or a marker present
 * without a real project behind it in some other way) declares itself
 * explicitly via `.rci-index.yml` or the `roots-override` input instead of
 * fighting the walk's bounds; both take precedence over auto-detection --
 * see `mergeRoots` below and the README's "Root detection" section.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { LANGUAGES, KNOWN_LANGUAGES, BUILD_RUNNING_LANGUAGES } from './languages.mjs';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'venv',
  '__pycache__',
  'vendor',
]);

const MAX_DEPTH = 4;


/**
 * A `[project]` or `[build-system]` TOML table header (top-level or dotted,
 * e.g. `[project.scripts]`), tolerant of interior whitespace inside the
 * brackets -- PEP 517/518's own project-declaration signal.
 */
const PYPROJECT_PROJECT_TABLE_RE = /^\s*\[\s*(project|build-system)\s*(\.[^\]]*)?\s*\]/m;

/**
 * A BARE `[package]` or `[workspace]` TOML table HEADER -- deliberately NOT
 * dotted (unlike `PYPROJECT_PROJECT_TABLE_RE`'s `[project.scripts]`
 * allowance): a dotted child like `[package.metadata]` or
 * `[workspace.dependencies]` can appear without the parent ever declaring the
 * required fields, so it doesn't count.
 */
const CARGO_TOML_PROJECT_TABLE_RE = /^\s*\[\s*(package|workspace)\s*\]/m;

/**
 * A BARE `[workspace]` table HEADER only -- the narrower sibling of
 * `CARGO_TOML_PROJECT_TABLE_RE` used to detect a NESTED workspace root (see
 * the module doc's "RUST'S ONE EXCEPTION"): a nested Cargo.toml matches this
 * only when it declares `[workspace]` itself, never merely `[package]`, so a
 * plain member crate inside an already-claimed workspace subtree keeps being
 * suppressed while a genuinely independent nested workspace is not.
 */
const CARGO_WORKSPACE_TABLE_RE = /^\s*\[\s*workspace\s*\]/m;

/**
 * Per-marker-file content validators -- keyed by the exact
 * filename in `MARKER_ALTERNATIVES`, run only after the file's existence is
 * already confirmed. A marker file with no entry here is existence-only.
 * Never throws -- an unreadable/malformed file degrades to
 * `false` (not-a-project), the same conservative default `dirHasAll` already
 * applies to a missing file.
 */
const CONTENT_VALIDATORS = {
  async 'pyproject.toml'(filePath) {
    try {
      return PYPROJECT_PROJECT_TABLE_RE.test(await readFile(filePath, 'utf8'));
    } catch {
      return false;
    }
  },
  async 'Cargo.toml'(filePath) {
    try {
      return CARGO_TOML_PROJECT_TABLE_RE.test(await readFile(filePath, 'utf8'));
    } catch {
      return false;
    }
  },
};

/** Does `dir` hold a file whose name ends with `suffix` (e.g. `.sln`), ignoring case? */
async function dirHasFileWithSuffix(dir, suffix) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => !entry.isDirectory() && entry.name.toLowerCase().endsWith(suffix));
}

async function dirHasAll(dir, files) {
  for (const file of files) {
    if (file.startsWith('*.')) {
      if (!(await dirHasFileWithSuffix(dir, file.slice(1)))) return false;
      continue;
    }
    const filePath = path.join(dir, file);
    try {
      await stat(filePath);
    } catch {
      return false;
    }
    const validateContent = CONTENT_VALIDATORS[file];
    if (validateContent && !(await validateContent(filePath))) return false;
  }
  return true;
}

/**
 * Does `dir` carry one of a language's root markers: ANY group's files ALL
 * present (see `markers` in languages.mjs).
 */
export async function dirHasAnyAlternative(dir, alternatives) {
  for (const files of alternatives) {
    if (await dirHasAll(dir, files)) return true;
  }
  return false;
}

/**
 * Does `dir` carry a Cargo.toml that declares a BARE `[workspace]` table
 * itself? Used only to re-open rust detection inside an already-covered
 * subtree (see `walk`'s rust special-case) -- a nested `[package]`-only
 * Cargo.toml must NOT match here, only a nested `[workspace]` one. Never
 * throws, same conservative-on-error default as `dirHasAll`.
 */
async function cargoTomlIsWorkspaceRoot(dir) {
  const filePath = path.join(dir, 'Cargo.toml');
  try {
    await stat(filePath);
  } catch {
    return false;
  }
  try {
    return CARGO_WORKSPACE_TABLE_RE.test(await readFile(filePath, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Walks `dir` and every eligible descendant up to `MAX_DEPTH`, calling
 * `visit(dir, lang)` once for each language whose root marker matches a
 * directory -- but only when that language is not already in `covered`
 * (the set of languages a matched ANCESTOR directory already claimed).
 * Each directory's own matches are added to the set passed to ITS
 * children, never back to its siblings, so the suppression follows the
 * tree shape exactly: topmost match wins within a subtree, independent
 * branches are independently detected.
 *
 * Rust's one exception (see the module doc): when `rust` IS already
 * covered, the marker check is not simply skipped -- a nested Cargo.toml
 * that itself declares `[workspace]` still matches and re-opens rust
 * detection for that directory's own subtree, because it is a second,
 * genuinely independent workspace root, not a member of the ancestor one.
 * A nested `[package]`-only Cargo.toml stays suppressed, same as before.
 */
async function walk(dir, depth, covered, visit) {
  const coveredForChildren = new Set(covered);
  for (const lang of KNOWN_LANGUAGES) {
    const alreadyCovered = covered.has(lang);
    const matches = alreadyCovered
      ? lang === 'rust' && (await cargoTomlIsWorkspaceRoot(dir))
      : await dirHasAnyAlternative(dir, LANGUAGES[lang].markers);
    if (!matches) continue;
    await visit(dir, lang);
    coveredForChildren.add(lang);
  }

  if (depth >= MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
    await walk(path.join(dir, entry.name), depth + 1, coveredForChildren, visit);
  }
}

/**
 * Auto-detects languages present under `repoRoot`. Returns one string[] per
 * language in languages.mjs, each entry a
 * POSIX-separated path relative to `repoRoot` ("." for the repo root
 * itself). See the module doc for the topmost-marker-wins rule that keeps
 * a nested member of an already-detected root from becoming a second one.
 */
export async function detectRoots(repoRoot) {
  const found = Object.fromEntries(KNOWN_LANGUAGES.map((lang) => [lang, []]));

  await walk(repoRoot, 0, new Set(), async (dir, lang) => {
    const rel = path.relative(repoRoot, dir) || '.';
    const relPosix = rel === '.' ? '.' : rel.split(path.sep).join('/');
    found[lang].push(relPosix);
  });

  return found;
}

/**
 * Splits detected roots into those the run may index and those it withholds:
 * a language whose indexing runs the repository's build (`runsBuild`) is
 * opt-in, so its detected roots are never indexed -- only listed, for the
 * step summary's SKIPPED notice. Returns `{ roots, withheld }`, where
 * `withheld` maps a language to its detected roots (only non-empty ones).
 */
export function withholdBuildRoots(detected) {
  const roots = { ...detected };
  const withheld = {};
  for (const lang of BUILD_RUNNING_LANGUAGES) {
    if ((detected[lang] ?? []).length === 0) continue;
    withheld[lang] = detected[lang];
    roots[lang] = [];
  }
  return { roots, withheld };
}

/**
 * Merges auto-detected roots with an override (either `.rci-index.yml`'s
 * parsed `roots` object or the `roots-override` JSON input): a language key
 * PRESENT in `override` fully replaces that language's base roots
 * (including an explicit `[]` to skip a language auto-detection would
 * otherwise have picked up); a language absent from `override` keeps its
 * base roots unchanged. `override: null` (no `.rci-index.yml`) is a no-op.
 */
export function mergeRoots(base, override) {
  const merged = { ...base };
  if (override === null || override === undefined) return merged;
  for (const [lang, roots] of Object.entries(override)) {
    merged[lang] = roots;
  }
  return merged;
}
