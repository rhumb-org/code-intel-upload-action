import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { loadIndexerPins, PINS_PATH } from '../scripts/pins.mjs';
import { installRustAnalyzer, installScipJava } from '../scripts/install.mjs';

test('the shipped indexer-pins.json loads and carries a pin for every supported indexer and platform', async () => {
  const pins = await loadIndexerPins();

  for (const name of ['scip-typescript', 'scip-python']) {
    assert.match(pins[name].version, /^\d+\.\d+\.\d+$/);
    assert.match(pins[name].integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  }
  assert.deepEqual(Object.keys(pins['rust-analyzer'].platforms).sort(), [
    'aarch64-apple-darwin',
    'aarch64-unknown-linux-gnu',
    'x86_64-apple-darwin',
    'x86_64-unknown-linux-gnu',
  ]);
  for (const entry of Object.values(pins['rust-analyzer'].platforms)) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }
});

test('every shipped rust-analyzer pin URL passes the official-host check and names the pinned release tag', async () => {
  const pin = (await loadIndexerPins())['rust-analyzer'];
  for (const [platformKey, entry] of Object.entries(pin.platforms)) {
    assert.ok(entry.url.includes(`/download/${pin.releaseTag}/`), `${platformKey} url should name release ${pin.releaseTag}`);
    // The host check runs before the fetch, so a refusing fetch seam proves it passed.
    await assert.rejects(
      () => installRustAnalyzer(pin, os.tmpdir(), platformKey, async () => ({ ok: false, status: 599 })),
      /asset fetch failed: .* -> 599/,
    );
  }
});

test('the scip-java pin is one official github.com release asset for the pinned version, with a sha256', async () => {
  const pin = (await loadIndexerPins())['scip-java'];
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pin.url, `https://github.com/scip-code/scip-java/releases/download/v${pin.version}/scip-java-v${pin.version}`);
  // The host check runs before the fetch, so a refusing fetch seam proves it passed.
  await assert.rejects(() => installScipJava(pin, os.tmpdir(), async () => ({ ok: false, status: 599 })), /asset fetch failed: .* -> 599/);
});

test('loadIndexerPins rejects a pin file without the scip-java pin', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-pins-'));
  try {
    const pins = JSON.parse(await readFile(PINS_PATH, 'utf8'));
    delete pins['scip-java'].sha256;
    const file = path.join(dir, 'indexer-pins.json');
    await writeFile(file, JSON.stringify(pins));
    await assert.rejects(() => loadIndexerPins(file), /scip-java\.sha256/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadIndexerPins rejects a malformed pin file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rci-pins-'));
  try {
    const file = path.join(dir, 'indexer-pins.json');
    await writeFile(file, JSON.stringify({ 'scip-typescript': { npmPackage: 'x', version: '1.0.0' } }));
    await assert.rejects(() => loadIndexerPins(file), /scip-typescript\.integrity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
