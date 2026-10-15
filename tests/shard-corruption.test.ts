import { describe, expect, it } from 'vitest';
import { buildConfigHash, crc32, readShard, verifyShard, writeShard, type ShardElement } from '../src/index/shard.js';

const configHash = buildConfigHash({ amenities: ['toilets'], precision: 5 });
const node = (id: number): ShardElement => ({
  type: 'node', id, version: 1, timestamp: 10, changeset: 3, lat: 35, lon: 139,
  bbox: [35, 139, 35, 139], tags: { amenity: 'toilets' }, nodeIds: [], memberCoords: new Map(), members: []
});
const way = (): ShardElement => ({
  type: 'way', id: 5, version: 1, timestamp: 10, changeset: 3, lat: 0, lon: 0,
  bbox: [35, 139, 35, 139], tags: {}, nodeIds: [9], memberCoords: new Map([[9, { lat: 35, lon: 139 }]]), members: []
});
const relation = (): ShardElement => ({
  type: 'relation', id: 7, version: 1, timestamp: 10, changeset: 3, lat: 0, lon: 0,
  bbox: [35, 139, 35, 139], tags: {}, nodeIds: [], memberCoords: new Map(),
  members: [{ type: 'way', ref: 5, role: 'outer' }]
});
const fixCrc = (buffer: Buffer) => buffer.writeUInt32LE(crc32(Buffer.concat([buffer.subarray(0, 74), buffer.subarray(78)])), 74);
const poolEnd = (buffer: Buffer) => {
  let at = 80;
  for (let i = 0; i < buffer.readUInt16LE(78); i++) at += 2 + buffer.readUInt16LE(at);
  return at;
};
const damaged = (buffer: Buffer, mutate: (copy: Buffer) => void) => {
  const copy = Buffer.from(buffer); mutate(copy); fixCrc(copy); return copy;
};

describe('shard structural corruption boundaries', () => {
  it('rejects truncated headers, bad magic, unknown versions and invalid section offsets', () => {
    const good = writeShard('abcde', [node(1)], 1, configHash);
    expect(() => readShard(Buffer.alloc(77))).toThrow(/too small/);
    const magic = Buffer.from(good); magic.write('BAD!', 0, 'ascii');
    expect(() => readShard(magic)).toThrow(/bad shard magic/);
    const version = Buffer.from(good); version.writeUInt16LE(8, 4);
    expect(() => readShard(version)).toThrow(/unsupported shard format version/);
    expect(() => readShard(damaged(good, b => b.writeBigUInt64LE(77n, 26)))).toThrow(/header offsets/);
  });

  it('rejects invalid UTF-8 pool lengths and tag indexes even after checksum repair', () => {
    const good = writeShard('abcde', [node(1)], 1, configHash); const record = poolEnd(good);
    expect(() => readShard(damaged(good, b => b.writeUInt16LE(0xffff, 80)))).toThrow(/section boundary/);
    expect(() => readShard(damaged(good, b => b.writeUInt16LE(0xffff, record + 51)))).toThrow(/tag index out of pool range/);
  });

  it('rejects unknown record types, zero IDs, duplicate identities and invalid node references', () => {
    const single = writeShard('abcde', [node(1)], 1, configHash); const record = poolEnd(single);
    expect(() => readShard(damaged(single, b => { b[record] = 77; }))).toThrow(/bad element type code/);
    expect(() => readShard(damaged(single, b => b.writeBigUInt64LE(0n, record + 1)))).toThrow(/element id must be positive/);
    const pair = writeShard('abcde', [node(1), node(2)], 1, configHash); const pairStart = poolEnd(pair);
    // One node record is 55 bytes here: fixed 49-byte body, one tag count and one key/value pair.
    expect(() => readShard(damaged(pair, b => b.writeBigUInt64LE(1n, pairStart + 55 + 1)))).toThrow(/duplicate element identity/);
    const w = writeShard('abcde', [way()], 1, configHash); const wayRecord = poolEnd(w);
    const nodeIdAt = wayRecord + 53;
    expect(() => readShard(damaged(w, b => b.writeBigUInt64LE(0n, nodeIdAt)))).toThrow(/way node id must be positive/);
  });

  it('rejects inconsistent and unsorted type-aware ID indexes', () => {
    const good = writeShard('abcde', [node(1), node(2)], 1, configHash);
    const idAt = Number(good.readBigUInt64LE(34));
    expect(() => readShard(damaged(good, b => b.writeUInt32LE(1, idAt)))).toThrow(/id index count/);
    expect(() => readShard(damaged(good, b => { b[idAt + 4] = 99; }))).toThrow(/bad id index type code/);
    expect(() => readShard(damaged(good, b => b.writeBigUInt64LE(1n, idAt + 4 + 13 + 1)))).toThrow(/id index is not strictly sorted/);
  });

  it('checks node-reference counts, nonempty edges, exact offsets, and absence of trailing bytes', () => {
    const good = writeShard('abcde', [way()], 1, configHash); const refAt = Number(good.readBigUInt64LE(42));
    expect(() => readShard(damaged(good, b => b.writeUInt32LE(2, refAt)))).toThrow(/node-ref index count mismatch/);
    expect(() => readShard(damaged(good, b => b.writeUInt16LE(0, refAt + 12)))).toThrow(/empty node-ref entry/);
    expect(() => readShard(damaged(good, b => b.writeBigUInt64LE(88n, refAt + 4)))).toThrow(/node-ref entries do not match/);
    const withRelation = writeShard('abcde', [way(), relation()], 1, configHash);
    const relRecord = poolEnd(withRelation) + 69;
    expect(() => readShard(damaged(withRelation, b => b.writeBigUInt64LE(0n, relRecord + 54)))).toThrow(/relation member ref must be positive/);
    const truncated = damaged(good, () => {}).subarray(0, good.length - 1); fixCrc(truncated);
    expect(() => readShard(truncated)).toThrow(/section boundary/);
    const trailing = Buffer.concat([good, Buffer.from([0])]); fixCrc(trailing);
    expect(() => readShard(trailing)).toThrow(/trailing or truncated node-ref index/);
    expect(verifyShard(Buffer.from('corrupt'))).toBe(false);
  });
});
