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

describe('writeShard/readShard', () => {
  it('roundtrips nodes, ways, relations with tags and indexes', () => {
    const elements = buildElements();
    const buffer = writeShard('wtf20', elements, 7327518, CONFIG_HASH);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('OAM1');

    const parsed = readShard(buffer);
    expect(parsed.header.geohash).toBe('wtf20');
    expect(parsed.header.formatVersion).toBe(1);
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
