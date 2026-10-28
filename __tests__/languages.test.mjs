import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LANGUAGES, KNOWN_LANGUAGES, BUILD_RUNNING_LANGUAGES, languageDef } from '../scripts/languages.mjs';
import { detectRoots, withholdBuildRoots } from '../scripts/detect.mjs';
import { parseRciIndexYaml } from '../scripts/rci-index-config.mjs';
import { loadIndexerPins } from '../scripts/pins.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const RUN_SCRIPT = path.join(__dirname, '..', 'scripts', 'run.mjs');

const JAVA_NOTICE = 'Java indexing runs your Maven or Gradle build; declare its roots in .rci-index.yml to enable it.';

test('every language has a complete table row', async () => {
  assert.deepEqual(KNOWN_LANGUAGES, ['typescript', 'python', 'rust', 'java']);
  const pins = await loadIndexerPins();
  for (const lang of KNOWN_LANGUAGES) {
    const def = LANGUAGES[lang];
    assert.equal(typeof def.indexerName, 'string', lang);
    assert.match(def.indexerVersion(pins), /^\S+$/, `${lang} has a pinned version`);
    assert.equal(typeof def.binKey, 'string', lang);
    assert.equal(typeof def.install, 'function', lang);
    assert.ok(def.markers.length > 0 && def.markers.every((group) => group.length > 0), `${lang} markers`);
    assert.equal(typeof def.runsBuild, 'boolean', lang);
    assert.equal(typeof def.acceptsProject, 'boolean', lang);
    assert.equal(typeof def.nodeIndexer, 'boolean', lang);
    const { args } = def.command({ absoluteRoot: '/repo', output: '/out/index.scip' });
    assert.ok(args.includes('/out/index.scip'), `${lang} command writes to the given output`);
    if (def.runsBuild) assert.ok(def.optInNotice.length > 0, `${lang} explains its opt-in`);
  }
});

test('bin keys are distinct, so the installed indexers never overwrite one another', () => {
  const keys = KNOWN_LANGUAGES.map((lang) => LANGUAGES[lang].binKey);
  assert.equal(new Set(keys).size, keys.length);
});

test('java is the build-running language; the others are not', () => {
  assert.deepEqual(BUILD_RUNNING_LANGUAGES, ['java']);
  assert.equal(LANGUAGES.java.optInNotice, JAVA_NOTICE);
});

test('languageDef rejects an unknown language, including inherited object keys', () => {
  assert.throws(() => languageDef('go'), /unknown language "go"/);
  assert.throws(() => languageDef('constructor'), /unknown language/);
});

test('.rci-index.yml accepts java roots, and the unsupported-language error lists it', () => {
  assert.deepEqual(parseRciIndexYaml('roots:\n  java:\n    - services/billing\n'), { java: ['services/billing'] });
  assert.throws(() => parseRciIndexYaml('roots:\n  go:\n    - x\n'), /expected one of typescript, python, rust, java/);
  assert.throws(() => parseRciIndexYaml('roots:\n  java:\n    - path: .\n      project: pom.xml\n'), /"project" is only supported for typescript/);
});

test('detect: a Maven multi-module build is one java root (topmost marker wins)', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'java-maven-repo'));
  assert.deepEqual(roots.java, ['.']);
});

test('detect: a Gradle multi-project build is one java root (topmost marker wins)', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'java-gradle-repo'));
  assert.deepEqual(roots.java, ['.']);
});

test('detect: every java marker file makes a java root', async () => {
  for (const marker of ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-java-marker-'));
    try {
      await writeFile(path.join(dir, marker), '');
      assert.deepEqual((await detectRoots(dir)).java, ['.'], marker);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('withholdBuildRoots removes detected java roots from the indexable set and reports them', () => {
  const { roots, withheld } = withholdBuildRoots({ typescript: ['.'], python: [], rust: [], java: ['svc'] });
  assert.deepEqual(roots, { typescript: ['.'], python: [], rust: [], java: [] });
  assert.deepEqual(withheld, { java: ['svc'] });
  assert.deepEqual(withholdBuildRoots({ typescript: [], python: [], rust: [], java: [] }).withheld, {});
});

function runEnv(overrides) {
  return {
    ...process.env,
    RCI_BASE_URL: 'https://rhumb.sh',
    RCI_ROOTS_OVERRIDE: '',
    RCI_FAIL_ON_ERROR: 'false',
    ACTIONS_ID_TOKEN_REQUEST_URL: '',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
    ...overrides,
  };
}

test('dry-run: undeclared java roots are SKIPPED with the reason and get no request sequence', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({ RCI_DRY_RUN: 'true', GITHUB_WORKSPACE: path.join(FIXTURES, 'java-maven-repo') }),
    timeout: 15_000,
  });
  assert.match(stdout, new RegExp(`SKIPPED  java @ \\.: ${JAVA_NOTICE.replace(/[.]/g, '\\.')}`));
  assert.doesNotMatch(stdout, /## java @/);
  assert.match(stdout, /no indexable language detected/);
});

test('dry-run: java roots declared in .rci-index.yml are listed with their request sequence', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({ RCI_DRY_RUN: 'true', GITHUB_WORKSPACE: path.join(FIXTURES, 'java-declared-repo') }),
    timeout: 15_000,
  });
  assert.match(stdout, /## java @ \./);
  assert.match(stdout, /"lang":"java","roots":\["\."\]/);
  assert.doesNotMatch(stdout, /SKIPPED/);
});

test('dry-run: roots-override declares java roots too, and an explicit empty list is a decision with no notice', async () => {
  const declared = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({
      RCI_DRY_RUN: 'true',
      GITHUB_WORKSPACE: path.join(FIXTURES, 'java-maven-repo'),
      RCI_ROOTS_OVERRIDE: JSON.stringify({ java: ['.'] }),
    }),
    timeout: 15_000,
  });
  assert.match(declared.stdout, /## java @ \./);
  assert.doesNotMatch(declared.stdout, /SKIPPED/);

  const optedOut = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({
      RCI_DRY_RUN: 'true',
      GITHUB_WORKSPACE: path.join(FIXTURES, 'java-maven-repo'),
      RCI_ROOTS_OVERRIDE: JSON.stringify({ java: [] }),
    }),
    timeout: 15_000,
  });
  assert.doesNotMatch(optedOut.stdout, /SKIPPED|## java @/);
});

test('a real run over an undeclared java repo records SKIPPED in the step summary, starts no build and makes no network call', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-summary-'));
  try {
    const summaryFile = path.join(dir, 'summary.md');
    // No OIDC variables and no pins loaded: any door call or install would fail
    // loudly (the run is fail-soft, so the summary is what proves it did neither).
    await execFileP('node', [RUN_SCRIPT], {
      env: runEnv({
        RCI_DRY_RUN: 'false',
        GITHUB_WORKSPACE: path.join(FIXTURES, 'java-gradle-repo'),
        GITHUB_STEP_SUMMARY: summaryFile,
      }),
      timeout: 15_000,
    });
    const summary = await readFile(summaryFile, 'utf8');
    assert.match(summary, new RegExp(`SKIPPED  java @ \\.: ${JAVA_NOTICE.replace(/[.]/g, '\\.')}`));
    assert.doesNotMatch(summary, /FAILED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
