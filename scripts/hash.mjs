/**
 * hash.mjs -- the three digest shapes this action needs. File-based
 * sha256Hex is the RAW (pre-gzip) .scip digest sent with the upload's
 * `complete` call; it must be the same uncompressed bytes the server
 * re-hashes. The Buffer-based helpers verify a downloaded indexer artifact
 * against the pinned value BEFORE it is installed or executed: the pin
 * file, not npm's own installed-package check, is the source of truth.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export async function sha256Hex(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

export function sha256HexOfBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** npm's own `dist.integrity` SRI shape (`sha512-<base64>`), so the result
 *  compares directly against the pin file's `integrity` field. */
export function npmIntegrityOfBuffer(buf) {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}
