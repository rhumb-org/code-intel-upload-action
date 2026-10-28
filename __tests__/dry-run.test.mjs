import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION_ROOT = path.resolve(__dirname, '..');
const RUN_SCRIPT = path.join(ACTION_ROOT, 'scripts', 'run.mjs');
const TS_FIXTURE = path.join(__dirname, 'fixtures', 'ts-repo');
const MULTI_FIXTURE = path.join(__dirname, 'fixtures', 'multi-repo');
const EMPTY_FIXTURE = path.join(__dirname, 'fixtures', 'empty-repo');
const NAMED_PROJECT_FIXTURE = path.join(__dirname, 'fixtures', 'ts-named-project-repo');
const BAD_CONFIG_FIXTURE = path.join(__dirname, 'fixtures', 'bad-config-repo');

function baseEnv(overrides) {
  return {
    ...process.env,
    RCI_DRY_RUN: 'true',
    RCI_BASE_URL: 'https://rhumb.sh',
    RCI_ROOTS_OVERRIDE: '',
    // Deliberately unset -- a dry run must never attempt to mint a token,
    // so their absence must never surface as an error.
    ACTIONS_ID_TOKEN_REQUEST_URL: '',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
    ...overrides,
  };
}

test('dry-run detects a single-language repo and prints the request sequence, with no network calls', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: baseEnv({ GITHUB_WORKSPACE: TS_FIXTURE }),
    timeout: 15_000,
  });

  assert.match(stdout, /dry run/);
  assert.match(stdout, /typescript @ \./);
  assert.match(stdout, /POST https:\/\/rhumb\.sh\/api\/code-intel\/v1\/uploads/);
  assert.match(stdout, /POST https:\/\/rhumb\.sh\/api\/code-intel\/v1\/uploads\/\{id\}\/complete/);
  assert.doesNotMatch(stdout, /ECONNREFUSED|ENOTFOUND|fetch failed/);
});

test('dry-run with no indexable language prints that explicitly', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: baseEnv({ GITHUB_WORKSPACE: EMPTY_FIXTURE }),
    timeout: 15_000,
  });
  assert.match(stdout, /no indexable language detected/);
});

test('dry-run honors .rci-index.yml roots for a monorepo', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: baseEnv({ GITHUB_WORKSPACE: MULTI_FIXTURE }),
    timeout: 15_000,
  });
  assert.match(stdout, /typescript @ packages\/api/);
  assert.match(stdout, /python @ services\/worker/);
});

test('dry-run shows the project file a .rci-index.yml root names', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: baseEnv({ GITHUB_WORKSPACE: NAMED_PROJECT_FIXTURE }),
    timeout: 15_000,
  });
  assert.match(stdout, /typescript @ \. \(project tsconfig\.graph\.json\)/);
});

test('dry-run makes one POST per language that names every root of it', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: baseEnv({
      GITHUB_WORKSPACE: EMPTY_FIXTURE,
      RCI_ROOTS_OVERRIDE: JSON.stringify({ typescript: ['packages/api', { path: 'packages/web', project: 'tsconfig.app.json' }], python: ['svc'] }),
    }),
    timeout: 15_000,
  });
  assert.match(stdout, /## typescript @ packages\/api, packages\/web \(project tsconfig\.app\.json\)/);
  assert.match(stdout, /"lang":"typescript","roots":\["packages\/api","packages\/web"\]/);
  // Without GITHUB_STEP_SUMMARY the summary is echoed to stdout a second time.
  const posts = new Set(stdout.split('\n').filter((line) => /^POST .*"lang"/.test(line)));
  assert.equal(posts.size, 2, 'one create per language');
  assert.match(stdout, /one repo-relative index for all typescript roots/);
});

test('dry-run accepts the object form in the roots-override input too', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: baseEnv({
      GITHUB_WORKSPACE: EMPTY_FIXTURE,
      RCI_ROOTS_OVERRIDE: JSON.stringify({ typescript: [{ path: '.', project: 'tsconfig.graph.json' }] }),
    }),
    timeout: 15_000,
  });
  assert.match(stdout, /typescript @ \. \(project tsconfig\.graph\.json\)/);
});

test('an unexpected summary write failure exits 0 by default and non-zero with fail-on-error', async () => {
  const env = { GITHUB_WORKSPACE: TS_FIXTURE, GITHUB_STEP_SUMMARY: TS_FIXTURE };
  const { stderr } = await execFileP('node', [RUN_SCRIPT], {
    env: baseEnv({ ...env, RCI_FAIL_ON_ERROR: 'false' }),
    timeout: 15_000,
  });
  assert.match(stderr, /unexpected failure/);
  await assert.rejects(
    execFileP('node', [RUN_SCRIPT], { env: baseEnv({ ...env, RCI_FAIL_ON_ERROR: 'true' }), timeout: 15_000 }),
    (err) => err.code === 1 && /unexpected failure/.test(err.stderr),
  );
});

test('an unresolvable config exits 0 by default (fail-soft) and non-zero with fail-on-error', async () => {
  const env = { GITHUB_WORKSPACE: BAD_CONFIG_FIXTURE, RCI_DRY_RUN: 'false' };

  await execFileP('node', [RUN_SCRIPT], { env: baseEnv(env), timeout: 15_000 });

  await assert.rejects(
    execFileP('node', [RUN_SCRIPT], { env: baseEnv({ ...env, RCI_FAIL_ON_ERROR: 'true' }), timeout: 15_000 }),
    (err) => err.code === 1,
  );
});

test('dry-run lists the status poll only when verify-timeout is set, and still makes no network calls', async () => {
  const off = await execFileP('node', [RUN_SCRIPT], { env: baseEnv({ GITHUB_WORKSPACE: TS_FIXTURE }), timeout: 15_000 });
  assert.doesNotMatch(off.stdout, /GET /);

  const on = await execFileP('node', [RUN_SCRIPT], {
    env: baseEnv({ GITHUB_WORKSPACE: TS_FIXTURE, RCI_VERIFY_TIMEOUT: '300' }),
    timeout: 15_000,
  });
  assert.match(on.stdout, /GET  https:\/\/rhumb\.sh\/api\/code-intel\/v1\/uploads\/\{id\}.*300 s/);
  assert.doesNotMatch(on.stdout, /ECONNREFUSED|ENOTFOUND|fetch failed/);
});
