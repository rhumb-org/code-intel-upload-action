import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mergeScipIndexes, rootPrefix } from '../scripts/scip-merge.mjs';

// A deliberately separate, tiny protobuf codec: the test must not share code with the module it checks.
function varint(n) {
  const out = [];
  let rest = n;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return Buffer.from(out);
}
const len = (field, payload) => {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
};
const vi = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const fixed32 = (field, value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return Buffer.concat([varint(field * 8 + 5), b]);
};
const fixed64 = (field, value) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([varint(field * 8 + 1), b]);
};

const metadata = ({ projectRoot = 'file:///root-a', extra = [] } = {}) =>
  len(1, Buffer.concat([vi(1, 0), len(2, 'tool-info'), ...(projectRoot === null ? [] : [len(3, projectRoot)]), ...extra]));
const document = (relativePath, extra = []) => len(2, Buffer.concat([len(1, relativePath), len(4, 'occurrence-bytes'), ...extra]));
const externalSymbol = (symbol, doc = '') => len(3, Buffer.concat([len(1, symbol), len(3, doc)]));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Top-level `{field, wireType, payload}` records of an encoded message. */
function decode(buf) {
  const records = [];
  let pos = 0;
  const read = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = buf[pos++];
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 0x80;
    }
  };
  while (pos < buf.length) {
    const tag = read();
    const wireType = tag % 8;
    const field = Math.floor(tag / 8);
    if (wireType === 0) records.push({ field, wireType, payload: varint(read()) });
    else if (wireType === 1) records.push({ field, wireType, payload: buf.subarray(pos, (pos += 8)) });
    else if (wireType === 5) records.push({ field, wireType, payload: buf.subarray(pos, (pos += 4)) });
    else {
      const n = read();
      records.push({ field, wireType, payload: buf.subarray(pos, (pos += n)) });
    }
  }
  return records;
}
const paths = (buf) =>
  decode(buf)
    .filter((r) => r.field === 2)
    .map((r) => decode(r.payload).find((f) => f.field === 1).payload.toString());
const projectRootOf = (record) => decode(record.payload).find((f) => f.field === 3).payload.toString();

