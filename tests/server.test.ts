import ngeohash from 'ngeohash';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { AmenityEngine } from '../src/index/engine.js';
import { buildConfigHash, writeShard, type ShardElement } from '../src/index/shard.js';
import { Stats } from '../src/stats.js';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

const CELL = ngeohash.encode(35.05, 135.05, 5);

const elements: ShardElement[] = [
  {
    type: 'node', id: 100, version: 2, timestamp: 1760000000, changeset: 1,
    lat: 35.05, lon: 135.05, bbox: [35.05, 135.05, 35.05, 135.05],
    tags: { amenity: 'toilets' }, nodeIds: [], memberCoords: new Map(), members: []
  },
  {
    type: 'node', id: 200, version: 1, timestamp: 1760000000, changeset: 1,
    lat: 35.06, lon: 135.06, bbox: [35.06, 135.06, 35.06, 135.06],
    tags: { amenity: 'drinking_water' }, nodeIds: [], memberCoords: new Map(), members: []
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

// Same form-body contract as Overpass-Proxy/src/tests/integration (URLSearchParams string).
const formBody = (query: string): string => new URLSearchParams({ data: query }).toString();

describe('server endpoints', () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'oam-server-'));
    const fsPromises = await import('node:fs/promises');
    await fsPromises.mkdir(path.join(dataDir, 'shards'), { recursive: true });
    const configHash = buildConfigHash({ amenities: ['toilets'], precision: 5 });
    await fsPromises.writeFile(
      path.join(dataDir, 'shards', `${CELL}.bin`),
      writeShard(CELL, elements, 7327518, configHash)
    );
    await fsPromises.writeFile(
      path.join(dataDir, 'manifest.json'),
      JSON.stringify({ totalElements: 2 })
    );
    await fsPromises.writeFile(
      path.join(dataDir, 'state.json'),
      JSON.stringify({
        lastSeq: 7327518,
        lastUpdate: '2026-10-14T09:00:00Z',
        dataTimestamp: '2026-10-14T08:59:00Z'
      })
    );

    const config = loadConfig({ OSM_AMENITY_DATA_DIR: dataDir, OSM_AMENITY_AMENITIES: 'toilets' });
    const engine = new AmenityEngine(
      { dataDir, shardPrecision: 5, cacheMb: 1, generator: 'osm-amenity-overpass-server' },
      buildLogger('errors')
    );
    app = await buildServer({
      config,
      engine,
      stats: new Stats(),
      logger: buildLogger('errors'),
      serverVersion: 'osm-amenity-overpass-server'
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers the proxy tile query with 200 JSON elements', async () => {
    const res = await request(app.server).post('/api/interpreter').send(formBody(TILE_QUERY));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(typeof res.headers.etag).toBe('string');
    const body = res.body as { version: number; elements: Array<{ id: number }> };
    expect(body.version).toBe(0.6);
    expect(body.elements.map((e) => e.id)).toEqual([100]);
  });

  it('answers out-of-scope queries with 501', async () => {
    const res = await request(app.server)
      .post('/api/interpreter')
      .send(formBody('node["amenity"="parking"](35.04,135.04,35.07,135.07);out;'));
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'out of scope' });
  });

  it('answers non-amenity queries with 501', async () => {
    const res = await request(app.server)
      .post('/api/interpreter')
      .send(formBody('node["highway"="residential"](35.04,135.04,35.07,135.07);out;'));
    expect(res.status).toBe(501);
  });

  it('answers a missing query with 400', async () => {
    const res = await request(app.server).post('/api/interpreter').send(formBody('   '));
    expect(res.status).toBe(400);
  });

  it('reports conformant status with osm_osm_change', async () => {
    const res = await request(app.server).get('/api/status');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.version).toBe('osm-amenity-overpass-server');
    expect(body.osm_osm_change).toBe('7327518');
    expect(typeof body.memory_used).toBe('number');
    expect(body.output_format).toBe('JSON');
    expect(body.localEngine).toBeDefined();
    expect(body.localEngine.lastSeq).toBe(7327518);
    expect(body.localEngine.lastUpdate).toBe('2026-10-14T09:00:00Z');
    expect(body.localEngine.shards).toBe(1);
    expect(body.localEngine.elements).toBe(2);
    expect(body.localEngine.updateIntervalSeconds).toBe(3600);
  });

  it('reports osm_osm_change 0 without state', async () => {
    const dataDir2 = mkdtempSync(path.join(tmpdir(), 'oam-server-empty-'));
    try {
      const config = loadConfig({ OSM_AMENITY_DATA_DIR: dataDir2 });
      const engine = new AmenityEngine(
        { dataDir: dataDir2, shardPrecision: 5, cacheMb: 1, generator: 'test' },
        buildLogger('errors')
      );
      const app2 = await buildServer({
        config, engine, stats: new Stats(),
        logger: buildLogger('errors'), serverVersion: 'test'
      });
      try {
        const res = await app2.inject({ method: 'GET', url: '/api/status' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.osm_osm_change).toBe('0');
        expect(body.localEngine.lastSeq).toBeNull();
      } finally {
        await app2.close();
      }
    } finally {
      rmSync(dataDir2, { recursive: true, force: true });
    }
  });

  it('serves the data-sequence timestamp', async () => {
    const res = await request(app.server).get('/api/timestamp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toBe('2026-10-14T08:59:00Z');
  });

  it('answers kill_my_queries with a 200 no-op', async () => {
    const res = await request(app.server).post('/api/kill_my_queries');
    expect(res.status).toBe(200);
  });

  it('answers HEAD on the base url with 2xx (recovery probe)', async () => {
    const res = await request(app.server).head('/');
    expect(res.status).toBe(200);
    const res2 = await request(app.server).head('/api/status');
    expect(res2.status).toBe(200);
  });
});
