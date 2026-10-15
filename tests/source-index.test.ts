import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { buildSourceBlockIndex, openSourceBlockIndex, primitiveBlockRanges, buildTrackedIndexes } from '../scripts/extract/source-index.mjs';
import { buildConfigHash, writeShard } from '../src/index/shard.js';
import { openPartitionedMultiIndex } from '../scripts/extract/storage.mjs';

const vi = (n: number | bigint): Buffer => {
  let x = BigInt(n); const out: number[] = [];
  while (x > 127n) { out.push(Number(x & 127n) | 128); x >>= 7n; }
  out.push(Number(x)); return Buffer.from(out);
};
const tag = (field: number, wire: number) => vi((field << 3) | wire);
const bytes = (field: number, value: Buffer) => Buffer.concat([tag(field, 2), vi(value.length), value]);
const uint = (field: number, value: number) => Buffer.concat([tag(field, 0), vi(value)]);
const zig = (n: number) => BigInt((n << 1) ^ (n >> 31));
const block = (type: string, payload: Buffer): Buffer => {
  const header = Buffer.concat([bytes(1, Buffer.from(type)), uint(3, payload.length)]);
  return Buffer.concat([Buffer.from([header.length >>> 24, header.length >>> 16, header.length >>> 8, header.length]), header, payload]);
};
const osmData = (primitive: Buffer) => {
  const blobData = deflateSync(primitive);
  const blob = Buffer.concat([uint(2, primitive.length), bytes(3, blobData)]);
  return block('OSMData', blob);
};

