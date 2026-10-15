import ngeohash from 'ngeohash';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildLogger } from '../src/logger.js';
import { parseAmenityQuery } from '../src/query.js';
import { AmenityEngine, ShardCache } from '../src/index/engine.js';
import { buildConfigHash, writeShard, type ShardElement } from '../src/index/shard.js';

const CONFIG_HASH = buildConfigHash({ amenities: ['toilets'], precision: 5 });
const CELL = ngeohash.encode(35.05, 135.05, 5);

const elements: ShardElement[] = [
  {
    // in bbox, amenity=toilets
    type: 'node', id: 100, version: 2, timestamp: 1760000000, changeset: 1,
    lat: 35.05, lon: 135.05, bbox: [35.05, 135.05, 35.05, 135.05],
    tags: { amenity: 'toilets' }, nodeIds: [], memberCoords: new Map(), members: []
  },
  {
    // in bbox, different amenity value -> filtered out
    type: 'node', id: 200, version: 1, timestamp: 1760000000, changeset: 1,
    lat: 35.06, lon: 135.06, bbox: [35.06, 135.06, 35.06, 135.06],
    tags: { amenity: 'drinking_water' }, nodeIds: [], memberCoords: new Map(), members: []
  },
  {
    // toilets but outside the query bbox
    type: 'node', id: 300, version: 1, timestamp: 1760000000, changeset: 1,
    lat: 48.1, lon: 11.4, bbox: [48.1, 11.4, 48.1, 11.4],
    tags: { amenity: 'toilets' }, nodeIds: [], memberCoords: new Map(), members: []
  },
  {
    // way, amenity=toilets, element bbox intersects the query bbox
    type: 'way', id: 400, version: 1, timestamp: 1760000000, changeset: 1,
    lat: 0, lon: 0, bbox: [35.04, 135.04, 35.07, 135.07],
    tags: { amenity: 'toilets' },
    nodeIds: [100, 500],
    memberCoords: new Map([
      [100, { lat: 35.05, lon: 135.05 }],
      [500, { lat: 35.045, lon: 135.045 }]
    ]),
    members: []
  }
  ,{
    type: 'relation', id: 600, version: 2, timestamp: 1760000100, changeset: 5,
    lat: 0, lon: 0, bbox: [35.04, 135.04, 35.07, 135.07],
    tags: { amenity: 'toilets' }, nodeIds: [], memberCoords: new Map(),
    members: [
      { type: 'way', ref: 400, role: 'outer' },
      { type: 'node', ref: 100, role: 'entrance' }
    ]
  }
];

const TILE_QUERY = `[out:json][timeout:120];
(
  node["amenity"="toilets"](35.04,135.04,35.07,135.07);
  way["amenity"="toilets"](35.04,135.04,35.07,135.07);
);
out body meta;
 >;
out skel qt;`;

