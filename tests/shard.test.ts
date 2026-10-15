import { describe, expect, it } from 'vitest';

import {
  buildConfigHash,
  crc32,
  readShard,
  verifyShard,
  writeShard,
  type ShardElement
} from '../src/index/shard.js';

const CONFIG_HASH = buildConfigHash({ amenities: ['toilets'], precision: 5 });

const mkNode = (id: number, lat: number, lon: number, amenity: string): ShardElement => ({
  type: 'node',
  id,
  version: 2,
  timestamp: 1760000000,
  changeset: 12345678,
  lat,
  lon,
  bbox: [lat, lon, lat, lon],
  tags: { amenity, building: 'yes' },
  nodeIds: [],
  memberCoords: new Map(),
  members: []
});

const mkWay = (id: number, nodeIds: number[]): ShardElement => ({
  type: 'way',
  id,
  version: 1,
  timestamp: 1760000001,
  changeset: 42,
  lat: 0,
  lon: 0,
  bbox: [35.0, 135.0, 35.1, 135.1],
  tags: { amenity: 'toilets' },
  nodeIds,
  memberCoords: nodeIds
    .map((n, i) => [n, { lat: 35.0 + 0.001 * i, lon: 135.0 + 0.001 * i }] as const)
    .reduce((map, entry) => map.set(entry[0], { lat: entry[1].lat, lon: entry[1].lon }), new Map()),
  members: []
});

const mkRelation = (id: number): ShardElement => ({
  type: 'relation',
  id,
  version: 3,
  timestamp: 1760000002,
  changeset: 4242,
  lat: 0,
  lon: 0,
  bbox: [35.0, 135.0, 35.1, 135.1],
  tags: { amenity: 'toilets', name: 'R < WC > & Co' },
  nodeIds: [],
  memberCoords: new Map(),
  members: [
    { type: 'way', ref: 9001, role: 'outer' },
    { type: 'node', ref: 100, role: 'entrance' }
  ]
});

const buildElements = (): ShardElement[] => [
  mkNode(100, 35.05, 135.05, 'toilets'),
  mkNode(101, 35.06, 135.06, 'drinking_water'),
  mkWay(9001, [100, 101]),
  mkRelation(9101)
];

const rechecksumV2 = (buffer: Buffer): void => {
  buffer.writeUInt32LE(crc32(Buffer.concat([buffer.subarray(0, 74), buffer.subarray(78)])), 74);
};

