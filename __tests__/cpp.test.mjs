import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LANGUAGES, BUILD_RUNNING_LANGUAGES } from '../scripts/languages.mjs';
import { detectRoots, withholdBuildRoots } from '../scripts/detect.mjs';
import { parseRciIndexYaml } from '../scripts/rci-index-config.mjs';
import { runIndexer, SCIP_OUTPUT_NAME } from '../scripts/index-lang.mjs';
import { installIndexerFor } from '../scripts/run.mjs';
import { loadIndexerPins } from '../scripts/pins.mjs';
import { INDEXER_TIMEOUT_MS } from '../scripts/timeouts.mjs';
import { sha256HexOfBuffer } from '../scripts/hash.mjs';
import { installScipClang, installCmake, detectScipClangPlatformKey, IndexerIntegrityError } from '../scripts/install.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const RUN_SCRIPT = path.join(__dirname, '..', 'scripts', 'run.mjs');

const CPP_NOTICE = 'C/C++ indexing runs your CMake configure and build; declare its roots in .rci-index.yml to enable it.';

async function inTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-cpp-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function touch(file) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '');
}

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

// --- root detection ---------------------------------------------------------

test('cpp is a build-running language whose opt-in notice names CMake', () => {
  assert.ok(BUILD_RUNNING_LANGUAGES.includes('cpp'));
  assert.equal(LANGUAGES.cpp.optInNotice, CPP_NOTICE);
});

test('detect: a CMake project with add_subdirectory members is one cpp root (topmost marker wins)', async () => {
  const roots = await detectRoots(path.join(FIXTURES, 'cpp-cmake-repo'));
  assert.deepEqual(roots.cpp, ['.']);
});

test('detect: nested CMakeLists.txt collapse into the topmost one, while sibling branches stay separate roots', async () => {
  await inTempDir(async (dir) => {
    await touch(path.join(dir, 'engine', 'CMakeLists.txt'));
    await touch(path.join(dir, 'engine', 'core', 'CMakeLists.txt'));
    await touch(path.join(dir, 'engine', 'core', 'util', 'CMakeLists.txt'));
    await touch(path.join(dir, 'tools', 'cli', 'CMakeLists.txt'));
    assert.deepEqual((await detectRoots(dir)).cpp, ['engine', 'tools/cli']);
  });
});

test('withholdBuildRoots withholds detected cpp roots without touching a language that does not run a build', () => {
  const { roots, withheld } = withholdBuildRoots({ typescript: ['.'], python: [], rust: [], java: [], cpp: ['native'] });
  assert.deepEqual(roots.cpp, []);
  assert.deepEqual(roots.typescript, ['.']);
  assert.deepEqual(withheld, { cpp: ['native'] });
});

test('.rci-index.yml accepts cpp roots, and a cpp root takes no project file', () => {
  assert.deepEqual(parseRciIndexYaml('roots:\n  cpp:\n    - native\n'), { cpp: ['native'] });
  assert.throws(() => parseRciIndexYaml('roots:\n  cpp:\n    - path: .\n      project: CMakeLists.txt\n'), /"project" is only supported for typescript/);
});

// --- opt-in, through the real entry point -----------------------------------

test('dry-run: an undeclared CMake project is SKIPPED with the reason and gets no request sequence', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({ RCI_DRY_RUN: 'true', GITHUB_WORKSPACE: path.join(FIXTURES, 'cpp-cmake-repo') }),
    timeout: 15_000,
  });
  assert.ok(stdout.includes(`SKIPPED  cpp @ .: ${CPP_NOTICE}`), stdout);
  assert.doesNotMatch(stdout, /## cpp @/);
  assert.match(stdout, /no indexable language detected/);
});

test('dry-run: a cpp root declared in .rci-index.yml lists the request sequence, with the index written outside the checkout', async () => {
  const { stdout } = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({ RCI_DRY_RUN: 'true', GITHUB_WORKSPACE: path.join(FIXTURES, 'cpp-declared-repo') }),
    timeout: 15_000,
  });
  assert.match(stdout, /## cpp @ \./);
  assert.match(stdout, /POST https:\/\/rhumb\.sh\/api\/code-intel\/v1\/uploads\s+\{"lang":"cpp","roots":\["\."\]\}/);
  assert.match(stdout, /PUT  <presigned put_url from create>\s+<gzip'd index\.scip: one repo-relative index for all cpp roots>/);
  assert.match(stdout, /uploads\/\{id\}\/complete/);
  assert.doesNotMatch(stdout, /SKIPPED/);
});

