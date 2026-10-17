/**
 * rci-index-config.mjs -- parses the checked-in `.rci-index.yml`, a
 * deliberately restrictive YAML subset (`roots: <lang>: - <entry>`) rather
 * than a general parser: the schema is three known keys, so a hand-rolled
 * parser needs no dependency to pin, hash, and verify the way the SCIP
 * indexers themselves do. A caller whose layout does not fit this subset
 * uses the action's `roots-override` JSON input instead.
 *
 * A root entry is either a bare directory path, or a `path:` key with an
 * optional `project:` key naming the TypeScript project file inside that
 * directory (scip-typescript's positional project argument). A repo whose
 * root project file is not named `tsconfig.json` -- e.g. a solution-style
 * `tsconfig.graph.json` -- can only be indexed by naming it; a directory
 * alone makes scip-typescript look for `<dir>/tsconfig.json`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const KNOWN_LANGUAGES = ['typescript', 'python', 'rust'];

/** Only scip-typescript takes a project-file argument; python and rust
 *  indexers resolve their project from the root directory alone. */
const LANGUAGES_WITH_PROJECT_FILE = ['typescript'];

/**
 * Normalizes one root entry -- a bare path string or `{path, project?}`,
 * from `.rci-index.yml` or the `roots-override` JSON -- to
 * `{root, project}` (`project` is `undefined` when not named). Throws on a
 * malformed entry, or on a `project` that is absolute, escapes the root, or
 * is named for a language that takes none.
 */
export function normalizeRootEntry(entry, lang, sourceLabel) {
  if (typeof entry === 'string') return { root: entry, project: undefined };
  if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || entry.path.length === 0) {
    throw new Error(`${sourceLabel}: a "${lang}" root must be a path string or an object with a "path" string`);
  }
  const unknownKeys = Object.keys(entry).filter((key) => key !== 'path' && key !== 'project');
  if (unknownKeys.length > 0) {
    throw new Error(`${sourceLabel}: unsupported key "${unknownKeys[0]}" on "${lang}" root "${entry.path}" (expected "path", "project")`);
  }
  if (entry.project === undefined) return { root: entry.path, project: undefined };
  if (typeof entry.project !== 'string' || entry.project.length === 0) {
    throw new Error(`${sourceLabel}: "project" on "${lang}" root "${entry.path}" must be a non-empty string`);
  }
  if (!LANGUAGES_WITH_PROJECT_FILE.includes(lang)) {
    throw new Error(`${sourceLabel}: "project" is only supported for ${LANGUAGES_WITH_PROJECT_FILE.join(', ')} roots, not "${lang}" root "${entry.path}"`);
  }
  const normalized = path.posix.normalize(entry.project);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${sourceLabel}: "project" on "${lang}" root "${entry.path}" must be a path inside the root, got "${entry.project}"`);
  }
  return { root: entry.path, project: normalized };
}

/**
 * Parses the supported subset:
 *   roots:
 *     typescript:
 *       - packages/api
 *     python:
 *       - services/worker
 * and, for a root that names its project file:
 *     typescript:
 *       - path: .
 *         project: tsconfig.graph.json
 * Entries come back as a bare string, or `{path, project}` for the object
 * form. Comments (`# ...`) and blank lines are stripped first. Anything
 * outside this shape (nonempty flow lists, anchors, multi-doc, tabs) throws
 * with the offending line, rather than silently mis-parsing it.
 */
export function parseRciIndexYaml(raw) {
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);

  const roots = {};
  let state = 'top';
  let currentLang;
  let currentObjectEntry;

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      if (trimmed !== 'roots:') {
        throw new Error(`.rci-index.yml: unsupported top-level key "${trimmed}" (only "roots:" is supported)`);
      }
      state = 'in_roots';
      continue;
    }

    if (indent === 2 && (state === 'in_roots' || state === 'in_lang')) {
      const match = /^([a-z]+):(?:\s*(\[\s*\]))?$/.exec(trimmed);
      if (match === null) {
        throw new Error(`.rci-index.yml: expected "<language>:" at indent 2, got "${trimmed}"`);
      }
      const lang = match[1];
      if (!KNOWN_LANGUAGES.includes(lang)) {
        throw new Error(`.rci-index.yml: unsupported language "${lang}" (expected one of ${KNOWN_LANGUAGES.join(', ')})`);
      }
      currentLang = lang;
      currentObjectEntry = undefined;
      roots[lang] = [];
      state = match[2] === undefined ? 'in_lang' : 'in_roots';
      continue;
    }

    if (indent === 4 && state === 'in_lang') {
      const match = /^-\s+(.+)$/.exec(trimmed);
      if (match === null) {
        throw new Error(`.rci-index.yml: expected "- <path>" at indent 4, got "${trimmed}"`);
      }
      const objectStart = /^path:\s*(.+)$/.exec(match[1].trim());
      if (objectStart === null) {
        currentObjectEntry = undefined;
        roots[currentLang].push(match[1].trim());
      } else {
        currentObjectEntry = { path: objectStart[1].trim() };
        roots[currentLang].push(currentObjectEntry);
      }
      continue;
    }

    if (indent === 6 && state === 'in_lang' && currentObjectEntry !== undefined) {
      const match = /^project:\s*(.+)$/.exec(trimmed);
      if (match === null || currentObjectEntry.project !== undefined) {
        throw new Error(`.rci-index.yml: expected a single "project: <file>" under "path: ${currentObjectEntry.path}", got "${trimmed}"`);
      }
      currentObjectEntry.project = match[1].trim();
      continue;
    }

    throw new Error(`.rci-index.yml: unexpected indentation for line "${trimmed}"`);
  }

  for (const [lang, entries] of Object.entries(roots)) {
    for (const entry of entries) normalizeRootEntry(entry, lang, '.rci-index.yml');
  }
  return roots;
}

/** Returns `null` when no `.rci-index.yml` exists at `repoRoot` -- that is
 *  the ordinary case (auto-detection only), not an error. */
export async function loadRciIndexConfig(repoRoot) {
  let raw;
  try {
    raw = await readFile(path.join(repoRoot, '.rci-index.yml'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return parseRciIndexYaml(raw);
}