async function withDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scip-merge-test-'));
  try {
    return await fn(dir, async (name, ...parts) => {
      const file = path.join(dir, name);
      await writeFile(file, Buffer.concat(parts));
      return file;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const URI = 'file:///work/repo';

test('rootPrefix: the repository root is empty; others lose ./ and trailing slashes', () => {
  assert.equal(rootPrefix('.'), '');
  assert.equal(rootPrefix('./'), '');
  assert.equal(rootPrefix('svc'), 'svc');
  assert.equal(rootPrefix('./svc/'), 'svc');
  assert.equal(rootPrefix('a//b/'), 'a/b');
});

test('a single index of the repository root passes through byte-identical', async () => {
  await withDir(async (dir, put) => {
    const input = await put('in.scip', metadata(), document('src/a.ts'), externalSymbol('npm x 1 y.'), vi(77, 5));
    const before = sha256(await readFile(input));
    const merged = await mergeScipIndexes({ inputs: [{ root: '.', scipPath: input }], outputPath: path.join(dir, 'out.scip'), projectRootUri: URI });
    assert.equal(merged.passthrough, true);
    assert.equal(sha256(await readFile(merged.path)), before);
    // './' and '' name the repository root too
    for (const root of ['./', '']) {
      const again = await mergeScipIndexes({ inputs: [{ root, scipPath: input }], outputPath: path.join(dir, 'out.scip'), projectRootUri: URI });
      assert.equal(again.passthrough, true);
    }
  });
});

test('a single non-root index gets the root in front of every path and project_root set to the workspace', async () => {
  await withDir(async (dir, put) => {
    const input = await put('in.scip', metadata(), document('src/a.ts'), document('src/b.ts'));
    const out = path.join(dir, 'out.scip');
    const merged = await mergeScipIndexes({ inputs: [{ root: 'svc', scipPath: input }], outputPath: out, projectRootUri: URI });
    assert.equal(merged.passthrough, false);
    const result = await readFile(out);
    assert.deepEqual(paths(result), ['svc/src/a.ts', 'svc/src/b.ts']);
    assert.equal(decode(result)[0].field, 1);
    assert.equal(projectRootOf(decode(result)[0]), URI);
  });
});

test('two roots: one metadata first, declared order kept, unknown fields verbatim, external symbols deduplicated first-wins', async () => {
  await withDir(async (dir, put) => {
    const unknownTop = [vi(90, 300), fixed32(91, 7), fixed64(92, 2 ** 40), len(93, 'opaque')];
    const unknownDoc = [vi(50, 1), fixed32(51, 2), len(52, 'x')];
    const a = await put(
      'a.scip',
      metadata({ extra: [vi(9, 3)] }),
      document('lib/one.rs', unknownDoc),
      externalSymbol('cargo std 1 Vec#', 'first'),
      ...unknownTop,
      document('lib/two.rs'),
    );
    const b = await put(
      'b.scip',
      metadata({ projectRoot: 'file:///root-b' }),
      document('src/main.rs'),
      externalSymbol('cargo std 1 Vec#', 'second'),
      externalSymbol('cargo std 1 String#', 'third'),
      document('lib/one.rs'),
    );
    const out = path.join(dir, 'out.scip');
    await mergeScipIndexes({
      inputs: [
        { root: 'crates/a', scipPath: a },
        { root: './crates/b/', scipPath: b },
      ],
      outputPath: out,
      projectRootUri: URI,
    });
    const result = await readFile(out);
    const records = decode(result);

    assert.equal(records.filter((r) => r.field === 1).length, 1, 'one metadata record');
    assert.equal(records[0].field, 1, 'metadata comes first');
    assert.equal(projectRootOf(records[0]), URI);
    assert.ok(decode(records[0].payload).some((f) => f.field === 9), "the first root's other metadata fields survive");
    assert.ok(decode(records[0].payload).some((f) => f.field === 2 && f.payload.toString() === 'tool-info'));

    assert.deepEqual(paths(result), ['crates/a/lib/one.rs', 'crates/a/lib/two.rs', 'crates/b/src/main.rs', 'crates/b/lib/one.rs'], 'order kept, repeated paths not deduplicated');

    const docOne = decode(records.find((r) => r.field === 2).payload);
    assert.deepEqual(
      docOne.filter((f) => f.field >= 50).map((f) => [f.field, f.wireType, f.payload.toString('hex')]),
      decode(Buffer.concat(unknownDoc)).map((f) => [f.field, f.wireType, f.payload.toString('hex')]),
      'unknown document fields are copied untouched',
    );
    assert.equal(docOne.find((f) => f.field === 4).payload.toString(), 'occurrence-bytes');

    const unknownOut = records.filter((r) => r.field >= 90).map((r) => [r.field, r.wireType, r.payload.toString('hex')]);
    assert.deepEqual(unknownOut, decode(Buffer.concat(unknownTop)).map((r) => [r.field, r.wireType, r.payload.toString('hex')]));

    const symbols = records.filter((r) => r.field === 3).map((r) => decode(r.payload).find((f) => f.field === 1).payload.toString() + ':' + decode(r.payload).find((f) => f.field === 3).payload.toString());
    assert.deepEqual(symbols, ['cargo std 1 Vec#:first', 'cargo std 1 String#:third']);
  });
});

test('a repository-root input among several keeps its paths and the others are prefixed', async () => {
  await withDir(async (dir, put) => {
    const a = await put('a.scip', metadata(), document('root.ts'));
    const b = await put('b.scip', metadata(), document('x.ts'));
    const out = path.join(dir, 'out.scip');
    await mergeScipIndexes({
      inputs: [
        { root: '.', scipPath: a },
        { root: 'pkg', scipPath: b },
      ],
      outputPath: out,
      projectRootUri: URI,
    });
    assert.deepEqual(paths(await readFile(out)), ['root.ts', 'pkg/x.ts']);
    assert.equal(projectRootOf(decode(await readFile(out))[0]), URI);
  });
});

test('paths the ingester rejects (.. segments, absolute, empty) are not rewritten into valid ones', async () => {
  await withDir(async (dir, put) => {
    const input = await put('in.scip', metadata(), document('../escape.ts'), document('/abs/a.ts'), document('a/../b.ts'), document(''), document('./dot.ts'));
    const out = path.join(dir, 'out.scip');
    await mergeScipIndexes({ inputs: [{ root: 'svc', scipPath: input }], outputPath: out, projectRootUri: URI });
    assert.deepEqual(paths(await readFile(out)), ['../escape.ts', '/abs/a.ts', 'a/../b.ts', '', 'svc/dot.ts']);
  });
});

test('metadata without a project_root gets one; non-ASCII path bytes survive', async () => {
  await withDir(async (dir, put) => {
    const input = await put('in.scip', metadata({ projectRoot: null }), document('src/café/日本.ts'));
    const out = path.join(dir, 'out.scip');
    await mergeScipIndexes({ inputs: [{ root: 'svc', scipPath: input }], outputPath: out, projectRootUri: URI });
    const result = await readFile(out);
    assert.equal(projectRootOf(decode(result)[0]), URI);
    assert.deepEqual(paths(result), ['svc/src/café/日本.ts']);
  });
});

test('the result does not depend on where the reader cuts the file, including inside a record larger than a chunk', async () => {
  await withDir(async (dir, put) => {
    const big = document('big.ts', [len(60, Buffer.alloc(5000, 7)), vi(61, 2 ** 40)]);
    const a = await put('a.scip', metadata(), document('a.ts'), big, externalSymbol('s 1'));
    const b = await put('b.scip', metadata(), big, externalSymbol('s 1'), document('b.ts'));
    const inputs = [
      { root: 'one', scipPath: a },
      { root: 'two', scipPath: b },
    ];
    const reference = path.join(dir, 'ref.scip');
    await mergeScipIndexes({ inputs, outputPath: reference, projectRootUri: URI });
    const expected = await readFile(reference);
    for (const chunkSize of [1, 3, 16, 17, 1000]) {
      const out = path.join(dir, `out-${chunkSize}.scip`);
      await mergeScipIndexes({ inputs, outputPath: out, projectRootUri: URI, chunkSize });
      assert.ok((await readFile(out)).equals(expected), `chunkSize ${chunkSize}`);
    }
    assert.deepEqual(paths(expected), ['one/a.ts', 'one/big.ts', 'two/big.ts', 'two/b.ts']);
  });
});

test('malformed input fails the merge: groups, truncation, content before metadata, no metadata at all', async () => {
  await withDir(async (dir, put) => {
    const out = path.join(dir, 'out.scip');
    const merge = (file) => mergeScipIndexes({ inputs: [{ root: 'svc', scipPath: file }], outputPath: out, projectRootUri: URI });

    await assert.rejects(merge(await put('group.scip', metadata(), Buffer.from([0x0b, 0x0c]))), /wire type 3/);
    const whole = Buffer.concat([metadata(), document('src/a.ts')]);
    await assert.rejects(merge(await put('cut.scip', whole.subarray(0, whole.length - 3))), /truncated/);
    await assert.rejects(merge(await put('order.scip', document('src/a.ts'), metadata())), /before any metadata/);
    await assert.rejects(merge(await put('nometa.scip', Buffer.alloc(0))), /carries metadata/);
  });
});
