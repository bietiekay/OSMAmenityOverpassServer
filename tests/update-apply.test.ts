import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { encodeElement } from '../scripts/extract/lines.mjs';
import { buildIndex } from '../scripts/extract/assembly.mjs';
import { applyDiffGeneration } from '../scripts/update/apply-generation.mjs';
import { IndexDatabase } from '../src/index/database.js';
import { databaseElements } from './database-helpers.js';

describe('incremental generation updates', () => {
  it('recomputes dependent relation geometry when an unchanged-version member node moves', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-apply-'));
    const pbf = path.join(root, 'source.pbf'); const xml = path.join(root, 'source.osm');
    await fs.writeFile(xml, `<?xml version="1.0"?><osm version="0.6"><node id="1" version="1" timestamp="2026-10-14T00:00:00Z" lat="35" lon="139"/><node id="2" version="1" timestamp="2026-10-14T00:00:00Z" lat="35.01" lon="139.01"/><node id="3" version="1" timestamp="2026-10-14T00:00:00Z" lat="35.005" lon="139.005"/><way id="10" version="1" timestamp="2026-10-14T00:00:00Z"><nd ref="1"/><nd ref="2"/></way><relation id="20" version="1" timestamp="2026-10-14T00:00:00Z"><member type="way" ref="10" role="outer"/><member type="node" ref="3" role="label"/><tag k="amenity" v="toilets"/></relation><relation id="21" version="1" timestamp="2026-10-14T00:00:00Z"><member type="way" ref="10" role="outer"/><tag k="amenity" v="toilets"/></relation></osm>`);
    execFileSync('osmium', ['cat', xml, '-o', pbf]);
    const sourcePbfBytes = await fs.readFile(pbf);
    const wrongPbfBytes = Buffer.from(sourcePbfBytes); wrongPbfBytes[wrongPbfBytes.length - 1] ^= 1;
    for (const stage of ['stage1', 'stage2', 'stage3']) await fs.mkdir(path.join(root, 'work', stage), { recursive: true });
    const put = async (stage: string, name: string, rows: object[]) => fs.writeFile(path.join(root, 'work', stage, name), `${rows.map((row) => encodeElement(row as never)).join('\n')}\n`);
    await put('stage1', 'amen_c0000.lines', [
      { type: 'relation', id: 20, version: 1, timestamp: 1791936000, members: [{ type: 'way', ref: 10, role: 'outer' }, { type: 'node', ref: 3, role: 'label' }], tags: { amenity: 'toilets' } },
      { type: 'relation', id: 21, version: 1, timestamp: 1791936000, members: [{ type: 'way', ref: 10, role: 'outer' }], tags: { amenity: 'toilets' } }
    ]);
    await put('stage2', 'ways_c0000.lines', [{ type: 'way', id: 10, version: 1, timestamp: 1791936000, nodeIds: [1, 2], tags: {} }]);
    await put('stage3', 'nodes_c0000.lines', [
      { type: 'node', id: 1, version: 1, timestamp: 1791936000, lat: 35, lon: 139, tags: {} },
      { type: 'node', id: 2, version: 1, timestamp: 1791936000, lat: 35.01, lon: 139.01, tags: {} },
      { type: 'node', id: 3, version: 1, timestamp: 1791936000, lat: 35.005, lon: 139.005, tags: {} }
    ]);
    try {
      const sourceFingerprint = createHash('sha256').update(sourcePbfBytes).digest('hex');
      await buildIndex({ pipelineDir: root, source: pbf, sourceFingerprint, amenities: ['toilets'], shardPrecision: 5, sourceTimestamp: '2026-10-14T00:00:00Z', replication: { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day', sequenceNumber: 5 } });
      const oldGeneration = await fs.realpath(path.join(root, 'data'));
      const oldManifest = JSON.parse(await fs.readFile(path.join(oldGeneration, 'manifest.json'), 'utf8'));
      const diff = path.join(root, '006.osc.gz');
      await fs.writeFile(diff, gzipSync('<osmChange version="0.6"><create><node id="4" version="1" timestamp="2026-10-15T00:00:00Z" lat="34.99" lon="138.99"/></create><modify><node id="1" version="2" timestamp="2026-10-15T00:00:00Z" lat="35.1" lon="139.1"/></modify><modify><way id="10" version="2" timestamp="2026-10-15T00:00:00Z"><nd ref="1"/><nd ref="4"/></way></modify></osmChange>'));
      await fs.writeFile(pbf, wrongPbfBytes);
      await expect(applyDiffGeneration(root, diff, { sequence: 6, dataTimestamp: '2026-10-15T00:00:00Z', replication: { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day' }, amenities: ['toilets'], shardPrecision: 5 })).rejects.toThrow();
      expect(await fs.stat(path.join(root, 'update-cache', `source-${sourceFingerprint}`, 'index.json')).catch(() => null)).toBeNull();
      await fs.writeFile(pbf, sourcePbfBytes);
      const result = await applyDiffGeneration(root, diff, { sequence: 6, dataTimestamp: '2026-10-15T00:00:00Z', replication: { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day' }, amenities: ['toilets'], shardPrecision: 5 });
      expect(result.sequence).toBe(6);
      expect(await fs.realpath(path.join(root, 'data'))).toBe(oldGeneration);
      expect(JSON.parse(await fs.readFile(path.join(root, 'data/state.json'), 'utf8'))).toMatchObject({ lastSeq: 0, replication: { sequenceNumber: 6 } });
      expect(JSON.parse(await fs.readFile(path.join(root, 'data/manifest.json'), 'utf8')).totalElements).toBe(oldManifest.totalElements);
      await expectActiveCounts(root);
      const relation = databaseElements(path.join(root, 'data')).find(e => e.type === 'relation' && e.id === 20);
      expect(relation?.bbox[0]).toBeCloseTo(34.99);
      expect(relation?.bbox[1]).toBeCloseTo(138.99);
      expect(relation?.bbox[2]).toBeCloseTo(35.1);
      expect(relation?.bbox[3]).toBeCloseTo(139.1);
      const helperWay = databaseElements(path.join(root, 'data')).find(e => e.type === 'way' && e.id === 10);
      expect(helperWay?.memberCoords.get(4)).toEqual({ lat: 34.99, lon: 138.99 });
      await expect(fs.stat(path.join(oldGeneration, 'index.sqlite'))).resolves.toBeDefined();
      const generationAfterSix = await fs.realpath(path.join(root, 'data'));
      const retry = path.join(root, '007.osc.gz');
      await fs.writeFile(retry, gzipSync('<osmChange version="0.6"><modify><node id="1" version="3" timestamp="2026-10-16T00:00:00Z" lat="35.11" lon="139.11"/></modify></osmChange>'));
      await expect(applyDiffGeneration(root, retry, { sequence: 7, dataTimestamp: '2026-10-16T00:00:00Z', replication: { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day' }, amenities: ['toilets'], shardPrecision: 5, beforePublish: async () => { throw new Error('simulated pre-publish crash'); } })).rejects.toThrow(/simulated pre-publish crash/);
      expect(await fs.realpath(path.join(root, 'data'))).toBe(generationAfterSix);
      expect(JSON.parse(await fs.readFile(path.join(root, 'data/state.json'), 'utf8')).replication.sequenceNumber).toBe(6);
      const db = new IndexDatabase(path.join(root, 'data'), { readOnly: true });
      try { expect(db.getRaw('node:1')?.version).toBe(2); } finally { db.close(); }
      await applyDiffGeneration(root, retry, { sequence: 7, dataTimestamp: '2026-10-16T00:00:00Z', replication: { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day' }, amenities: ['toilets'], shardPrecision: 5 });
      expect(JSON.parse(await fs.readFile(path.join(root, 'data/state.json'), 'utf8'))).toMatchObject({ lastSeq: 0, replication: { sequenceNumber: 7 } });
      await expectActiveCounts(root);
      const deleted = path.join(root, '008.osc.gz');
      await fs.writeFile(deleted, gzipSync('<osmChange version="0.6"><delete><relation id="20" version="2" timestamp="2026-10-16T12:00:00Z"/></delete></osmChange>'));
      await applyDiffGeneration(root, deleted, { sequence: 8, dataTimestamp: '2026-10-16T12:00:00Z', replication: { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day' }, amenities: ['toilets'], shardPrecision: 5 });
      expect(JSON.parse(await fs.readFile(path.join(root, 'data/manifest.json'), 'utf8')).totalElements).toBe(1);
      await expectActiveCounts(root);
      const remaining = databaseElements(path.join(root, 'data'));
      expect(remaining.some((element) => element.type === 'relation' && element.id === 20)).toBe(false);
      expect(remaining.some((element) => element.type === 'relation' && element.id === 21)).toBe(true);
      expect(remaining.some((element) => element.type === 'way' && element.id === 10)).toBe(true);
      expect(remaining.some((element) => element.type === 'node' && element.id === 3)).toBe(false);
      const activeAfterEight = await fs.realpath(path.join(root, 'data'));
      const missing = path.join(root, '009.osc.gz');
      await fs.writeFile(missing, gzipSync('<osmChange version="0.6"><create><way id="30" version="1" timestamp="2026-10-17T00:00:00Z"><nd ref="999"/><tag k="amenity" v="toilets"/></way></create></osmChange>'));
      await expect(applyDiffGeneration(root, missing, { sequence: 9, dataTimestamp: '2026-10-17T00:00:00Z', replication: { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day' }, amenities: ['toilets'], shardPrecision: 5 })).rejects.toThrow(/missing references: node:999/);
      expect(await fs.realpath(path.join(root, 'data'))).toBe(activeAfterEight);
      expect(JSON.parse(await fs.readFile(path.join(root, 'data/state.json'), 'utf8')).replication.sequenceNumber).toBe(8);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 60000);
});

async function expectActiveCounts(root: string) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'data/manifest.json'), 'utf8'));
  const elements = databaseElements(path.join(root, 'data'));
  const main = elements.filter(e => e.tags.amenity === 'toilets');
  expect(manifest.totalElements).toBe(main.length);
  expect(manifest.counts).toMatchObject({ mainUnique: main.length, supportObjects: elements.length-main.length, shardRecords: elements.length, duplicatedRecords: 0 });
}