describe('AmenityEngine', () => {
  let dataDir: string;
  let engine: AmenityEngine;
  const logger = buildLogger('errors');

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'oam-engine-'));
    const shardDir = path.join(dataDir, 'shards');
    writeFileSync(path.join(dataDir, 'manifest.json'), JSON.stringify({
      totalElements: 5, configHash: CONFIG_HASH.toString('hex'), shards: [CELL]
    }));
    writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ dataTimestamp: '2026-10-15T00:00:00Z' }));
    const buffer = writeShard(CELL, elements, 7327518, CONFIG_HASH);
    const fd = await import('node:fs/promises');
    await fd.mkdir(shardDir, { recursive: true });
    await fd.writeFile(path.join(shardDir, `${CELL}.bin`), buffer);
    engine = new AmenityEngine(
      {
        dataDir,
        shardPrecision: 5,
        cacheMb: 1,
        generator: 'test',
        osmBaseTimestamp: '2026-10-14T00:00:00Z'
      },
      logger
    );
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const tileQuery = () =>
    parseAmenityQuery(TILE_QUERY) as NonNullable<ReturnType<typeof parseAmenityQuery>>;

  it('filters by value and bbox, dedupes, and includes members', async () => {
    const result = await engine.query(tileQuery());
    const parsed = JSON.parse(result.payload) as { elements: Array<{ type: string; id: number }> };
    const ids = parsed.elements.map((e) => e.id).sort((a, b) => a - b);
    // main: node 100 + way 400; members: node 100 (deduped) + node 500
    expect(ids).toEqual([100, 400, 500]);
    expect(result.contentType).toBe('application/json');
    expect(result.etag).toMatch(/^".+"$/);
    expect(result.elementCount).toBe(3);
    expect(parsedRootTimestamp(result.payload)).toBe('2026-10-15T00:00:00Z');
  });

  it('serves empty results for a bbox without the cell', async () => {
    const result = await engine.query(
      parseAmenityQuery(
        '[out:json](node["amenity"="toilets"](0.0,0.0,0.1,0.1);way["amenity"="toilets"](0.0,0.0,0.1,0.1););out body meta;'
      ) as NonNullable<ReturnType<typeof parseAmenityQuery>>
    );
    const parsed = JSON.parse(result.payload) as { elements: unknown[] };
    expect(parsed.elements).toEqual([]);
  });

  it('serves xml output for non-json queries', async () => {
    const result = await engine.query(
      parseAmenityQuery(
        'node["amenity"="toilets"](35.04,135.04,35.07,135.07);out;'
      ) as NonNullable<ReturnType<typeof parseAmenityQuery>>
    );
    expect(result.contentType).toBe('text/xml');
    expect(result.payload).toContain('<osm version="0.6" generator="test">');
    expect(result.payload).toContain('<node id="100"');
  });

  it('honors tags, skel, and geom output forms', async () => {
    const tags = parseAmenityQuery('[out:json]node["amenity"="toilets"](35.04,135.04,35.07,135.07);out tags;')!;
    const tagsResult = JSON.parse((await engine.query(tags)).payload) as { elements: Array<Record<string, unknown>> };
    expect(tagsResult.elements[0]).toEqual({ type: 'node', id: 100, tags: { amenity: 'toilets' } });

    const skel = parseAmenityQuery('[out:json]way["amenity"="toilets"](35.04,135.04,35.07,135.07);out skel;')!;
    const skelResult = JSON.parse((await engine.query(skel)).payload) as { elements: Array<Record<string, unknown>> };
    expect(skelResult.elements[0]).toMatchObject({ type: 'way', id: 400, nodes: [100, 500] });
    expect(skelResult.elements[0]).not.toHaveProperty('tags');

    const geom = parseAmenityQuery('[out:json]way["amenity"="toilets"](35.04,135.04,35.07,135.07);out geom;')!;
    const geomResult = JSON.parse((await engine.query(geom)).payload) as { elements: Array<Record<string, unknown>> };
    expect(geomResult.elements[0]).toHaveProperty('geometry');
  });

  it('applies relation geom and member output clauses with node identity dedupe', async () => {
    const query = parseAmenityQuery(
      '[out:json](relation["amenity"="toilets"](35.04,135.04,35.07,135.07););out geom meta;>;out body meta;'
    );
    expect(query).not.toBeNull();
    const result = await engine.query(query as NonNullable<typeof query>);
    const elements = (JSON.parse(result.payload) as { elements: Array<Record<string, any>> }).elements;
    expect(elements.map((element) => `${element.type}:${element.id}`)).toEqual([
      'node:100', 'node:500', 'relation:600', 'way:400'
    ]);
    expect(elements.find((element) => element.type === 'relation')?.members[0].geometry).toEqual([
      { lat: 35.05, lon: 135.05, ref: 100 }, { lat: 35.045, lon: 135.045, ref: 500 }
    ]);
    expect(elements.find((element) => element.type === 'relation')?.members[1]).toMatchObject({
      type: 'node', ref: 100, lat: 35.05, lon: 135.05
    });
    expect(elements.find((element) => element.id === 100)?.tags.amenity).toBe('toilets');
    expect(elements.find((element) => element.type === 'way')?.tags.amenity).toBe('toilets');
  });

  it('tracks cache hits after the first load', async () => {
    const before = engine.cacheHits;
    await engine.query(tileQuery());
    expect(engine.cacheHits).toBeGreaterThan(before);
  });

  it('reports shard counts from disk', async () => {
    expect(await engine.countShards()).toBe(1);
    expect(await engine.countElements()).toBe(5);
  });

  it('invalidates cached cells for affected updates', async () => {
    await engine.query(tileQuery()); // warm the cache
    const missesBefore = engine.cacheMisses;
    engine.invalidateCells([CELL]);
    await engine.query(tileQuery());
    expect(engine.cacheMisses).toBeGreaterThan(missesBefore);
  });

  it('rejects a corrupt shard rather than returning a partial result', async () => {
    const file = path.join(dataDir, 'shards', `${CELL}.bin`);
    const good = await (await import('node:fs/promises')).readFile(file);
    const bad = Buffer.from(good); bad[bad.length - 1] ^= 0xff;
    const fs = await import('node:fs/promises');
    await fs.writeFile(file, bad);
    engine.invalidateCells([CELL]);
    await expect(engine.query(tileQuery())).rejects.toThrow(/shard verification failed/);
    await fs.writeFile(file, good);
    engine.invalidateCells([CELL]);
  });

  it('rejects a generation built for a different configured amenity set', async () => {
    engine.configureAmenities(['parking']);
    await expect(engine.query(tileQuery())).rejects.toThrow(/manifest config hash mismatch/);
    engine.configureAmenities(['toilets']);
  });

  it('fails when a generation manifest declares a missing shard', async () => {
    const fs = await import('node:fs/promises');
    await fs.rm(path.join(dataDir, 'shards', `${CELL}.bin`));
    engine.invalidateCells([CELL]);
    await expect(engine.query(tileQuery())).rejects.toThrow(/declared shard is missing/);
  });

  it('ignores valid shard files not declared by the generation manifest', async () => {
    const rogueCell = ngeohash.encode(35.25, 135.25, 5);
    const rogue = { ...elements[0]!, id: 999, lat: 35.25, lon: 135.25,
      bbox: [35.25, 135.25, 35.25, 135.25] as [number, number, number, number] };
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(dataDir, 'shards', `${rogueCell}.bin`),
      writeShard(rogueCell, [rogue], 7327518, CONFIG_HASH));
    try {
      const query = parseAmenityQuery(
        '[out:json]node["amenity"="toilets"](35.24,135.24,35.26,135.26);out;'
      )!;
      const result = JSON.parse((await engine.query(query)).payload) as { elements: Array<{ id: number }> };
      expect(result.elements).toEqual([]);
    } finally {
      await fs.rm(path.join(dataDir, 'shards', `${rogueCell}.bin`), { force: true });
    }
  });

  it('rejects a manifest without an explicit shard inventory', async () => {
    const file = path.join(dataDir, 'manifest.json');
    const fs = await import('node:fs/promises');
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, JSON.stringify({ configHash: CONFIG_HASH.toString('hex') }));
    try {
      await expect(engine.query(tileQuery())).rejects.toThrow(/declare its shard inventory/);
    } finally {
      await fs.writeFile(file, original);
    }
  });
});

