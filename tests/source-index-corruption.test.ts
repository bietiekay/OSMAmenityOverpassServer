import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { buildSourceBlockIndex, openSourceBlockIndex, openTrackedIndexes, primitiveBlockRanges, buildTrackedIndexes } from '../scripts/extract/source-index.mjs';

const vi = (value: number | bigint): Buffer => {
  let n = BigInt(value); const parts: number[] = [];
  while (n > 127n) { parts.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  parts.push(Number(n)); return Buffer.from(parts);
};
const tag = (field: number, wire: number) => vi((field << 3) | wire);
const bytes = (field: number, value: Buffer) => Buffer.concat([tag(field, 2), vi(value.length), value]);
const uint = (field: number, value: number) => Buffer.concat([tag(field, 0), vi(value)]);
const zig = (value: number) => value >= 0 ? BigInt(value) * 2n : BigInt(-value) * 2n - 1n;
const frame = (type: string, blob: Buffer) => {
  const header = Buffer.concat([bytes(1, Buffer.from(type)), uint(3, blob.length)]);
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, blob]);
};
const nodeBlock = (ids: number[]) => {
  const nodes = ids.map(id => bytes(1, uint(1, Number(zig(id)))));
  const group = Buffer.concat(nodes); const primitive = bytes(2, group);
  const compressed = deflateSync(primitive);
  const blob = Buffer.concat([uint(2, primitive.length), bytes(3, compressed)]);
  return frame('OSMData', blob);
};
const pbf = (...blocks: Buffer[]) => Buffer.concat([frame('OSMHeader', Buffer.from([0])), ...blocks]);
async function fixture(blocks: Buffer[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-index-errors-'));
  const source = path.join(root, 'source.pbf'); const index = path.join(root, 'index');
  await fs.writeFile(source, pbf(...blocks));
  return { root, source, index };
}
async function remove(root: string) { await fs.rm(root, { recursive: true, force: true }); }

describe('source block index corruption and drift boundaries', () => {
  it('skips objects without IDs, reads unpacked dense deltas and raw blobs, and attests an identical alternate source path', async () => {
    const emptyNode = bytes(1, Buffer.alloc(0));
    const dense = bytes(2, uint(1, Number(zig(17))));
    const primitive = bytes(2, Buffer.concat([bytes(1, emptyNode), dense]));
    expect(primitiveBlockRanges(primitive)).toMatchObject({
      node: { min: 17n, max: 17n }, way: { min: null, max: null }, relation: { min: null, max: null }
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-index-attestation-'));
    const source = path.join(root, 'source.pbf'); const alternate = path.join(root, 'copy.pbf'); const index = path.join(root, 'index');
    const rawBlob = bytes(1, primitive);
    try {
      await fs.writeFile(source, Buffer.concat([frame('OSMHeader', Buffer.from([0])), frame('OSMData', rawBlob)]));
      await fs.copyFile(source, alternate);
      await buildSourceBlockIndex(source, index);
      const opened = await openSourceBlockIndex(index, { sourcePbf: alternate });
      expect(opened.metadata.ranges.node.blocks).toBe(1);
      await opened.close();
      expect(JSON.parse(await fs.readFile(path.join(index, 'source-attestation.json'), 'utf8')).path).toBe(alternate);
    } finally { await remove(root); }
  });

  it('opens tracked indexes created for an empty shard manifest and closes both partitions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-index-empty-'));
    const data = path.join(root, 'generation'); const index = path.join(root, 'indexes');
    try {
      await fs.mkdir(data, { recursive: true });
      await fs.writeFile(path.join(data, 'manifest.json'), JSON.stringify({ generation: 'empty', shards: [] }));
      await buildTrackedIndexes(data, index, 2);
      const opened = await openTrackedIndexes(index);
      expect(opened.metadata).toMatchObject({ generation: 'empty', shardCount: 0, partitions: 2 });
      await expect(opened.cells.get('node:1')).resolves.toEqual([]);
      opened.close();
    } finally { await remove(root); }
  });

  it('rejects truncated protobuf varints, oversized fields, and unsupported wire types', () => {
    expect(() => primitiveBlockRanges(Buffer.from([0x80]))).toThrow(/truncated protobuf varint/);
    expect(() => primitiveBlockRanges(Buffer.from([0x0a, 0x05, 0x01]))).toThrow(/truncated protobuf field/);
    expect(() => primitiveBlockRanges(Buffer.from([0x0b]))).toThrow(/unsupported protobuf wire type 3/);
  });

  it('rejects short framing prefixes, oversized BlobHeaders, and missing OSMHeader blocks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-index-framing-'));
    const source = path.join(root, 'bad.pbf'); const index = path.join(root, 'index');
    try {
      await fs.writeFile(source, Buffer.from([0, 0]));
      await expect(buildSourceBlockIndex(source, index)).rejects.toThrow(/truncated PBF/);
      const tooBig = Buffer.alloc(4); tooBig.writeUInt32BE(65537);
      await fs.writeFile(source, tooBig);
      await expect(buildSourceBlockIndex(source, index)).rejects.toThrow(/invalid PBF header length/);
      await fs.writeFile(source, nodeBlock([1]));
      await expect(buildSourceBlockIndex(source, index)).rejects.toThrow(/no OSMHeader block/);
    } finally { await remove(root); }
  });

  it('rejects unsupported compression and a compressed Blob with the wrong raw_size', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-index-blob-'));
    const source = path.join(root, 'bad-blob.pbf'); const index = path.join(root, 'index');
    try {
      const header = frame('OSMHeader', Buffer.from([0]));
      const unsupported = frame('OSMData', Buffer.alloc(0));
      await fs.writeFile(source, Buffer.concat([header, unsupported]));
      await expect(buildSourceBlockIndex(source, index)).rejects.toThrow(/unsupported PBF Blob compression/);
      const primitive = bytes(2, Buffer.alloc(0)); const compressed = deflateSync(primitive);
      const malformedBlob = Buffer.concat([uint(2, primitive.length + 1), bytes(3, compressed)]);
      await fs.writeFile(source, Buffer.concat([header, frame('OSMData', malformedBlob)]));
      await expect(buildSourceBlockIndex(source, index)).rejects.toThrow(/raw_size mismatch/);
    } finally { await remove(root); }
  });

  it('rejects disordered type ranges while locating an absent ID across ordered ranges', async () => {
    const good = await fixture([nodeBlock([10, 20]), nodeBlock([30, 40])]);
    try {
      await buildSourceBlockIndex(good.source, good.index);
      const source = await openSourceBlockIndex(good.index);
      try {
        expect(await source.resolveBlockOffsets([{ type: 'node', id: 1 }, { type: 'node', id: 25 }])).toEqual([]);
        await expect(source.resolveObjects([{ type: 'node', id: 999 }], { tempDir: good.root }))
          .resolves.toMatchObject({ objects: [], missing: [{ type: 'node', id: 999 }] });
        await expect(source.resolveObjects([{ type: 'node', id: 10 }], { maxRequests: 0, tempDir: good.root }))
          .rejects.toThrow(/batch exceeds 0 objects/);
        await expect(source.resolveObjects([{ type: 'node', id: 10 }], { maxCandidateBytes: 1, tempDir: good.root }))
          .rejects.toThrow(/candidate blocks require/);
      } finally { await source.close(); }
    } finally { await remove(good.root); }

    const bad = await fixture([nodeBlock([30]), nodeBlock([10])]);
    try {
      await buildSourceBlockIndex(bad.source, bad.index);
      const source = await openSourceBlockIndex(bad.index);
      try { await expect(source.resolveBlockOffsets([{ type: 'node', id: 10 }])).rejects.toThrow(/not monotone/); }
      finally { await source.close(); }
    } finally { await remove(bad.root); }
  });

  it('rejects a supplied build fingerprint mismatch and catches source size drift on open', async () => {
    const test = await fixture([nodeBlock([15])]);
    try {
      await expect(buildSourceBlockIndex(test.source, test.index, { sourceFingerprint: 'wrong' }))
        .rejects.toThrow(/does not match the supplied source fingerprint/);
      await buildSourceBlockIndex(test.source, test.index);
      await fs.appendFile(test.source, Buffer.from([0]));
      await expect(openSourceBlockIndex(test.index)).rejects.toThrow(/source PBF changed/);
    } finally { await remove(test.root); }
  });
});
