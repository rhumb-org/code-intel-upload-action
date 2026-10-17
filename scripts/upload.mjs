/**
 * upload.mjs -- the transfer half of one language/root's door lifecycle,
 * given an upload the caller already created: gzip -> pre-check against
 * `max_bytes` (a single presigned PUT, no multipart, so the bytes are
 * checked against the door's declared ceiling BEFORE sending them) -> PUT ->
 * complete. Fail-soft throughout: any error here is reported to `/fail` and
 * returned as a result object, never thrown -- the caller advances to the
 * next language/root regardless.
 *
 * `upload` is `{ uploadId, putUrl, maxBytes }` from the door's create call,
 * made by the caller BEFORE indexing so that a failure anywhere in the
 * pipeline (install, the indexer itself) already has an id to `/fail`
 * against. See `run.mjs`.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { stat, readFile, unlink } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { sha256Hex } from './hash.mjs';

export async function uploadIndex(door, lang, scipPath, meta, { uploadId, putUrl, maxBytes }) {
  const startedAt = Date.now();

  try {
    const scipStat = await stat(scipPath).catch(() => null);
    if (scipStat === null) {
      const reason = `no index at ${scipPath}`;
      await door.failUpload(uploadId, reason);
      return { lang, status: 'skipped', uploadId, reason };
    }

    const gzPath = `${scipPath}.gz`;
    await pipeline(createReadStream(scipPath), createGzip(), createWriteStream(gzPath));
    const gzStat = await stat(gzPath);

    if (typeof maxBytes === 'number' && gzStat.size > maxBytes) {
      await unlink(gzPath).catch(() => {});
      const reason = `gzip'd index (${gzStat.size} bytes) exceeds max_bytes (${maxBytes})`;
      await door.failUpload(uploadId, reason);
      return { lang, status: 'failed', uploadId, reason, durationMs: Date.now() - startedAt };
    }

    // The RAW (pre-gzip) digest: the server re-hashes the same uncompressed
    // bytes after it ingests the upload.
    const sha256 = await sha256Hex(scipPath);
    const rawBytes = scipStat.size;
    const gzBuf = await readFile(gzPath);
    await unlink(gzPath).catch(() => {});

    const putResult = await door.putIndex(putUrl, gzBuf);
    if (!putResult.ok) {
      throw new Error(`PUT to presigned URL failed: ${putResult.status} ${putResult.text ?? ''}`);
    }

    const completed = await door.completeUpload(uploadId, {
      sha256,
      raw_bytes: rawBytes,
      indexer_name: meta.indexerName,
      indexer_version: meta.indexerVersion,
      action_version: meta.actionVersion,
      deps_installed: true,
    });
    if (completed.status !== 200) {
      throw new Error(`complete failed: ${completed.status} ${JSON.stringify(completed.body)}`);
    }

    return {
      lang,
      status: completed.body.status ?? 'uploaded',
      uploadId,
      rawBytes,
      compressedBytes: gzStat.size,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await door.failUpload(uploadId, message);
    return { lang, status: 'failed', uploadId, reason: message, durationMs: Date.now() - startedAt };
  }
}
