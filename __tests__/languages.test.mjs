import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const CSHARP_NOTICE = 'C# indexing runs your MSBuild restore and project load; declare its roots in .rci-index.yml to enable it.';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('every language has a complete table row', async () => {
  assert.deepEqual(KNOWN_LANGUAGES, ['typescript', 'python', 'rust', 'java', 'csharp', 'cpp']);
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

test('java, csharp and cpp are the build-running languages; the others are not', () => {
  assert.deepEqual(BUILD_RUNNING_LANGUAGES, ['java', 'csharp', 'cpp']);
  assert.equal(LANGUAGES.java.optInNotice, JAVA_NOTICE);
  assert.equal(LANGUAGES.csharp.optInNotice, CSHARP_NOTICE);
});

test('the csharp row indexes with scip-dotnet at the pinned version, restoring first and never twice', async () => {
  const def = languageDef('csharp');
  const pins = await loadIndexerPins();
  assert.equal(def.indexerName, 'scip-dotnet');
  assert.equal(def.indexerVersion(pins), pins['scip-dotnet'].version);
  assert.deepEqual(def.markers, [['*.sln'], ['*.slnx'], ['*.csproj']]);

  const root = path.join(FIXTURES, 'csharp-sln-repo');
  const sln = path.join(root, 'Fixture.sln');
  assert.deepEqual(def.prepare({ absoluteRoot: root }), [
    {
      file: 'dotnet',
      args: ['restore', sln],
      cwd: root,
      env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
      maxBuffer: 256 * 1024 * 1024,
    },
  ]);
  assert.deepEqual(def.command({ absoluteRoot: root, output: '/out/index.scip' }), {
    args: ['index', '--output', '/out/index.scip', '--working-directory', root, '--skip-dotnet-restore', sln],
    cwd: root,
    env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_ROLL_FORWARD: 'Major' },
    maxBuffer: 256 * 1024 * 1024,
  });
});

test('the csharp row restores and indexes every solution in a root, or else the root project', async () => {
  const def = languageDef('csharp');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-csharp-projects-'));
  try {
    await writeFile(path.join(dir, 'B.slnx'), '');
    await writeFile(path.join(dir, 'A.sln'), '');
    await writeFile(path.join(dir, 'Other.csproj'), '');
    assert.deepEqual(def.prepare({ absoluteRoot: dir }).map((step) => step.args[1]), [path.join(dir, 'A.sln'), path.join(dir, 'B.slnx')]);
    assert.deepEqual(def.command({ absoluteRoot: dir, output: '/o' }).args.slice(-2), [path.join(dir, 'A.sln'), path.join(dir, 'B.slnx')]);

    await rm(path.join(dir, 'A.sln'));
    await rm(path.join(dir, 'B.slnx'));
    assert.deepEqual(def.prepare({ absoluteRoot: dir }).map((step) => step.args[1]), [path.join(dir, 'Other.csproj')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('languageDef rejects an unknown language, including inherited object keys', () => {
  assert.throws(() => languageDef('go'), /unknown language "go"/);
  assert.throws(() => languageDef('constructor'), /unknown language/);
});

test('.rci-index.yml accepts java roots, and the unsupported-language error lists it', () => {
  assert.deepEqual(parseRciIndexYaml('roots:\n  java:\n    - services/billing\n'), { java: ['services/billing'] });
  assert.throws(() => parseRciIndexYaml('roots:\n  go:\n    - x\n'), /expected one of typescript, python, rust, java, csharp/);
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

test('.rci-index.yml accepts csharp roots, and a project file is not accepted for them', () => {
  assert.deepEqual(parseRciIndexYaml('roots:\n  csharp:\n    - services/billing\n'), { csharp: ['services/billing'] });
  assert.throws(() => parseRciIndexYaml('roots:\n  csharp:\n    - path: .\n      project: App.sln\n'), /"project" is only supported for typescript/);
});

test('detect: a solution with its projects below it is one csharp root (topmost marker wins)', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'csharp-sln-repo'));
  assert.deepEqual(roots.csharp, ['.']);
});

test('detect: .sln, .slnx and .csproj files each make a csharp root, whatever the extension case', async () => {
  for (const marker of ['App.sln', 'App.slnx', 'App.csproj', 'APP.SLN']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-csharp-marker-'));
    try {
      await writeFile(path.join(dir, marker), '');
      assert.deepEqual((await detectRoots(dir)).csharp, ['.'], marker);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('detect: other C# and Visual Studio files, and a directory named like a project, are not csharp roots', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-csharp-nomarker-'));
  try {
    await writeFile(path.join(dir, 'Program.cs'), '');
    await writeFile(path.join(dir, 'Lib.vbproj'), '');
    await mkdir(path.join(dir, 'Fake.csproj'));
    assert.deepEqual((await detectRoots(dir)).csharp, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detect: separate csharp projects with no solution above them are separate roots', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-csharp-siblings-'));
  try {
    for (const sub of ['svc-a', 'svc-b']) {
      await mkdir(path.join(dir, sub));
      await writeFile(path.join(dir, sub, `${sub}.csproj`), '');
    }
    assert.deepEqual((await detectRoots(dir)).csharp.sort(), ['svc-a', 'svc-b']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('withholdBuildRoots removes detected csharp roots from the indexable set and reports them', () => {
  const { roots, withheld } = withholdBuildRoots({ typescript: [], python: [], rust: [], java: [], csharp: ['src'] });
  assert.deepEqual(roots.csharp, []);
  assert.deepEqual(withheld, { csharp: ['src'] });
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

test('dry-run: undeclared csharp roots are SKIPPED with the reason and get no request sequence', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({ RCI_DRY_RUN: 'true', GITHUB_WORKSPACE: path.join(FIXTURES, 'csharp-sln-repo') }),
    timeout: 15_000,
  });
  assert.match(stdout, new RegExp(`SKIPPED  csharp @ \\.: ${escapeRegExp(CSHARP_NOTICE)}`));
  assert.doesNotMatch(stdout, /## csharp @/);
  assert.match(stdout, /no indexable language detected/);
});

test('dry-run: csharp roots declared in .rci-index.yml are listed with their request sequence', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({ RCI_DRY_RUN: 'true', GITHUB_WORKSPACE: path.join(FIXTURES, 'csharp-declared-repo') }),
    timeout: 15_000,
  });
  assert.match(stdout, /## csharp @ \./);
  assert.match(stdout, /"lang":"csharp","roots":\["\."\]/);
  assert.match(stdout, /<gzip'd index\.scip: one repo-relative index for all csharp roots>/);
  assert.doesNotMatch(stdout, /SKIPPED/);
});

test('dry-run: roots-override declares csharp roots too, and an explicit empty list is a decision with no notice', async () => {
  const declared = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({
      RCI_DRY_RUN: 'true',
      GITHUB_WORKSPACE: path.join(FIXTURES, 'csharp-sln-repo'),
      RCI_ROOTS_OVERRIDE: JSON.stringify({ csharp: ['.'] }),
    }),
    timeout: 15_000,
  });
  assert.match(declared.stdout, /## csharp @ \./);
  assert.doesNotMatch(declared.stdout, /SKIPPED/);

  const optedOut = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({
      RCI_DRY_RUN: 'true',
      GITHUB_WORKSPACE: path.join(FIXTURES, 'csharp-sln-repo'),
      RCI_ROOTS_OVERRIDE: JSON.stringify({ csharp: [] }),
    }),
    timeout: 15_000,
  });
  assert.doesNotMatch(optedOut.stdout, /SKIPPED|## csharp @/);
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

test('a real run over an undeclared csharp repo records SKIPPED in the step summary, starts no restore and makes no network call', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-summary-'));
  try {
    const summaryFile = path.join(dir, 'summary.md');
    await execFileP('node', [RUN_SCRIPT], {
      env: runEnv({
        RCI_DRY_RUN: 'false',
        GITHUB_WORKSPACE: path.join(FIXTURES, 'csharp-sln-repo'),
        GITHUB_STEP_SUMMARY: summaryFile,
      }),
      timeout: 15_000,
    });
    const summary = await readFile(summaryFile, 'utf8');
    assert.match(summary, new RegExp(`SKIPPED  csharp @ \\.: ${escapeRegExp(CSHARP_NOTICE)}`));
    assert.doesNotMatch(summary, /FAILED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
