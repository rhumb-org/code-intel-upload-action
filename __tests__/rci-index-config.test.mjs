import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRciIndexYaml, normalizeRootEntry } from '../scripts/rci-index-config.mjs';

test('parses a well-formed multi-language roots block', () => {
  const yaml = 'roots:\n  typescript:\n    - packages/api\n    - packages/web\n  rust:\n    - crates/core\n';
  assert.deepEqual(parseRciIndexYaml(yaml), {
    typescript: ['packages/api', 'packages/web'],
    rust: ['crates/core'],
  });
});

test('ignores comments and blank lines', () => {
  const yaml = '# comment\nroots:\n  python: # inline comment\n    - services/worker\n\n';
  assert.deepEqual(parseRciIndexYaml(yaml), { python: ['services/worker'] });
});

test('parses inline empty language lists without consuming the following language', () => {
  for (const empty of ['[]', ' []', ' [ ]']) {
    assert.deepEqual(parseRciIndexYaml(`roots:\n  rust:${empty}\n  python:\n    - services/worker\n`), {
      rust: [],
      python: ['services/worker'],
    });
  }
  assert.throws(() => parseRciIndexYaml('roots:\n  rust: []\n    - crates/core\n'), /unexpected indentation/);
  assert.throws(() => parseRciIndexYaml('roots:\n  rust: [crates/core]\n'), /expected "<language>:"/);
});

test('rejects an unsupported top-level key', () => {
  assert.throws(() => parseRciIndexYaml('other:\n  - x\n'), /unsupported top-level key/);
});

test('rejects an unsupported language', () => {
  assert.throws(() => parseRciIndexYaml('roots:\n  go:\n    - x\n'), /unsupported language/);
});

test('rejects a malformed language line', () => {
  assert.throws(() => parseRciIndexYaml('roots:\n  typescript\n'), /expected "<language>:"/);
});

test('rejects a malformed list item', () => {
  assert.throws(() => parseRciIndexYaml('roots:\n  typescript:\n    packages/api\n'), /expected "- <path>"/);
});

test('parses a root that names its project file, alongside bare-path roots', () => {
  const yaml = [
    'roots:',
    '  typescript:',
    '    - path: .',
    '      project: tsconfig.graph.json',
    '    - packages/api',
    '  python:',
    '    - services/worker',
    '',
  ].join('\n');
  assert.deepEqual(parseRciIndexYaml(yaml), {
    typescript: [{ path: '.', project: 'tsconfig.graph.json' }, 'packages/api'],
    python: ['services/worker'],
  });
});

test('a "path:" entry without a project parses as an object that normalizes like a bare path', () => {
  const parsed = parseRciIndexYaml('roots:\n  typescript:\n    - path: packages/api\n');
  assert.deepEqual(parsed, { typescript: [{ path: 'packages/api' }] });
  assert.deepEqual(normalizeRootEntry(parsed.typescript[0], 'typescript', 'test'), { root: 'packages/api', project: undefined });
});

test('rejects a project key that is not attached to a path entry or is repeated', () => {
  assert.throws(
    () => parseRciIndexYaml('roots:\n  typescript:\n    - packages/api\n      project: tsconfig.graph.json\n'),
    /unexpected indentation/,
  );
  assert.throws(
    () => parseRciIndexYaml('roots:\n  typescript:\n    - path: .\n      project: a.json\n      project: b.json\n'),
    /single "project: <file>"/,
  );
  assert.throws(
    () => parseRciIndexYaml('roots:\n  typescript:\n    - path: .\n      other: x\n'),
    /single "project: <file>"/,
  );
});

test('rejects a project file for a language whose indexer takes none', () => {
  assert.throws(
    () => parseRciIndexYaml('roots:\n  python:\n    - path: services/worker\n      project: pyproject.toml\n'),
    /only supported for typescript/,
  );
});

test('rejects a project file that is absolute or escapes its root', () => {
  for (const project of ['/etc/tsconfig.json', '../tsconfig.json', 'a/../../tsconfig.json']) {
    assert.throws(
      () => parseRciIndexYaml(`roots:\n  typescript:\n    - path: .\n      project: ${project}\n`),
      /must be a path inside the root/,
      project,
    );
  }
});

test('normalizeRootEntry: bare string, object form, and roots-override JSON shapes', () => {
  assert.deepEqual(normalizeRootEntry('packages/api', 'typescript', 'test'), { root: 'packages/api', project: undefined });
  assert.deepEqual(normalizeRootEntry({ path: '.', project: './tsconfig.graph.json' }, 'typescript', 'test'), {
    root: '.',
    project: 'tsconfig.graph.json',
  });
  assert.throws(() => normalizeRootEntry({ project: 'x.json' }, 'typescript', 'test'), /object with a "path" string/);
  assert.throws(() => normalizeRootEntry(42, 'typescript', 'test'), /path string or an object/);
  assert.throws(() => normalizeRootEntry({ path: '.', projct: 'x.json' }, 'typescript', 'test'), /unsupported key "projct"/);
  assert.throws(() => normalizeRootEntry({ path: '.', project: '' }, 'typescript', 'test'), /non-empty string/);
});