test('dry-run: roots-override declares cpp roots, and an explicit empty list is a decision with no notice', async () => {
  const workspace = path.join(FIXTURES, 'cpp-cmake-repo');
  const declared = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({ RCI_DRY_RUN: 'true', GITHUB_WORKSPACE: workspace, RCI_ROOTS_OVERRIDE: JSON.stringify({ cpp: ['.'] }) }),
    timeout: 15_000,
  });
  assert.match(declared.stdout, /## cpp @ \./);
  assert.doesNotMatch(declared.stdout, /SKIPPED/);

  const optedOut = await execFileP('node', [RUN_SCRIPT], {
    env: runEnv({ RCI_DRY_RUN: 'true', GITHUB_WORKSPACE: workspace, RCI_ROOTS_OVERRIDE: JSON.stringify({ cpp: [] }) }),
    timeout: 15_000,
  });
  assert.doesNotMatch(optedOut.stdout, /SKIPPED|## cpp @/);
});

test('a real run over an undeclared CMake project records SKIPPED, starts no build and makes no network call', async () => {
  await inTempDir(async (dir) => {
    const summaryFile = path.join(dir, 'summary.md');
    // No OIDC variables: a door call, an install or a build would all fail
    // loudly, so the clean summary proves the run did none of them.
    await execFileP('node', [RUN_SCRIPT], {
      env: runEnv({ RCI_DRY_RUN: 'false', GITHUB_WORKSPACE: path.join(FIXTURES, 'cpp-cmake-repo'), GITHUB_STEP_SUMMARY: summaryFile }),
      timeout: 15_000,
    });
    const summary = await readFile(summaryFile, 'utf8');
    assert.ok(summary.includes(`SKIPPED  cpp @ .: ${CPP_NOTICE}`), summary);
    assert.doesNotMatch(summary, /FAILED/);
  });
});

// --- the indexer run --------------------------------------------------------

const BINS = { cmake: '/tools/cmake', scipClang: '/tools/scip-clang' };