describe('ShardCache', () => {
  it('refreshes LRU order, evicts old buffers, and drops entries', () => {
    const cache = new ShardCache(4);
    const a = Buffer.from('aa'); const b = Buffer.from('bb'); const c = Buffer.from('cc');
    cache.put('a', a); cache.put('b', b);
    expect(cache.get('a')).toBe(a);
    const a2 = Buffer.from('aa'); cache.put('a', a2);
    expect(cache.usageBytes()).toBe(4);
    cache.put('c', c);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(a2);
    cache.dropMatching((key) => key === 'c');
    expect(cache.get('c')).toBeUndefined();
    expect(cache.usageBytes()).toBe(2);
    cache.drop('a');
    expect(cache.usageBytes()).toBe(0);
    cache.dropAll();
    expect(cache.evictionCandidates()).toBe(0);
    expect(() => new ShardCache(0)).toThrow(/positive/);
  });
});

describe('generation metadata safety', () => {
  it('rejects partial, malformed and mismatched metadata and reports absent status counts', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oam-generation-errors-'));
    const fs = await import('node:fs/promises');
    const engine = new AmenityEngine({ dataDir: dir, shardPrecision: 5, cacheMb: 1, generator: 'test' }, buildLogger('errors'));
    const query = parseAmenityQuery('[out:json]node["amenity"="toilets"](35.04,135.04,35.07,135.07);out;')!;
    try {
      expect(await engine.countShards()).toBe(0);
      expect(await engine.countElements()).toBe(0);
      await expect(engine.query(query)).rejects.toThrow('not ready');
      await fs.writeFile(path.join(dir, 'state.json'), '{}');
      await expect(engine.query(query)).rejects.toThrow('both be present');
      await fs.writeFile(path.join(dir, 'manifest.json'), 'broken');
      await expect(engine.query(query)).rejects.toThrow('unreadable');
      await fs.writeFile(path.join(dir, 'manifest.json'), '[]');
      await expect(engine.query(query)).rejects.toThrow('JSON objects');
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ shards: [], counts: { mainUnique: 2, supportObjects: 3 } }));
      expect(await engine.countElements()).toBe(5);
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ shards: [], counts: { shardRecords: 8 } }));
      expect(await engine.countElements()).toBe(8);
      expect(JSON.parse((await engine.query(query)).payload).osm3s?.timestamp_osm_base).toBeUndefined();
      const fallback = new AmenityEngine({ dataDir: dir, shardPrecision: 5, cacheMb: 1, generator: 'test', osmBaseTimestamp: () => '2026-10-14T00:00:00Z' }, buildLogger('errors'));
      for (const output of ['json', 'xml'] as const) {
        const result = await fallback.query({ ...query, output, bbox: { south: 1, north: 0, west: 1, east: 0 } });
        expect(result.elementCount).toBe(0);
        expect(result.payload).toContain('2026-10-14T00:00:00Z');
      }
      await fs.mkdir(path.join(dir, 'shards'));
      await fs.writeFile(path.join(dir, 'shards', `${CELL}.bin`), writeShard(CELL, elements, 0, CONFIG_HASH));
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ shards: [CELL], configHash: 'wrong' }));
      await expect(engine.query(query)).rejects.toThrow('config hash mismatch');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

const parsedRootTimestamp = (payload: string): string | undefined =>
  (JSON.parse(payload) as { osm3s?: { timestamp_osm_base?: string } }).osm3s?.timestamp_osm_base;
