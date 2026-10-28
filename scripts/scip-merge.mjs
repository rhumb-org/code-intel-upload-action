/**
 * scip-merge.mjs -- folds the SCIP indexes of one language's roots into the
 * single repo-relative index Rhumb stores per (repository, commit, language).
 *
 * WHY. Every indexer runs with its root as the project root, so a
 * `Document.relative_path` is relative to that root. The ingester stores paths
 * verbatim and the read side treats them as repository paths, so an index of
 * `svc/` only lines up with the repository once `svc/` is put back in front of
 * each path. One merged index also matches what Rhumb's own worker publishes.
 *
 * HOW. A streaming protobuf wire pass over the fields the ingester reads
 * (Index: 1 metadata, 2 documents, 3 external_symbols; Document: 1
 * relative_path; Metadata: 3 project_root; SymbolInformation: 1 symbol). Only
 * one top-level record is held in memory at a time. Every other field -- and
 * every field this pass does not know -- is copied byte for byte, so nothing
 * the indexer wrote is lost to an outdated schema. Groups (wire types 3/4) are
 * not part of SCIP and fail the merge.
 *
 * A single index of the repository root has nothing to rewrite and is handed
 * back untouched, so the common single-root upload stays byte-identical.
 */

import path from 'node:path';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

const INDEX_METADATA = 1;
const INDEX_DOCUMENTS = 2;
const INDEX_EXTERNAL_SYMBOLS = 3;
const DOCUMENT_RELATIVE_PATH = 1;
const METADATA_PROJECT_ROOT = 3;
const SYMBOL_INFORMATION_SYMBOL = 1;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

/** A tag is at most 5 bytes and a length at most 10; read ahead this far for a header. */
const MAX_HEADER_BYTES = 16;
const FLUSH_BYTES = 1024 * 1024;

function encodeVarint(value) {
  const bytes = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** Returns `[value, nextPos]`; arithmetic rather than bit operators so lengths above 2^31 stay exact. */
function decodeVarint(buf, pos) {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i += 1) {
    if (pos + i >= buf.length) throw new Error('truncated SCIP index: varint runs past the end of the data');
    const byte = buf[pos + i];
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [value, pos + i + 1];
    scale *= 0x80;
  }
  throw new Error('malformed SCIP index: varint longer than 10 bytes');
}

/**
 * Parses the field header at `pos`. `end` is where the whole field ends; it can
 * lie past `buf.length` when the field's payload is not fully buffered yet.
 */
function parseField(buf, pos) {
  const [tag, afterTag] = decodeVarint(buf, pos);
  const wireType = tag % 8;
  const field = Math.floor(tag / 8);
  switch (wireType) {
    case WIRE_VARINT: {
      const [, end] = decodeVarint(buf, afterTag);
      return { field, wireType, headerEnd: afterTag, end };
    }
    case WIRE_FIXED64:
      return { field, wireType, headerEnd: afterTag, end: afterTag + 8 };
    case WIRE_FIXED32:
      return { field, wireType, headerEnd: afterTag, end: afterTag + 4 };
    case WIRE_LEN: {
      const [length, headerEnd] = decodeVarint(buf, afterTag);
      return { field, wireType, headerEnd, end: headerEnd + length };
    }
    default:
      throw new Error(`unsupported protobuf wire type ${wireType} on field ${field} (SCIP uses no groups)`);
  }
}

/** Fields of an in-memory message, as `{field, wireType, start, headerEnd, end}`. */
function* fieldsOf(buf) {
  let pos = 0;
  while (pos < buf.length) {
    const parsed = parseField(buf, pos);
    if (parsed.end > buf.length) throw new Error('truncated SCIP index: a field runs past the end of its message');
    yield { ...parsed, start: pos };
    pos = parsed.end;
  }
}

function lenField(field, payload) {
  return Buffer.concat([encodeVarint(field * 8 + WIRE_LEN), encodeVarint(payload.length), payload]);
}

/**
 * Rewrites each length-delimited `fieldNo` of `message` through `map`, copying
 * everything else verbatim. With `appendIfMissing`, a missing field is added.
 */
function rewriteLenField(message, fieldNo, map, appendIfMissing) {
  const parts = [];
  let found = false;
  for (const f of fieldsOf(message)) {
    if (f.field === fieldNo && f.wireType === WIRE_LEN) {
      found = true;
      parts.push(lenField(fieldNo, map(message.subarray(f.headerEnd, f.end))));
    } else {
      parts.push(message.subarray(f.start, f.end));
    }
  }
  if (!found && appendIfMissing !== undefined) parts.push(lenField(fieldNo, appendIfMissing));
  return Buffer.concat(parts);
}

/** `.`, `./`, `` -> `` (the repository root); otherwise the root as a clean posix prefix without a trailing slash. */
export function rootPrefix(root) {
  const normalized = path.posix.normalize(root.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === './') return '';
  return normalized.replace(/\/+$/, '');
}

/**
 * `relative_path` -> repository path. Paths the ingester rejects anyway
 * (absolute, `..` segments, empty) are left as the indexer wrote them rather
 * than being quietly turned into something valid.
 */
function prefixedPath(prefix, relativePath) {
  // Decide on a bytewise view; only ASCII `/` and `.` matter, so the result keeps the indexer's exact bytes.
  const text = relativePath.toString('latin1');
  if (text.length === 0 || text.startsWith('/') || text.split('/').includes('..')) return relativePath;
  let skip = 0;
  while (text.startsWith('./', skip)) skip += 2;
  return Buffer.concat([prefix, Buffer.from('/'), relativePath.subarray(skip)]);
}

/** Pull-style reader over a chunked byte source that can look ahead and hand out whole records. */
class RecordReader {
  #chunks;
  #buf = Buffer.alloc(0);
  #pos = 0;
  #done = false;

