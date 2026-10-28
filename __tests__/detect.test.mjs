import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectRoots, mergeRoots } from '../scripts/detect.mjs';
import { loadRciIndexConfig } from '../scripts/rci-index-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

test('detects typescript from package.json + tsconfig.json at the repo root', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'ts-repo'));
  assert.deepEqual(roots.typescript, ['.']);
  assert.deepEqual(roots.python, []);
  assert.deepEqual(roots.rust, []);
});

test('detects python from pyproject.toml', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'py-repo'));
  assert.deepEqual(roots.python, ['.']);
  assert.deepEqual(roots.typescript, []);
});

test('detects rust from Cargo.toml', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'rust-repo'));
  assert.deepEqual(roots.rust, ['.']);
});

test('finds nested monorepo roots and does not detect typescript from package.json alone', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'multi-repo'));
  assert.ok(roots.typescript.includes('packages/api'));
  assert.ok(roots.python.includes('services/worker'));
  assert.equal(roots.rust.length, 0);
});

test('reports nothing for a repo with no recognized markers', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'empty-repo'));
  assert.deepEqual(roots, { typescript: [], python: [], rust: [], java: [] });
});

// Topmost marker wins: a workspace/project root is ONE index root; a nested
// marker inside an already-claimed subtree is not a second one. See
// detect.mjs's module doc for the full rule.

test('a Cargo workspace root with nested member crates is exactly one rust root', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'cargo-workspace-repo'));
  assert.deepEqual(roots.rust, ['.']);
});

test('nested crates with no workspace root collapse to the topmost Cargo.toml only', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'nested-crates-no-workspace-repo'));
  assert.deepEqual(roots.rust, ['crates/foo']);
});

test('a pnpm-workspace root with nested member tsconfigs is exactly one typescript root', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'pnpm-monorepo-repo'));
  assert.deepEqual(roots.typescript, ['.']);
});

// A root tsconfig.json is sufficient on its own -- no sibling package.json
// required.

test('a root tsconfig.json alone (no package.json) is a typescript root', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'ts-tsconfig-only-repo'));
  assert.deepEqual(roots.typescript, ['.']);
});

test('an explicit .rci-index.yml override still wins over topmost-marker-wins auto-detection', async () => {
  const repoRoot = path.join(FIXTURES, 'cargo-workspace-override-repo');
  const detected = await detectRoots(repoRoot);
  assert.deepEqual(detected.rust, ['.']);

  const fromConfig = await loadRciIndexConfig(repoRoot);
  const merged = mergeRoots(detected, fromConfig);
  assert.deepEqual(merged.rust, ['crates/a', 'crates/b']);
});

test('loadRciIndexConfig returns null when no .rci-index.yml exists', async () => {
  const config = await loadRciIndexConfig(path.join(FIXTURES, 'ts-repo'));
  assert.equal(config, null);
});

test('.rci-index.yml overrides auto-detected roots for the languages it declares', async () => {
  const repoRoot = path.join(FIXTURES, 'multi-repo');
  const detected = await detectRoots(repoRoot);
  const fromConfig = await loadRciIndexConfig(repoRoot);
  const merged = mergeRoots(detected, fromConfig);
  assert.deepEqual(merged.typescript, ['packages/api']);
  assert.deepEqual(merged.python, ['services/worker']);
  assert.deepEqual(merged.rust, []);
});

test('mergeRoots: an override key with an empty array explicitly skips that language', () => {
  const merged = mergeRoots({ typescript: ['.'], python: [], rust: [] }, { typescript: [] });
  assert.deepEqual(merged.typescript, []);
});

test('mergeRoots: a language absent from the override keeps its base roots', () => {
  const merged = mergeRoots({ typescript: ['.'], python: ['svc'], rust: [] }, { typescript: ['override'] });
  assert.deepEqual(merged.python, ['svc']);
});

test('mergeRoots: a null override is a no-op', () => {
  const base = { typescript: ['.'], python: [], rust: [] };
  assert.deepEqual(mergeRoots(base, null), base);
});

// Content validation: a marker FILE present is not by itself a project
// marker for pyproject.toml / Cargo.toml; the file must declare a project table.

test('a tool-config-only pyproject.toml (no [project]/[build-system]) is not a python root', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'py-tool-config-only-repo'));
  assert.deepEqual(roots.python, []);
});

test('a pyproject.toml with a [project] table is a python root', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'py-repo'));
  assert.deepEqual(roots.python, ['.']);
});

test('a Cargo.toml with neither [package] nor [workspace] (only a dotted child table) is not a rust root', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'cargo-tool-config-only-repo'));
  assert.deepEqual(roots.rust, []);
});

test('a [workspace]-only Cargo.toml is a rust root', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'cargo-workspace-repo'));
  assert.deepEqual(roots.rust, ['.']);
});

test('a nested member crate under a workspace root stays collapsed to the topmost root', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'cargo-workspace-repo'));
  assert.equal(roots.rust.length, 1);
  assert.deepEqual(roots.rust, ['.']);
});

// A nested Cargo.toml that is ITSELF a
// `[workspace]` is a distinct root, not a suppressed member: `cargo
// metadata` refuses to resolve a member crate that "believes it's in a
// workspace when it's not" unless the nested Cargo.toml declares its own
// `[workspace]` (see detect.mjs's module doc, "RUST'S ONE EXCEPTION").

test('a nested Cargo.toml that declares its own [workspace] is a distinct rust root, not a suppressed member', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'cargo-nested-workspace-repo'));
  assert.equal(roots.rust.length, 2);
  assert.deepEqual(roots.rust.slice().sort(), ['.', 'tools/nested-ws']);
});
