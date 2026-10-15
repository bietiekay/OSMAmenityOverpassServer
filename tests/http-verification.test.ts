import ngeohash from 'ngeohash';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { AmenityEngine } from '../src/index/engine.js';
import { buildConfigHash, writeShard } from '../src/index/shard.js';
import { buildLogger } from '../src/logger.js';
import { Stats } from '../src/stats.js';
import { buildServer } from '../src/server.js';
import { verifyHttp } from '../scripts/verify-http.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('real HTTP verification helper', () => {
  it('checks GET, POST, JSON/XML, ETag, errors, status and HEAD against a listening server', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'oam-http-verify-'));
    dirs.push(dataDir);
    await fs.mkdir(path.join(dataDir, 'shards'));
    const node = {
      type: 'node' as const, id: 123, version: 2, timestamp: 1760000000, changeset: 7,
      lat: 35.682, lon: 139.766, bbox: [35.682, 139.766, 35.682, 139.766] as [number, number, number, number],
      tags: { amenity: 'toilets', wheelchair: 'yes' }, nodeIds: [], memberCoords: new Map(), members: []
    };
    const cell = ngeohash.encode(node.lat, node.lon, 5);
    const hash = buildConfigHash({ amenities: ['toilets'], precision: 5 });
    await fs.writeFile(path.join(dataDir, 'shards', `${cell}.bin`), writeShard(cell, [node], 100, hash));
    await fs.writeFile(path.join(dataDir, 'manifest.json'), JSON.stringify({
      configHash: hash.toString('hex'), shards: [cell], totalElements: 1
    }));
    await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
      dataTimestamp: '2026-10-15T00:00:00Z', lastSeq: 100,
      replication: { kind: 'planet', interval: 'minute', sequenceNumber: 100 }
    }));

    const config = loadConfig({ OSM_AMENITY_DATA_DIR: dataDir });
    const app = await buildServer({
      config,
      engine: new AmenityEngine({ dataDir, shardPrecision: 5, cacheMb: 1, generator: 'test' }, buildLogger('errors')),
      stats: new Stats(), logger: buildLogger('errors'), serverVersion: 'test'
    });
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const result = await verifyHttp({
        url: address,
        expectedNodes: [{
          type: 'node', id: 123, lat: 35.682, lon: 139.766,
          tags: { amenity: 'toilets', wheelchair: 'yes' },
          version: 2, timestamp: '2025-10-09T08:53:20Z'
        }]
      });
      expect(result).toMatchObject({ elements: 1, expectedNodes: 1 });
    } finally {
      await app.close();
    }
  });
});