describe('PBF source block range index', () => {
  it('builds deduplicated bounded reverse edges only from tracked shard objects', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-idx-'));
    const data = path.join(root, 'generation'); const shards = path.join(data, 'shards'); const index = path.join(root, 'indexes');
    await fs.mkdir(shards, { recursive: true });
    const hash = buildConfigHash({ amenities: ['toilets'], precision: 5 });
    const node = { type: 'node' as const, id: 1, version: 1, timestamp: 1, changeset: 0, lat: 35, lon: 139, bbox: [35, 139, 35, 139] as [number, number, number, number], tags: {}, nodeIds: [], memberCoords: new Map(), members: [] };
    const way = { type: 'way' as const, id: 2, version: 1, timestamp: 1, changeset: 0, lat: 0, lon: 0, bbox: [35, 139, 35, 139] as [number, number, number, number], tags: {}, nodeIds: [1], memberCoords: new Map([[1, { lat: 35, lon: 139 }]]), members: [] };
    const relation = { type: 'relation' as const, id: 3, version: 1, timestamp: 1, changeset: 0, lat: 0, lon: 0, bbox: [35, 139, 35, 139] as [number, number, number, number], tags: {}, nodeIds: [], memberCoords: new Map(), members: [{ type: 'way' as const, ref: 2, role: 'outer' }] };
    await fs.writeFile(path.join(shards, 'abc.bin'), writeShard('abc', [node, way, relation], 0, hash));
    await fs.writeFile(path.join(shards, 'abd.bin'), writeShard('abd', [node, way, relation], 0, hash));
    await fs.writeFile(path.join(data, 'manifest.json'), JSON.stringify({ generation: 'test', shards: ['abc', 'abd'] }));
    try {
      const { partitions } = await buildTrackedIndexes(data, index);
      const parents = openPartitionedMultiIndex(path.join(index, 'reverse-parents'), partitions);
      const locations = openPartitionedMultiIndex(path.join(index, 'object-cells'), partitions);
      expect(await parents.get('node:1')).toEqual(['way:2']);
      expect(await parents.get('way:2')).toEqual(['relation:3']);
      expect((await locations.get('way:2')).sort()).toEqual(['abc', 'abd']);
      parents.close(); locations.close();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('indexes node, dense node, way and relation IDs and writes selected complete blocks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pbf-index-'));
    const pbf = path.join(root, 'fixture.pbf'); const index = path.join(root, 'index');
    // Node 10, dense node 20, way 30 and relation 40 in a single PBF data block.
    const node = uint(1, zig(10));
    const dense = bytes(1, Buffer.concat([vi(zig(20)), vi(zig(1))]));
    const way = uint(1, 30);
    const relation = uint(1, 40);
    const group = Buffer.concat([bytes(1, node), bytes(2, dense), bytes(3, way), bytes(4, relation)]);
    const primitive = Buffer.concat([bytes(1, Buffer.alloc(0)), bytes(2, group)]);
    await fs.writeFile(pbf, Buffer.concat([block('OSMHeader', Buffer.alloc(0)), osmData(primitive)]));
    try {
      const meta = await buildSourceBlockIndex(pbf, index);
      expect(meta.ranges.node.blocks).toBe(1);
      expect(meta.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const source = await openSourceBlockIndex(index);
      const subset = path.join(root, 'subset.pbf');
      expect(await source.resolveBlockOffsets([{ type: 'node', id: 21 }, { type: 'way', id: 30 }])).toHaveLength(1);
      expect(await source.writeSubset([{ type: 'relation', id: 40 }], subset)).toBe(1);
      await source.close();
      const subsetIndex = await openSourceBlockIndex(index);
      expect((await subsetIndex.resolveBlockOffsets([{ type: 'node', id: 10 }])).length).toBe(1);
      await subsetIndex.close();
      expect((await fs.stat(subset)).size).toBeGreaterThan(0);
      const original = await fs.readFile(pbf); original[original.length - 1] ^= 1;
      await fs.writeFile(pbf, original);
      await expect(openSourceBlockIndex(index)).rejects.toThrow(/fingerprint does not match/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('rejects malformed or non-monotone ID range data rather than guessing', () => {
    const dense = bytes(1, Buffer.concat([vi(zig(12)), vi(zig(5))]));
    const group = bytes(2, dense);
    const primitive = bytes(2, group);
    expect(primitiveBlockRanges(primitive).node).toEqual({ min: 12n, max: 17n });
  });

  it('resolves IDs from an osmium-generated real PBF candidate-block subset', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pbf-native-index-'));
    const xml = path.join(root, 'source.osm'); const pbf = path.join(root, 'source.pbf'); const index = path.join(root, 'index');
    await fs.writeFile(xml, `<?xml version="1.0"?><osm version="0.6" generator="test"><node id="101" version="1" lat="35" lon="139"><tag k="amenity" v="toilets"/></node><node id="14000000000" version="1" lat="35.1" lon="139.1"/><way id="201" version="1"><nd ref="101"/><nd ref="14000000000"/><tag k="highway" v="service"/></way><relation id="301" version="1"><member type="way" ref="201" role="outer"/><tag k="type" v="multipolygon"/></relation></osm>`);
    try {
      execFileSync('osmium', ['cat', xml, '-o', pbf]);
      await buildSourceBlockIndex(pbf, index);
      const source = await openSourceBlockIndex(index);
      try {
        const subsetCheck = path.join(root, 'manual-subset.pbf');
        await source.writeSubset([{ type: 'node', id: 101 }], subsetCheck);
        execFileSync('osmium', ['fileinfo', subsetCheck]);
        const ids = path.join(root, 'node.ids'); const out = path.join(root, 'node.osm'); await fs.writeFile(ids, '101\n');
        execFileSync('osmium', ['getid', subsetCheck, '-i', ids, '--default-type', 'node', '-o', out, '-f', 'osm']);
        const result = await source.resolveObjects([{ type: 'node', id: 101 }, { type: 'node', id: 14000000000 }, { type: 'way', id: 201 }, { type: 'relation', id: 301 }, { type: 'node', id: 102 }, { type: 'node', id: 999 }], { tempDir: root });
        expect(result.objects.map((o) => `${o.type}:${o.id}`).sort()).toEqual(['node:101', 'node:14000000000', 'relation:301', 'way:201']);
        expect(result.missing).toEqual([{ type: 'node', id: 102 }, { type: 'node', id: 999 }]);
      } finally { await source.close(); }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
