/**
 * install.mjs -- downloads and verifies the pinned SCIP indexers BEFORE
 * ever installing or executing them: the fetched artifact is hashed and
 * compared to the value in `indexer-pins.json`; npm's own package integrity
 * check is not this action's source of truth. Every network fetch and
 * subprocess call takes an injectable seam so tests exercise the integrity
 * gate itself against controlled bytes, never a real npm registry, GitHub
 * release or NuGet feed.
 */

import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { sha256HexOfBuffer, npmIntegrityOfBuffer } from './hash.mjs';
import { API_TIMEOUT_MS, TRANSFER_TIMEOUT_MS, NPM_INSTALL_TIMEOUT_MS } from './timeouts.mjs';

const execFile = promisify(execFileCb);

export class IndexerIntegrityError extends Error {}

const RELEASE_HOST = 'github.com';
const RUST_ANALYZER_RELEASE_PATH_PREFIX = '/rust-lang/rust-analyzer/releases/download/';
const SCIP_JAVA_RELEASE_PATH_PREFIX = '/scip-code/scip-java/releases/download/';
const NUGET_HOST = 'api.nuget.org';
const SCIP_DOTNET_PACKAGE_PATH_PREFIX = '/v3-flatcontainer/scip-dotnet/';
const SCIP_CLANG_RELEASE_PATH_PREFIX = '/sourcegraph/scip-clang/releases/download/';
const PYPI_FILES_HOST = 'files.pythonhosted.org';
const PYPI_FILES_PATH_PREFIX = '/packages/';

/**
 * The sha256 pin already guarantees which bytes run; this keeps the download
 * itself pointed at the indexer's official release location (with `host`, the
 * package registry's or index's file host) and nowhere else, so a mistyped or
 * tampered pin entry cannot make the runner fetch from an arbitrary host.
 */
function assertOfficialReleaseUrl(rawUrl, indexer, pathPrefix, host = RELEASE_HOST) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${indexer} pin url is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:' || url.host !== host || !url.pathname.startsWith(pathPrefix)) {
    throw new Error(`${indexer} pin url must be an https://${host}${pathPrefix}* release asset, got ${rawUrl}`);
  }
}

function registryPackagePath(npmPackage) {
  // npm's own client requests a scoped package's registry metadata with
  // the slash percent-encoded but the leading `@` literal.
  return npmPackage.replace('/', '%2f');
}

function binNameFor(npmPackage) {
  // @sourcegraph/scip-typescript -> scip-typescript
  return npmPackage.split('/').pop();
}

/**
 * Downloads the EXACT npm tarball for `pin.version`, hashes it, and
 * compares to `pin.integrity` before any install step runs. Only on a
 * match does `npm install` run, and it runs from the already-verified
 * LOCAL tarball path -- never re-fetching from the registry -- so npm
 * never gets a chance to install bytes this action never hashed.
 */