describe('writeShard/readShard', () => {
  it('roundtrips nodes, ways, relations with tags and indexes', () => {
    const elements = buildElements();
    const buffer = writeShard('wtf20', elements, 7327518, CONFIG_HASH);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('OAM1');

    const parsed = readShard(buffer);
    expect(parsed.header.geohash).toBe('wtf20');
    expect(parsed.header.formatVersion).toBe(2);
    expect(parsed.header.elementCount).toBe(4);
    expect(parsed.header.buildSequence).toBe(7327518);
    expect(parsed.header.configHash).toBe(CONFIG_HASH.toString('hex'));

    const byId = new Map(parsed.elements.map((e) => [e.id, e]));
    expect(byId.get(100)?.tags).toEqual({ amenity: 'toilets', building: 'yes' });
    expect(byId.get(100)?.lat).toBeCloseTo(35.05, 6);
    expect(byId.get(9001)?.type).toBe('way');
    expect(byId.get(9001)?.nodeIds).toEqual([100, 101]);
    expect(byId.get(9001)?.memberCoords.get(100)).toEqual({
      lat: 35.0,
      lon: 135.0
    });
    expect(byId.get(9001)?.memberCoords.get(101)).toEqual({
      lat: 35.001,
      lon: 135.001
    });
    expect(byId.get(9101)?.type).toBe('relation');
    expect(byId.get(9101)?.members).toEqual([
      { type: 'way', ref: 9001, role: 'outer' },
      { type: 'node', ref: 100, role: 'entrance' }
    ]);
    expect(byId.get(9101)?.tags.name).toBe('R < WC > & Co');
    expect(byId.get(9101)?.changeset).toBe(4242);
  });

  it('roundtrips an empty shard', () => {
    const buffer = writeShard('abcde', [], 0, CONFIG_HASH);
    const parsed = readShard(buffer);
    expect(parsed.header.elementCount).toBe(0);
    expect(parsed.elements).toEqual([]);
  });

  it('roundtrips equal numeric IDs across element types without offset collisions', () => {
    const node = mkNode(77, 35.01, 135.01, 'toilets');
    const way = { ...mkWay(77, [1, 2]), tags: { amenity: 'toilets' } };
    const parsed = readShard(writeShard('wtf20', [node, way], 1, CONFIG_HASH));
    expect(parsed.elements.map((element) => [element.type, element.id])).toEqual([
      ['node', 77], ['way', 77]
    ]);
  });

  it('preserves valid way member coordinates at the equator and prime meridian', () => {
    const way = { ...mkWay(78, [1]), memberCoords: new Map([[1, { lat: 0, lon: 0 }]]) };
    const parsed = readShard(writeShard('s0000', [way], 1, CONFIG_HASH));
    expect(parsed.elements[0].memberCoords.get(1)).toEqual({ lat: 0, lon: 0 });
  });

  it('reads legacy version 1 indexes without a type byte', () => {
    const v2 = writeShard('wtf20', [mkNode(7, 35.1, 135.1, 'toilets')], 1, CONFIG_HASH);
    const idIndex = Number(v2.readBigUInt64LE(34));
    const count = v2.readUInt32LE(idIndex);
    const entriesStart = idIndex + 4;
    const oldIndex = Buffer.concat([
      v2.subarray(idIndex, entriesStart),
      ...Array.from({ length: count }, (_, i) => {
        const start = entriesStart + i * 13;
        return Buffer.concat([v2.subarray(start + 1, start + 13)]);
      }),
      v2.subarray(entriesStart + count * 13)
    ]);
    const v1 = Buffer.concat([v2.subarray(0, idIndex), oldIndex]);
    v1.writeUInt16LE(1, 4);
    v1.writeBigUInt64LE(v2.readBigUInt64LE(42) - BigInt(count), 42);
    v1.writeUInt32LE(crc32(v1.subarray(78)), 74);
    const parsed = readShard(v1);
    expect(parsed.header.formatVersion).toBe(1);
    expect(parsed.elements[0].id).toBe(7);
  });

  it('reads early v2 artifacts that used the payload-only CRC', () => {
    const legacyV2 = writeShard('wtf20', [mkNode(8, 35.1, 135.1, 'toilets')], 1, CONFIG_HASH);
    legacyV2.writeUInt32LE(crc32(legacyV2.subarray(78)), 74);
    expect(readShard(legacyV2).elements[0]).toMatchObject({ type: 'node', id: 8 });
  });

  it('keeps v1 zero-coordinate missing sentinel semantics while v2 preserves (0,0)', () => {
    const way = { ...mkWay(79, [1]), memberCoords: new Map([[1, { lat: 0, lon: 0 }]]) };
    const v2 = writeShard('s0000', [way], 1, CONFIG_HASH);
    const idIndex = Number(v2.readBigUInt64LE(34));
    const count = v2.readUInt32LE(idIndex);
    const entriesStart = idIndex + 4;
    const oldIndex = Buffer.concat([
      v2.subarray(idIndex, entriesStart),
      ...Array.from({ length: count }, (_, i) => {
        const start = entriesStart + i * 13;
        return Buffer.concat([v2.subarray(start + 1, start + 13)]);
      }),
      v2.subarray(entriesStart + count * 13)
    ]);
    const v1 = Buffer.concat([v2.subarray(0, idIndex), oldIndex]);
    v1.writeUInt16LE(1, 4);
    v1.writeBigUInt64LE(v2.readBigUInt64LE(42) - BigInt(count), 42);
    const poolCount = v1.readUInt16LE(78);
    let wayStart = 80;
    for (let i = 0; i < poolCount; i += 1) wayStart += 2 + v1.readUInt16LE(wayStart);
    const tagCount = v1.readUInt16LE(wayStart + 49);
    const coordsAt = wayStart + 51 + 4 * tagCount + 2 + 8;
    v1.writeInt32LE(0, coordsAt);
    v1.writeInt32LE(0, coordsAt + 4);
    v1.writeUInt32LE(crc32(v1.subarray(78)), 74);
    expect(readShard(v2).elements[0].memberCoords.get(1)).toEqual({ lat: 0, lon: 0 });
    expect(readShard(v1).elements[0].memberCoords.has(1)).toBe(false);
  });

  it('verifies valid shards and rejects tampered ones', () => {
    const buffer = writeShard('wtf20', buildElements(), 1, CONFIG_HASH);
    expect(verifyShard(buffer)).toBe(true);

    const tampered = Buffer.from(buffer);
    tampered[tampered.length - 1] ^= 0xff;
    expect(verifyShard(tampered)).toBe(false);

    expect(verifyShard(Buffer.alloc(78, 0x41))).toBe(false); // bad magic
  });

  it('rejects a 16-byte config hash mismatch', () => {
    expect(() => writeShard('wtf20', [], 0, Buffer.alloc(15))).toThrow(/16 bytes/);
  });

  it('detects header tampering and a zero element count hiding real records', () => {
    const original = writeShard('wtf20', [mkNode(1, 35, 139, 'toilets')], 1, CONFIG_HASH);
    const headerTamper = Buffer.from(original);
    headerTamper.writeUInt32LE(0, 22);
    expect(() => readShard(headerTamper)).toThrow(/CRC mismatch/);

    const falseEmpty = Buffer.from(original);
    falseEmpty.writeUInt32LE(0, 22);
    rechecksumV2(falseEmpty);
    expect(() => readShard(falseEmpty)).toThrow(/record section does not end|id index count/);
  });

  it('rejects malformed offsets and mismatched id-index entries even with a valid CRC', () => {
    const original = writeShard('wtf20', [mkNode(11, 35, 139, 'toilets')], 1, CONFIG_HASH);
    const badHeader = Buffer.from(original);
    badHeader.writeBigUInt64LE(79n, 26);
    rechecksumV2(badHeader);
    expect(() => readShard(badHeader)).toThrow(/header offsets/);

    const badIndex = Buffer.from(original);
    const indexAt = Number(badIndex.readBigUInt64LE(34));
    badIndex.writeBigUInt64LE(999n, indexAt + 5);
    rechecksumV2(badIndex);
    expect(() => readShard(badIndex)).toThrow(/id index entry/);
  });

  it('validates node-ref offsets and rejects unknown relation member type codes', () => {
    const elements = buildElements();
    const invalidRef = Buffer.from(writeShard('wtf20', elements, 1, CONFIG_HASH));
    const refStart = Number(invalidRef.readBigUInt64LE(42)) + 14;
    invalidRef.writeUInt32LE(0, refStart);
    rechecksumV2(invalidRef);
    expect(() => readShard(invalidRef)).toThrow(/node-ref offset/);

    const relation = { ...mkRelation(99), tags: {} };
    const badMemberType = Buffer.from(writeShard('wtf20', [relation], 1, CONFIG_HASH));
    const poolCount = badMemberType.readUInt16LE(78);
    let recordAt = 80;
    for (let i = 0; i < poolCount; i += 1) recordAt += 2 + badMemberType.readUInt16LE(recordAt);
    badMemberType[recordAt + 53] = 9; // base record, member count, then member type
    rechecksumV2(badMemberType);
    expect(() => readShard(badMemberType)).toThrow(/bad relation member type/);
  });

  it('rejects half-written v2 coordinate sentinels', () => {
    const way = { ...mkWay(80, [3]), memberCoords: new Map() };
    const malformed = Buffer.from(writeShard('s0000', [way], 1, CONFIG_HASH));
    const poolCount = malformed.readUInt16LE(78);
    let recordAt = 80;
    for (let i = 0; i < poolCount; i += 1) recordAt += 2 + malformed.readUInt16LE(recordAt);
    const tagCount = malformed.readUInt16LE(recordAt + 49);
    const coordinateAt = recordAt + 51 + 4 * tagCount + 2 + 8;
    malformed.writeInt32LE(-0x80000000, coordinateAt);
    malformed.writeInt32LE(0, coordinateAt + 4);
    rechecksumV2(malformed);
    expect(() => readShard(malformed)).toThrow(/coordinate sentinel/);
  });

  it('rejects writer values that cannot be represented in OAM fields', () => {
    expect(() => writeShard('wtf20', [{ ...mkNode(1, 35, 139, 'toilets'), id: Number.MAX_SAFE_INTEGER + 1 }], 1, CONFIG_HASH)).toThrow(/element id/);
    expect(() => writeShard('wtf20', [{ ...mkNode(1, 35, 139, 'toilets'), version: -1 }], 1, CONFIG_HASH)).toThrow(/element version/);
    expect(() => writeShard('wtf20', [{ ...mkNode(1, 35, 139, 'toilets'), tags: { name: 'x'.repeat(65536) } }], 1, CONFIG_HASH)).toThrow(/u16 UTF-8 length/);
    const maxPoolTags = Object.fromEntries(Array.from({ length: 32768 }, (_, i) => [`k${i}`, `v${i}`]));
    expect(() => writeShard('wtf20', [{ ...mkNode(1, 35, 139, 'toilets'), tags: maxPoolTags }], 1, CONFIG_HASH)).toThrow(/string pool exceeds u16/);
    expect(() => writeShard('wtf20', [{ ...mkNode(1, 35, 139, 'toilets'), tags: Object.fromEntries(Array.from({ length: 65536 }, (_, i) => [`k${i}`, 'v'])) }], 1, CONFIG_HASH)).toThrow(/tag count exceeds u16/);
    expect(() => writeShard('wtf20', [mkWay(2, Array.from({ length: 65536 }, (_, i) => i + 1))], 1, CONFIG_HASH)).toThrow(/node count exceeds u16/);
    expect(() => writeShard('wtf20', [{ ...mkRelation(3), members: Array.from({ length: 65536 }, (_, i) => ({ type: 'node', ref: i + 1, role: '' })) }], 1, CONFIG_HASH)).toThrow(/member count exceeds u16/);
  });
});

describe('crc32', () => {
  it('matches the known check value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('buildConfigHash', () => {
  it('is key-order independent and 16 bytes', () => {
    const a = buildConfigHash({ b: 2, a: 1 });
    const b = buildConfigHash({ a: 1, b: 2 });
    const c = buildConfigHash({ a: 1, b: 3 });
    expect(a.length).toBe(16);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});
