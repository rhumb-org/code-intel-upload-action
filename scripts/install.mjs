/**
 * install.mjs -- downloads and verifies the pinned SCIP indexers BEFORE
 * ever installing or executing them: the fetched artifact is hashed and
 * compared to the value in `indexer-pins.json`; npm's own package integrity
 * check is not this action's source of truth. Every network fetch and
 * subprocess call takes an injectable seam so tests exercise the integrity
 * gate itself against controlled bytes, never a real npm registry or GitHub
 * release.
 */

import { mkdir, writeFile, chmod } from 'node:fs/promises';
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

/**
 * The sha256 pin already guarantees which bytes run; this keeps the download
 * itself pointed at the indexer's official GitHub releases and nowhere else,
 * so a mistyped or tampered pin entry cannot make the runner fetch from an
 * arbitrary host.
 */
function assertOfficialReleaseUrl(rawUrl, indexer, pathPrefix) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${indexer} pin url is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:' || url.host !== RELEASE_HOST || !url.pathname.startsWith(pathPrefix)) {
    throw new Error(`${indexer} pin url must be an https://${RELEASE_HOST}${pathPrefix}* release asset, got ${rawUrl}`);
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

const PLATFORM_KEY_BY_NODE_TRIPLE = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

/** Maps Node's own `process.platform`/`process.arch` to the pin file's
 *  rust target-triple platform keys. */
export function detectRustAnalyzerPlatformKey(platform = process.platform, arch = process.arch) {
  const key = PLATFORM_KEY_BY_NODE_TRIPLE[`${platform}-${arch}`];
  if (key === undefined) throw new Error(`unsupported platform for rust-analyzer: ${platform}-${arch}`);
  return key;
}