export async function installNpmIndexer(
  { npmPackage, version, integrity },
  binDir,
  { fetchImpl = fetch, execFileImpl = execFile } = {},
) {
  const metaUrl = `https://registry.npmjs.org/${registryPackagePath(npmPackage)}/${version}`;
  const metaResp = await fetchImpl(metaUrl, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!metaResp.ok) throw new Error(`npm registry metadata fetch failed: ${metaUrl} -> ${metaResp.status}`);
  const meta = await metaResp.json();
  const tarballUrl = meta?.dist?.tarball;
  if (typeof tarballUrl !== 'string' || tarballUrl.length === 0) {
    throw new Error(`npm registry metadata for ${npmPackage}@${version} carried no dist.tarball`);
  }

  const tarballResp = await fetchImpl(tarballUrl, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
  if (!tarballResp.ok) throw new Error(`npm tarball fetch failed: ${tarballUrl} -> ${tarballResp.status}`);
  const tarballBuf = Buffer.from(await tarballResp.arrayBuffer());

  const actual = npmIntegrityOfBuffer(tarballBuf);
  if (actual !== integrity) {
    throw new IndexerIntegrityError(
      `${npmPackage}@${version}: downloaded tarball integrity ${actual} does not match pinned ${integrity}`,
    );
  }

  await mkdir(binDir, { recursive: true });
  const tarballPath = path.join(binDir, `${npmPackage.replace('@', '').replace('/', '-')}-${version}.tgz`);
  await writeFile(tarballPath, tarballBuf);

  await execFileImpl('npm', ['install', '-g', '--prefix', binDir, tarballPath], { timeout: NPM_INSTALL_TIMEOUT_MS });

  return path.join(binDir, 'bin', binNameFor(npmPackage));
}

/**
 * Downloads the pinned rust-analyzer release asset for `platformKey`,
 * verifies its sha256 before writing anything, gunzips it, and marks it
 * executable.
 */
export async function installRustAnalyzer(pin, binDir, platformKey, fetchImpl = fetch) {
  const platform = pin.platforms[platformKey];
  if (platform === undefined) {
    throw new Error(`rust-analyzer pin has no entry for platform "${platformKey}"`);
  }
  assertOfficialReleaseUrl(platform.url, 'rust-analyzer', RUST_ANALYZER_RELEASE_PATH_PREFIX);

  const resp = await fetchImpl(platform.url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`rust-analyzer asset fetch failed: ${platform.url} -> ${resp.status}`);
  const gzBuf = Buffer.from(await resp.arrayBuffer());

  const actual = sha256HexOfBuffer(gzBuf);
  if (actual !== platform.sha256) {
    throw new IndexerIntegrityError(
      `rust-analyzer ${pin.releaseTag} (${platformKey}): downloaded asset sha256 ${actual} does not match pinned ${platform.sha256}`,
    );
  }

  const binBuf = gunzipSync(gzBuf);
  await mkdir(binDir, { recursive: true });
  const binPath = path.join(binDir, 'rust-analyzer');
  await writeFile(binPath, binBuf);
  await chmod(binPath, 0o755);
  return binPath;
}

/**
 * Downloads the pinned scip-java release asset (one platform-independent
 * self-executing jar), verifies its sha256 before writing anything, and
 * marks it executable. It runs on the runner's own JDK -- see `assertJdk`.
 */
export async function installScipJava(pin, binDir, fetchImpl = fetch) {
  assertOfficialReleaseUrl(pin.url, 'scip-java', SCIP_JAVA_RELEASE_PATH_PREFIX);

  const resp = await fetchImpl(pin.url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`scip-java asset fetch failed: ${pin.url} -> ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());

  const actual = sha256HexOfBuffer(buf);
  if (actual !== pin.sha256) {
    throw new IndexerIntegrityError(`scip-java ${pin.version}: downloaded asset sha256 ${actual} does not match pinned ${pin.sha256}`);
  }

  await mkdir(binDir, { recursive: true });
  const binPath = path.join(binDir, 'scip-java');
  await writeFile(binPath, buf);
  await chmod(binPath, 0o755);
  return binPath;
}

/**
 * Downloads the pinned scip-clang release asset for `platformKey` (one
 * statically-bundled executable), verifies its sha256 before writing
 * anything, and marks it executable.
 */
export async function installScipClang(pin, binDir, platformKey, fetchImpl = fetch) {
  const platform = pin.platforms[platformKey];
  if (platform === undefined) {
    throw new Error(`scip-clang pin has no entry for platform "${platformKey}"`);
  }
  assertOfficialReleaseUrl(platform.url, 'scip-clang', SCIP_CLANG_RELEASE_PATH_PREFIX);

  const resp = await fetchImpl(platform.url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`scip-clang asset fetch failed: ${platform.url} -> ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());

  const actual = sha256HexOfBuffer(buf);
  if (actual !== platform.sha256) {
    throw new IndexerIntegrityError(
      `scip-clang ${pin.version} (${platformKey}): downloaded asset sha256 ${actual} does not match pinned ${platform.sha256}`,
    );
  }

  await mkdir(binDir, { recursive: true });
  const binPath = path.join(binDir, 'scip-clang');
  await writeFile(binPath, buf);
  await chmod(binPath, 0o755);
  return binPath;
}

/**
 * Installs the pinned CMake wheel with `pip --require-hashes`, so pip itself
 * refuses any bytes but the pinned sha256, into a directory of its own under
 * `binDir` (`--target` leaves the runner's Python alone). Returns the real
 * `cmake` executable inside the wheel, not its console-script wrapper, and
 * confirms it reports the pinned version.
 */
export async function installCmake(pin, binDir, platformKey, { execFileImpl = execFile } = {}) {
  const platform = pin.platforms[platformKey];
  if (platform === undefined) {
    throw new Error(`cmake pin has no entry for platform "${platformKey}"`);
  }
  assertOfficialReleaseUrl(platform.url, 'cmake', PYPI_FILES_PATH_PREFIX, PYPI_FILES_HOST);

  const wheelDir = path.join(binDir, 'cmake-wheel');
  const requirements = path.join(binDir, 'cmake-requirements.txt');
  await mkdir(binDir, { recursive: true });
  await writeFile(requirements, `cmake @ ${platform.url} --hash=sha256:${platform.sha256}\n`);
  try {
    await execFileImpl(
      'python3',
      ['-m', 'pip', 'install', '--require-hashes', '--only-binary=:all:', '--no-deps', '--disable-pip-version-check', '--target', wheelDir, '-r', requirements],
      { timeout: NPM_INSTALL_TIMEOUT_MS },
    );
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error('C/C++ indexing needs python3 with pip on the runner to install the pinned CMake; none was found');
    throw new Error(`installing the pinned CMake ${pin.version} with pip failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const binPath = path.join(wheelDir, 'cmake', 'data', 'bin', 'cmake');
  const { stdout } = await execFileImpl(binPath, ['--version'], { timeout: API_TIMEOUT_MS });
  if (!new RegExp(`^cmake version ${pin.version.replace(/\./g, '\\.')}\\b`).test(String(stdout))) {
    throw new Error(`the installed CMake does not report version ${pin.version}: ${String(stdout).split('\n')[0]}`);
  }
  return binPath;
}

/** scip-java 0.13 does not run on an older JDK. */
export const MIN_JDK_MAJOR = 17;

/**
 * Major version from `java -version` output: `"21.0.2"` -> 21, `"17"` -> 17,
 * the legacy `"1.8.0_392"` -> 8. `null` when no version string is present.
 */
export function parseJdkMajor(versionOutput) {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (match === null) return null;
  const first = Number(match[1]);
  return first === 1 && match[2] !== undefined ? Number(match[2]) : first;
}

function isExecutable(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Confirms the runner has a JDK scip-java can use, picking the `java` the
 * scip-java launcher itself will pick: `$JAVA_HOME/bin/java` when executable,
 * else `java` on PATH. The action installs no JDK -- the repository's build
 * needs its own, set up by its workflow -- so a missing or too-old one fails
 * the pair here, before the download, with the reason.
 */
export async function assertJdk({ env = process.env, execFileImpl = execFile } = {}) {
  const javaHome = env.JAVA_HOME;
  const javaCmd = javaHome && isExecutable(path.join(javaHome, 'bin', 'java')) ? path.join(javaHome, 'bin', 'java') : 'java';
  const setupHint = 'add actions/setup-java (JDK 17 or newer) to the workflow before this step';

  let output;
  try {
    const { stdout, stderr } = await execFileImpl(javaCmd, ['-version'], { env, timeout: API_TIMEOUT_MS });
    output = `${stderr ?? ''}\n${stdout ?? ''}`;
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(`Java indexing needs a JDK ${MIN_JDK_MAJOR}+ on the runner (JAVA_HOME or PATH) and none was found; ${setupHint}`);
    throw new Error(`Java indexing could not run \`${javaCmd} -version\`: ${err instanceof Error ? err.message : String(err)}`);
  }

  const major = parseJdkMajor(output);
  if (major === null) {
    throw new Error(`Java indexing could not read the JDK version from \`${javaCmd} -version\`; ${setupHint}`);
  }
  if (major < MIN_JDK_MAJOR) {
    throw new Error(`Java indexing needs JDK ${MIN_JDK_MAJOR} or newer, but the runner's JDK is ${major}; ${setupHint}`);
  }
  return major;
}

/** Keeps the .NET CLI from phoning home or printing its banner in the caller's CI. */
export const DOTNET_CLI_ENV = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };

/** scip-dotnet ships builds for .NET 6 through 10; an older SDK cannot install it. */
export const MIN_DOTNET_SDK_MAJOR = 6;

/**
 * Confirms the runner has a .NET SDK (`dotnet` on PATH, as `actions/setup-dotnet`
 * leaves it). The action installs none: the repository's restore and project
 * load need the SDK its own `global.json` asks for, which only its workflow
 * knows. A missing or too-old SDK fails the pair here, before the download,
 * with the reason.
 */
export async function assertDotnetSdk({ env = process.env, execFileImpl = execFile } = {}) {
  const setupHint = 'add actions/setup-dotnet (the SDK your global.json asks for) to the workflow before this step';

  let stdout;
  try {
    ({ stdout } = await execFileImpl('dotnet', ['--version'], { env: { ...env, ...DOTNET_CLI_ENV }, timeout: API_TIMEOUT_MS }));
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(`C# indexing needs the .NET SDK on the runner (dotnet on PATH) and none was found; ${setupHint}`);
    throw new Error(`C# indexing could not run \`dotnet --version\`: ${err instanceof Error ? err.message : String(err)}`);
  }

  const match = /^\s*(\d+)\./.exec(stdout ?? '');
  if (match === null) {
    throw new Error(`C# indexing could not read the .NET SDK version from \`dotnet --version\`; ${setupHint}`);
  }
  const major = Number(match[1]);
  if (major < MIN_DOTNET_SDK_MAJOR) {
    throw new Error(`C# indexing needs .NET SDK ${MIN_DOTNET_SDK_MAJOR} or newer, but the runner's SDK is ${major}; ${setupHint}`);
  }
  return major;
}

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Downloads the pinned scip-dotnet package from nuget.org, verifies its sha256
 * before writing anything, and installs it as a .NET tool from that verified
 * file alone. The install reads a generated NuGet config whose only source is
 * the directory holding the verified package, so neither nuget.org nor a
 * feed in the repository's own NuGet.config can supply a different
 * scip-dotnet@version. Returns the tool's launcher path.
 */