test('runIndexer cpp: configure, build, then scip-clang from the root, with the build tree and index outside the checkout', async () => {
  const root = path.join(FIXTURES, 'cpp-cmake-repo');
  const calls = [];
  const output = await runIndexer('cpp', root, BINS, {
    outputDir: '/scratch/pair',
    execFileImpl: async (bin, args, opts) => calls.push({ bin, args, opts }),
  });

  assert.equal(output, `/scratch/pair/${SCIP_OUTPUT_NAME}`);
  const buildDir = '/scratch/pair/cmake-build';
  assert.deepEqual(
    calls.map(({ bin, args }) => ({ bin, args })),
    [
      { bin: '/tools/cmake', args: ['-S', root, '-B', buildDir, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5'] },
      // An explicit job count: a bare -j is unbounded under make.
      { bin: '/tools/cmake', args: ['--build', buildDir, '-j', String(os.availableParallelism())] },
      {
        bin: '/tools/scip-clang',
        args: ['--compdb-path', `${buildDir}/compile_commands.json`, '--index-output-path', `/scratch/pair/${SCIP_OUTPUT_NAME}`, '--no-progress-report'],
      },
    ],
  );
  for (const { opts } of calls) {
    assert.equal(opts.cwd, root);
    assert.equal(opts.timeout, INDEXER_TIMEOUT_MS);
    assert.ok(opts.maxBuffer > 1024 * 1024, 'build output is not capped at the default 1 MiB');
    assert.equal(opts.env, undefined, 'not a Node process');
  }
});

test('runIndexer cpp: a failed configure ends the run before the build and the indexer, keeping the failure and bounding its output', async () => {
  const calls = [];
  const failure = Object.assign(new Error(`Command failed: /tools/cmake -S /repo\n${'noise\n'.repeat(5000)}CMake Error: no C++ compiler found`), {
    cmd: '/tools/cmake -S /repo',
    code: 1,
  });
  await assert.rejects(
    () =>
      runIndexer('cpp', path.join(FIXTURES, 'cpp-cmake-repo'), BINS, {
        outputDir: '/scratch/pair',
        execFileImpl: async (bin, args) => {
          calls.push(args[0]);
          throw failure;
        },
      }),
    (err) => err === failure && err.code === 1 && /^Command failed: \/tools\/cmake -S \/repo/.test(err.message) && /no C\+\+ compiler found$/.test(err.message) && err.message.length < 5000,
  );
  assert.equal(calls.length, 1);
});

test('runIndexer cpp: a declared root without CMakeLists.txt fails with that reason and starts nothing', async () => {
  let started = false;
  await assert.rejects(
    () =>
      runIndexer('cpp', path.join(FIXTURES, 'empty-repo'), BINS, {
        execFileImpl: async () => {
          started = true;
        },
      }),
    /^Error: C\/C\+\+ indexing needs a CMake project/,
  );
  assert.equal(started, false);
});

// --- installs ---------------------------------------------------------------

const SCIP_CLANG_URL = 'https://github.com/sourcegraph/scip-clang/releases/download/v0.4.0/scip-clang-x86_64-linux';

function clangPin(bytes) {
  return { version: '0.4.0', platforms: { 'x86_64-linux': { url: SCIP_CLANG_URL, sha256: sha256HexOfBuffer(bytes) } } };
}

function fetchOf(bytes) {
  return async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
}

test('installScipClang refuses a wrong sha256 before writing anything', async () => {
  await inTempDir(async (dir) => {
    const pin = clangPin(Buffer.from('the pinned bytes'));
    await assert.rejects(() => installScipClang(pin, dir, 'x86_64-linux', fetchOf(Buffer.from('other bytes'))), IndexerIntegrityError);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('installScipClang verifies the sha256, then writes the executable as-is', async () => {
  await inTempDir(async (dir) => {
    const bytes = Buffer.from('#!/usr/bin/env sh\necho scip-clang\n');
    const binPath = await installScipClang(clangPin(bytes), dir, 'x86_64-linux', fetchOf(bytes));
    assert.equal(binPath, path.join(dir, 'scip-clang'));
    assert.deepEqual(await readFile(binPath), bytes);
    const { stdout } = await execFileP(binPath, []);
    assert.equal(stdout, 'scip-clang\n', 'the written file is executable');
  });
});

test('installScipClang refuses a download URL outside scip-clang releases, before fetching', async () => {
  await inTempDir(async (dir) => {
    for (const url of [
      'https://example.test/scip-clang',
      'http://github.com/sourcegraph/scip-clang/releases/download/v0.4.0/scip-clang-x86_64-linux',
      'https://github.com/someone-else/scip-clang/releases/download/v0.4.0/scip-clang-x86_64-linux',
      'https://github.com.evil.test/sourcegraph/scip-clang/releases/download/v0.4.0/scip-clang-x86_64-linux',
      'https://github.com/scip-code/scip-java/releases/download/v0.13.1/scip-java-v0.13.1',
    ]) {
      await assert.rejects(
        () =>
          installScipClang({ version: '0.4.0', platforms: { 'x86_64-linux': { url, sha256: 'x' } } }, dir, 'x86_64-linux', async () => {
            assert.fail(`fetched ${url}`);
          }),
        /scip-clang pin url/,
        url,
      );
    }
  });
});

test('scip-clang supports Linux x64 only; any other platform fails with the reason, before any download', async () => {
  assert.equal(detectScipClangPlatformKey('linux', 'x64'), 'x86_64-linux');
  for (const [platform, arch] of [['linux', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
    assert.throws(() => detectScipClangPlatformKey(platform, arch), new RegExp(`unsupported platform for scip-clang: ${platform}-${arch}`));
  }
  await assert.rejects(() => installScipClang({ platforms: {} }, '/unused', 'aarch64-linux'), /no entry for platform/);
});

const CMAKE_URL = 'https://files.pythonhosted.org/packages/7e/d5/664ea06d01864f25d6067f09fa218404e4d588edd5e495135ac91429fecb/cmake-4.4.4-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl';
const CMAKE_SHA = 'f773a0544c66370408f451acd487c2c643b0dfebb48c5d64f3638bc1bb820238';
const CMAKE_PIN = { version: '4.4.4', platforms: { 'x86_64-linux': { url: CMAKE_URL, sha256: CMAKE_SHA } } };

test('installCmake installs the pinned wheel only under pip hash checking, and returns the real binary after checking its version', async () => {
  await inTempDir(async (dir) => {
    const calls = [];
    let requirementsText;
    const execFileImpl = async (bin, args) => {
      calls.push({ bin, args });
      if (bin === 'python3') requirementsText = await readFile(args[args.indexOf('-r') + 1], 'utf8');
      return { stdout: 'cmake version 4.4.4\n\nCMake suite maintained and supported by Kitware (kitware.com/cmake).\n' };
    };
    const binPath = await installCmake(CMAKE_PIN, dir, 'x86_64-linux', { execFileImpl });

    assert.equal(binPath, path.join(dir, 'cmake-wheel', 'cmake', 'data', 'bin', 'cmake'));
    assert.equal(requirementsText, `cmake @ ${CMAKE_URL} --hash=sha256:${CMAKE_SHA}\n`);
    assert.equal(calls[0].bin, 'python3');
    for (const flag of ['--require-hashes', '--only-binary=:all:', '--no-deps', '--target']) assert.ok(calls[0].args.includes(flag), flag);
    assert.deepEqual(calls[1], { bin: binPath, args: ['--version'] });
  });
});

test('installCmake rejects a binary that reports another version, a pin URL off the package file host, and a missing python', async () => {
  await inTempDir(async (dir) => {
    await assert.rejects(
      () => installCmake(CMAKE_PIN, dir, 'x86_64-linux', { execFileImpl: async () => ({ stdout: 'cmake version 3.28.3\n' }) }),
      /does not report version 4\.4\.4: cmake version 3\.28\.3/,
    );
    await assert.rejects(
      () => installCmake(CMAKE_PIN, dir, 'x86_64-linux', { execFileImpl: async () => ({ stdout: 'cmake version 4.4.40\n' }) }),
      /does not report version 4\.4\.4/,
    );
    for (const url of [
      'https://example.test/cmake.whl',
      'http://files.pythonhosted.org/packages/7e/cmake.whl',
      'https://files.pythonhosted.org.evil.test/packages/7e/cmake.whl',
      'https://github.com/Kitware/CMake/releases/download/v4.4.4/cmake.whl',
    ]) {
      await assert.rejects(
        () =>
          installCmake({ version: '4.4.4', platforms: { 'x86_64-linux': { url, sha256: CMAKE_SHA } } }, dir, 'x86_64-linux', {
            execFileImpl: async () => assert.fail(`ran pip for ${url}`),
          }),
        /cmake pin url/,
        url,
      );
    }
    await assert.rejects(
      () => installCmake(CMAKE_PIN, dir, 'x86_64-linux', { execFileImpl: async () => { throw Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }); } }),
      /needs python3 with pip/,
    );
    await assert.rejects(() => installCmake({ platforms: {} }, dir, 'aarch64-linux'), /no entry for platform/);
  });
});

test('the shipped scip-clang and cmake pins are official release assets for the pinned versions, each with a sha256', async () => {
  const pins = await loadIndexerPins();
  assert.equal(pins['scip-clang'].version, '0.4.0');
  assert.deepEqual(Object.keys(pins['scip-clang'].platforms), ['x86_64-linux']);
  const clang = pins['scip-clang'].platforms['x86_64-linux'];
  assert.equal(clang.url, SCIP_CLANG_URL);
  assert.match(clang.sha256, /^[0-9a-f]{64}$/);

  assert.equal(pins.cmake.version, '4.4.4');
  assert.deepEqual(Object.keys(pins.cmake.platforms), ['x86_64-linux']);
  const cmake = pins.cmake.platforms['x86_64-linux'];
  assert.match(cmake.url, /^https:\/\/files\.pythonhosted\.org\/packages\/.+\/cmake-4\.4\.4-py3-none-manylinux2014_x86_64\.manylinux_2_17_x86_64\.whl$/);
  assert.match(cmake.sha256, /^[0-9a-f]{64}$/);
  assert.equal(LANGUAGES.cpp.indexerVersion(pins), '0.4.0');
});

test('loadIndexerPins rejects a pin file without the scip-clang or cmake platform entries', async () => {
  await inTempDir(async (dir) => {
    for (const [name, mutate, message] of [
      ['scip-clang', (pin) => delete pin.platforms['x86_64-linux'].sha256, /scip-clang\.platforms\.x86_64-linux\.sha256/],
      ['cmake', (pin) => delete pin.platforms, /cmake\.platforms must be an object/],
      ['cmake', (pin) => delete pin.version, /cmake\.version/],
    ]) {
      const pins = JSON.parse(await readFile(path.join(__dirname, '..', 'indexer-pins.json'), 'utf8'));
      mutate(pins[name]);
      const file = path.join(dir, 'indexer-pins.json');
      await writeFile(file, JSON.stringify(pins));
      await assert.rejects(() => loadIndexerPins(file), message);
    }
  });
});

test('installIndexerFor installs the companion tools along with the indexer, companions first', async () => {
  const order = [];
  const saved = { install: LANGUAGES.cpp.install, installCompanions: LANGUAGES.cpp.installCompanions };
  LANGUAGES.cpp.installCompanions = async () => {
    order.push('cmake');
    return { cmake: '/tools/cmake' };
  };
  LANGUAGES.cpp.install = async () => {
    order.push('scip-clang');
    return '/tools/scip-clang';
  };
  try {
    assert.deepEqual(await installIndexerFor('cpp', {}, '/bins'), { cmake: '/tools/cmake', scipClang: '/tools/scip-clang' });
    assert.deepEqual(order, ['cmake', 'scip-clang']);
  } finally {
    Object.assign(LANGUAGES.cpp, saved);
  }
});
