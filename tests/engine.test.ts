import ngeohash from 'ngeohash';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildLogger } from '../src/logger.js';
import { parseAmenityQuery } from '../src/query.js';
import { AmenityEngine } from '../src/index/engine.js';
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
    writeFileSync(path.join(dataDir, 'manifest.json'), JSON.stringify({ totalElements: 4 }));
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
  });

  it('serves empty results for a bbox without the cell', async () => {
    const result = await engine.query(
      parseAmenityQuery(
        '[out:json]node["amenity"="toilets"](0.0,0.0,0.1,0.1);way["amenity"="toilets"](0.0,0.0,0.1,0.1);out body meta;'
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

  it('tracks cache hits after the first load', async () => {
    const before = engine.cacheHits;
    await engine.query(tileQuery());
    expect(engine.cacheHits).toBeGreaterThan(before);
  });

  it('reports shard counts from disk', async () => {
    expect(await engine.countShards()).toBe(1);
    expect(await engine.countElements()).toBe(4);
  });

  it('invalidates cached cells for affected updates', async () => {
    await engine.query(tileQuery()); // warm the cache
    const missesBefore = engine.cacheMisses;
    engine.invalidateCells([CELL]);
    await engine.query(tileQuery());
    expect(engine.cacheMisses).toBeGreaterThan(missesBefore);
  });
});
