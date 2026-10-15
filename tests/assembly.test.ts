import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../scripts/extract/assembly.mjs';
import { encodeElement } from '../scripts/extract/lines.mjs';
import { readShard } from '../src/index/shard.js';

describe('Stage 4 disk-backed assembly', () => {
  it('builds and activates a validated generation with main and support objects', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assembly-'));
    const dirs = ['stage1', 'stage2', 'stage3'].map((d) => path.join(root, 'work', d));
    await Promise.all(dirs.map((d) => fs.mkdir(d, { recursive: true })));
    const write = async (file: string, rows: object[]) => fs.writeFile(file, `${rows.map((r) => encodeElement(r as never)).join('\n')}\n`);
    await write(path.join(dirs[0], 'amen_c0000.lines'), [
      { type: 'node', id: 20, lat: 35.006, lon: 139.006, version: 2, timestamp: 1, changeset: 1, tags: { amenity: 'toilets' } },
      { type: 'way', id: 20, version: 1, timestamp: 1, changeset: 1, nodeIds: [1, 2], tags: { amenity: 'toilets' } },
      { type: 'relation', id: 30, version: 1, timestamp: 1, changeset: 1, members: [{ type: 'way', ref: 20, role: 'outer' }, { type: 'node', ref: 3, role: 'label' }], tags: { amenity: 'toilets' } },
      { type: 'relation', id: 31, version: 2, timestamp: 5, changeset: 7, members: [{ type: 'way', ref: 21, role: 'outer' }, { type: 'node', ref: 4, role: 'label' }], tags: { amenity: 'toilets' } }
    ]);
    await write(path.join(dirs[1], 'ways_c0000.lines'), [
      { type: 'way', id: 20, version: 1, timestamp: 1, changeset: 1, nodeIds: [1, 2], tags: { highway: 'service' } },
      { type: 'way', id: 21, version: 3, timestamp: 4, changeset: 6, nodeIds: [2, 4], tags: { highway: 'service' } }
    ]);
    await write(path.join(dirs[2], 'nodes_c0000.lines'), [
      { type: 'node', id: 1, lat: 35, lon: 139, tags: {} },
      { type: 'node', id: 2, lat: 35.01, lon: 139.01, tags: {} },
      { type: 'node', id: 3, lat: 35.005, lon: 139.005, tags: {} },
      { type: 'node', id: 4, lat: 35.008, lon: 139.008, version: 8, timestamp: 9, changeset: 12, tags: { name: 'labeled node' } }
    ]);
    try {
      const manifest = await buildIndex({ pipelineDir: root, source: 'fixture.pbf', amenities: ['toilets'], shardPrecision: 5, sourceTimestamp: '2026-01-01T00:00:00Z' });
      expect(manifest.counts.mainUnique).toBe(4);
      expect(manifest.shardCount).toBeGreaterThan(0);
      const active = path.join(root, 'data');
      expect((await fs.lstat(active)).isSymbolicLink()).toBe(true);
      const shards = await Promise.all((await fs.readdir(path.join(active, 'shards'))).filter((name) => name.endsWith('.bin')).map(async (name) => readShard(await fs.readFile(path.join(active, 'shards', name)))));
      const elements = shards.flatMap((s) => s.elements);
      expect(elements.some((e) => e.type === 'relation' && e.id === 30)).toBe(true);
      expect(elements.some((e) => e.type === 'way' && e.id === 20)).toBe(true);
      expect(elements.some((e) => e.type === 'node' && e.id === 20)).toBe(true);
      const mainWay = elements.find((e) => e.type === 'way' && e.id === 20);
      expect(mainWay?.memberCoords.size).toBe(2);
      const helperWay = elements.find((e) => e.type === 'way' && e.id === 21);
      expect(helperWay?.memberCoords.size).toBe(2);
      expect(helperWay?.memberCoords.get(4)).toEqual({ lat: 35.008, lon: 139.008 });
      const helperNode = elements.find((e) => e.type === 'node' && e.id === 4);
      expect(helperNode).toMatchObject({ version: 8, timestamp: 9, changeset: 12, tags: { name: 'labeled node' } });
      expect(elements.some((e) => e.type === 'node' && e.id === 3)).toBe(true);
      const sameBuild = await buildIndex({ pipelineDir: root, source: 'fixture.pbf', amenities: ['toilets'], shardPrecision: 5, sourceTimestamp: '2026-01-01T00:00:00Z' });
      expect(sameBuild.generation).toBe(manifest.generation);
      const oldGeneration = await fs.realpath(active);
      const activeLink = await fs.readlink(active);
      const candidate = await buildIndex({ pipelineDir: root, source: 'fixture.pbf', amenities: ['toilets'], shardPrecision: 5, sourceTimestamp: '2026-01-01T00:00:00Z', publish: false });
      expect(candidate.manifest.generation).not.toBe(manifest.generation);
      expect(await fs.realpath(candidate.generationDir)).toBe(candidate.generationDir);
      expect(await fs.readlink(active)).toBe(activeLink);
      const reindexed = await buildIndex({ pipelineDir: root, source: 'fixture.pbf', amenities: ['drinking_water'], shardPrecision: 5, sourceTimestamp: '2026-01-01T00:00:00Z' });
      expect(reindexed.counts.mainUnique).toBe(0);
      expect(await fs.readdir(path.join(active, 'shards'))).toEqual([]);
      await expect(fs.stat(oldGeneration)).resolves.toBeDefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('rejects missing member coordinates without activating a partial generation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assembly-missing-'));
    const dirs = ['stage1', 'stage2', 'stage3'].map((d) => path.join(root, 'work', d));
    await Promise.all(dirs.map((d) => fs.mkdir(d, { recursive: true })));
    await fs.writeFile(path.join(dirs[0], 'amen_c0000.lines'), `${encodeElement({ type: 'way', id: 1, nodeIds: [404], tags: { amenity: 'toilets' } })}\n`);
    await fs.writeFile(path.join(dirs[2], 'nodes_c0000.lines'), '');
    try {
      await expect(buildIndex({ pipelineDir: root, amenities: ['toilets'], shardPrecision: 5 })).rejects.toThrow(/missing references/);
      await expect(fs.lstat(path.join(root, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('supports node-only input without node lookup files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assembly-node-'));
    const stage1 = path.join(root, 'work', 'stage1'); await fs.mkdir(stage1, { recursive: true });
    await fs.writeFile(path.join(stage1, 'amen_c0000.lines'), `${encodeElement({ type: 'node', id: 8, lat: 0, lon: 0, tags: { amenity: 'toilets' } })}\n`);
    try {
      const result = await buildIndex({ pipelineDir: root, amenities: ['toilets'], shardPrecision: 5, replication: { baseUrl: 'https://planet.example/minute', kind: 'planet', interval: 'minute', sequenceNumber: 7329040 } });
      expect(result.counts.mainUnique).toBe(1);
      const state = JSON.parse(await fs.readFile(path.join(await fs.realpath(path.join(root, 'data')), 'state.json'), 'utf8'));
      expect(state.lastSeq).toBe(7329040);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('keeps the active generation when missing references invalidate a rebuild', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assembly-atomic-'));
    const dirs = ['stage1', 'stage2', 'stage3'].map((d) => path.join(root, 'work', d));
    await Promise.all(dirs.map((d) => fs.mkdir(d, { recursive: true })));
    const amenPath = path.join(dirs[0], 'amen_c0000.lines');
    const nodePath = path.join(dirs[2], 'nodes_c0000.lines');
    await fs.writeFile(amenPath, `${encodeElement({ type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'toilets' } })}\n`);
    await fs.writeFile(nodePath, '');
    try {
      await buildIndex({ pipelineDir: root, amenities: ['toilets'], shardPrecision: 5 });
      const oldTarget = await fs.readlink(path.join(root, 'data'));
      await fs.writeFile(amenPath, `${encodeElement({ type: 'way', id: 1, nodeIds: [404], tags: { amenity: 'toilets' } })}\n`);
      await expect(buildIndex({ pipelineDir: root, amenities: ['toilets'], shardPrecision: 5 })).rejects.toThrow(/missing references/);
      expect(await fs.readlink(path.join(root, 'data'))).toBe(oldTarget);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('guards regional cursors under the activation lock when rebuilding a different config', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assembly-regional-'));
    const stage1 = path.join(root, 'work', 'stage1'); await fs.mkdir(stage1, { recursive: true });
    await fs.writeFile(path.join(stage1, 'amen_c0000.lines'), `${encodeElement({ type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'toilets' } })}\n`);
    try {
      await buildIndex({ pipelineDir: root, amenities: ['toilets'], shardPrecision: 5, replication: { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day', sequenceNumber: 4939 } });
      const active = await fs.realpath(path.join(root, 'data'));
      const statePath = path.join(active, 'state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      expect(state).toMatchObject({ lastSeq: 0, replication: { sequenceNumber: 4939, kind: 'regional', interval: 'day' } });
      state.replication.sequenceNumber = 4940;
      state.dataTimestamp = '2026-10-15T00:00:00.000Z';
      await fs.writeFile(statePath, `${JSON.stringify(state)}\n`);
      const activeLink = await fs.readlink(path.join(root, 'data'));
      await expect(buildIndex({ pipelineDir: root, amenities: ['drinking_water'], shardPrecision: 5, sourceTimestamp: '2026-10-15T00:00:00Z', replication: { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day', sequenceNumber: 4939 } })).rejects.toThrow(/older than active sequence/);
      expect(await fs.readlink(path.join(root, 'data'))).toBe(activeLink);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