  constructor(chunks) {
    this.#chunks = chunks[Symbol.asyncIterator]();
  }

  /** Buffers at least `n` unread bytes if the source has them; returns how many are available. */
  async #fill(n) {
    if (this.#buf.length - this.#pos >= n || this.#done) return this.#buf.length - this.#pos;
    const parts = [this.#buf.subarray(this.#pos)];
    let total = parts[0].length;
    while (total < n && !this.#done) {
      const next = await this.#chunks.next();
      if (next.done) {
        this.#done = true;
      } else {
        parts.push(next.value);
        total += next.value.length;
      }
    }
    this.#buf = parts.length === 1 ? parts[0] : Buffer.concat(parts, total);
    this.#pos = 0;
    return total;
  }

  /** The next top-level field as `{field, wireType, raw, payload}`, or `null` at the end. */
  async next() {
    if ((await this.#fill(1)) === 0) return null;
    await this.#fill(MAX_HEADER_BYTES);
    let parsed = parseField(this.#buf, this.#pos);
    const needed = parsed.end - this.#pos;
    if (this.#buf.length - this.#pos < needed) {
      if ((await this.#fill(needed)) < needed) throw new Error('truncated SCIP index: a field runs past the end of the file');
      parsed = parseField(this.#buf, this.#pos);
    }
    const start = this.#pos;
    const raw = this.#buf.subarray(start, parsed.end);
    this.#pos = parsed.end;
    const payload = parsed.wireType === WIRE_LEN ? raw.subarray(parsed.headerEnd - start) : undefined;
    return { field: parsed.field, wireType: parsed.wireType, raw, payload };
  }
}

class BufferedFile {
  #handle;
  #parts = [];
  #size = 0;

  constructor(handle) {
    this.#handle = handle;
  }

  async write(buf) {
    this.#parts.push(buf);
    this.#size += buf.length;
    if (this.#size >= FLUSH_BYTES) await this.flush();
  }

  async flush() {
    if (this.#parts.length === 0) return;
    await this.#handle.write(Buffer.concat(this.#parts, this.#size));
    this.#parts = [];
    this.#size = 0;
  }

  async close() {
    try {
      await this.flush();
    } finally {
      await this.#handle.close();
    }
  }
}

/**
 * Merges the indexes in `inputs` (`[{root, scipPath}]`, in declared order) into
 * one repo-relative index at `outputPath`, and returns `{path, passthrough}`.
 *
 * - One input whose root is the repository root: nothing to rewrite; `path` is
 *   that input's own file and `passthrough` is true.
 * - Otherwise: the first input's metadata (its `project_root` set to
 *   `projectRootUri`) comes first, then each input's documents and external
 *   symbols in order with the root put in front of every path. Later metadata
 *   is dropped. External symbols repeat across roots and are kept once, first
 *   wins; documents are not deduplicated (the ingester folds repeats).
 *
 * `chunkSize` is for tests, to cut records at awkward places.
 */
export async function mergeScipIndexes({ inputs, outputPath, projectRootUri, chunkSize }) {
  if (inputs.length === 0) throw new Error('no indexes to merge');
  if (inputs.length === 1 && rootPrefix(inputs[0].root) === '') {
    return { path: inputs[0].scipPath, passthrough: true };
  }

  const projectRoot = Buffer.from(projectRootUri, 'utf8');
  const seenSymbols = new Set();
  let metadataWritten = false;
  const out = new BufferedFile(await open(outputPath, 'w'));
  try {
    for (const { root, scipPath } of inputs) {
      const prefix = rootPrefix(root);
      const prefixBytes = Buffer.from(prefix, 'utf8');
      const reader = new RecordReader(createReadStream(scipPath, chunkSize === undefined ? undefined : { highWaterMark: chunkSize }));
      for (let record = await reader.next(); record !== null; record = await reader.next()) {
        const isRecord = record.wireType === WIRE_LEN;
        if (isRecord && record.field === INDEX_METADATA) {
          if (metadataWritten) continue;
          metadataWritten = true;
          await out.write(lenField(INDEX_METADATA, rewriteLenField(record.payload, METADATA_PROJECT_ROOT, () => projectRoot, projectRoot)));
          continue;
        }
        if (isRecord && (record.field === INDEX_DOCUMENTS || record.field === INDEX_EXTERNAL_SYMBOLS) && !metadataWritten) {
          throw new Error(`the index of root "${root}" has documents or external symbols before any metadata`);
        }
        if (isRecord && record.field === INDEX_DOCUMENTS && prefix !== '') {
          const rewritten = rewriteLenField(record.payload, DOCUMENT_RELATIVE_PATH, (p) => prefixedPath(prefixBytes, p));
          await out.write(lenField(INDEX_DOCUMENTS, rewritten));
          continue;
        }
        if (isRecord && record.field === INDEX_EXTERNAL_SYMBOLS) {
          const symbol = symbolOf(record.payload);
          if (symbol !== undefined) {
            if (seenSymbols.has(symbol)) continue;
            seenSymbols.add(symbol);
          }
        }
        await out.write(record.raw);
      }
    }
    if (!metadataWritten) throw new Error('none of the indexes carries metadata');
  } finally {
    await out.close();
  }
  return { path: outputPath, passthrough: false };
}

/** The symbol string of an external-symbol record (bytewise, so equal bytes are equal keys), if it has one. */
function symbolOf(payload) {
  for (const f of fieldsOf(payload)) {
    if (f.field === SYMBOL_INFORMATION_SYMBOL && f.wireType === WIRE_LEN) return payload.toString('latin1', f.headerEnd, f.end);
  }
  return undefined;
}