export async function installScipDotnet(pin, binDir, { fetchImpl = fetch, execFileImpl = execFile } = {}) {
  assertOfficialReleaseUrl(pin.url, 'scip-dotnet', SCIP_DOTNET_PACKAGE_PATH_PREFIX, NUGET_HOST);

  const resp = await fetchImpl(pin.url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`scip-dotnet package fetch failed: ${pin.url} -> ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());

  const actual = sha256HexOfBuffer(buf);
  if (actual !== pin.sha256) {
    throw new IndexerIntegrityError(`scip-dotnet ${pin.version}: downloaded package sha256 ${actual} does not match pinned ${pin.sha256}`);
  }

  const sourceDir = path.join(binDir, 'scip-dotnet-package');
  const toolDir = path.join(binDir, 'scip-dotnet-tool');
  const configPath = path.join(binDir, 'scip-dotnet-nuget.config');
  await rm(toolDir, { recursive: true, force: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, `scip-dotnet.${pin.version}.nupkg`), buf);
  await writeFile(
    configPath,
    `<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n  <packageSources>\n    <clear />\n    <add key="verified" value="${xmlEscape(sourceDir)}" />\n  </packageSources>\n</configuration>\n`,
  );

  await execFileImpl(
    'dotnet',
    ['tool', 'install', 'scip-dotnet', '--version', pin.version, '--tool-path', toolDir, '--configfile', configPath],
    { env: { ...process.env, ...DOTNET_CLI_ENV }, timeout: NPM_INSTALL_TIMEOUT_MS },
  );

  return path.join(toolDir, 'scip-dotnet');
}

const PLATFORM_KEY_BY_NODE_TRIPLE = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

/** scip-clang v0.4.0 publishes a Linux x86_64 build only. */
export function detectScipClangPlatformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return 'x86_64-linux';
  throw new Error(`unsupported platform for scip-clang: ${platform}-${arch}`);
}

/** Maps Node's own `process.platform`/`process.arch` to the pin file's
 *  rust target-triple platform keys. */
export function detectRustAnalyzerPlatformKey(platform = process.platform, arch = process.arch) {
  const key = PLATFORM_KEY_BY_NODE_TRIPLE[`${platform}-${arch}`];
  if (key === undefined) throw new Error(`unsupported platform for rust-analyzer: ${platform}-${arch}`);
  return key;
}
