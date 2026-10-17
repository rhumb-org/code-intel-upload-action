/**
 * pins.mjs -- loads `indexer-pins.json`, shipped in this repository next to
 * the action, which pins every indexer this action installs: npm version +
 * integrity for the two Node indexers, release tag + per-platform URL +
 * sha256 for rust-analyzer. The pins travel with the action's own tag, so
 * what a workflow installs is decided by the action version it references --
 * never by the `base-url` host, which only ever receives uploads.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PINS_PATH = path.resolve(__dirname, '..', 'indexer-pins.json');

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`indexer-pins.json: ${label} must be a non-empty string`);
  }
}

function validatePins(pins) {
  for (const name of ['scip-typescript', 'scip-python']) {
    const pin = pins?.[name];
    requireString(pin?.npmPackage, `${name}.npmPackage`);
    requireString(pin?.version, `${name}.version`);
    requireString(pin?.integrity, `${name}.integrity`);
  }
  const rust = pins?.['rust-analyzer'];
  requireString(rust?.releaseTag, 'rust-analyzer.releaseTag');
  if (rust.platforms === null || typeof rust.platforms !== 'object') {
    throw new Error('indexer-pins.json: rust-analyzer.platforms must be an object');
  }
  for (const [platform, entry] of Object.entries(rust.platforms)) {
    requireString(entry?.url, `rust-analyzer.platforms.${platform}.url`);
    requireString(entry?.sha256, `rust-analyzer.platforms.${platform}.sha256`);
  }
  return pins;
}

export async function loadIndexerPins(pinsPath = PINS_PATH) {
  return validatePins(JSON.parse(await readFile(pinsPath, 'utf8')));
}
