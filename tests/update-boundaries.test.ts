import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { encodeElement } from '../scripts/extract/lines.mjs';
import { buildIndex } from '../scripts/extract/assembly.mjs';
import { activateGeneration, withGenerationLock } from '../scripts/update/generation.mjs';
import { applyDiffBatchGeneration, applyDiffGeneration } from '../scripts/update/apply-generation.mjs';
import { databaseElements } from './database-helpers.js';
import { buildConfigHash, writeShard } from '../src/index/shard.js';

const replication = { baseUrl: 'https://planet.example/minute', kind: 'planet', interval: 'minute' };

async function createPipeline(root: string, withReplication = true) {
  const work = path.join(root, 'work');
  const stage1 = path.join(work, 'stage1'); await fs.mkdir(stage1, { recursive: true });
  const xml = path.join(root, 'source.osm'); const pbf = path.join(root, 'source.pbf');
  await fs.writeFile(xml, '<?xml version="1.0"?><osm version="0.6"><node id="1" version="2" timestamp="2026-10-14T00:00:00Z" lat="35.001" lon="139.001"><tag k="amenity" v="toilets"/></node><node id="2" version="1" timestamp="2026-10-14T00:00:00Z" lat="35.002" lon="139.002"/></osm>');
  execFileSync('osmium', ['cat', xml, '-o', pbf]);
  const bytes = await fs.readFile(pbf); const sourceFingerprint = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(stage1, 'amen_c0000.lines'), `${encodeElement({ type: 'node', id: 1, version: 2, timestamp: 1791936000, lat: 35.001, lon: 139.001, tags: { amenity: 'toilets' } })}\n`);
  await buildIndex({
    pipelineDir: root, source: pbf, sourceFingerprint, amenities: ['toilets'], shardPrecision: 5,
    sourceTimestamp: '2026-10-14T00:00:00Z',
    ...(withReplication ? { replication: { ...replication, sequenceNumber: 10 } } : {})
  });
  return { pbf, sourceFingerprint };
}

const writeDiff = async (root: string, body: string) => {
  const file = path.join(root, `diff-${Date.now()}-${Math.random()}.osc.gz`);
  await fs.writeFile(file, gzipSync(body));
  return file;
};
const options = (sequence: number) => ({ sequence, replication, amenities: ['toilets'], shardPrecision: 5 });

describe('generation and updater boundary guards', () => {
  it('rejects invalid sequence, namespace, baseline, config, override, batch and cancellation inputs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-guards-'));
    try {
      const { pbf } = await createPipeline(root);
      const diff = await writeDiff(root, '<osmChange version="0.6"/>');
      await expect(applyDiffGeneration(root, diff, options(0))).rejects.toThrow(/valid target sequence/);
      await expect(applyDiffBatchGeneration(root, [], { fromSequence: 11, toSequence: 10, ...options(10) })).rejects.toThrow(/diffFiles must contain/);
      await expect(applyDiffBatchGeneration(root, [diff, diff], { fromSequence: 11, toSequence: 11, ...options(11) })).rejects.toThrow(/sequence range/);
      await expect(applyDiffGeneration(root, diff, { ...options(11), replication: { ...replication, kind: 'regional', interval: 'day' } })).rejects.toThrow(/source descriptor/);
      await expect(applyDiffGeneration(root, diff, { ...options(11), amenities: ['drinking_water'] })).rejects.toThrow(/config does not match/);
      const abort = new AbortController(); abort.abort(new Error('caller canceled update'));
      await expect(applyDiffGeneration(root, diff, { ...options(11), signal: abort.signal })).rejects.toThrow(/caller canceled/);
      await expect(applyDiffGeneration(root, diff, { ...options(11), sourcePbf: pbf, sourcePbfFingerprint: 'wrong-fingerprint' })).rejects.toThrow(/override fingerprint/);
      await expect(applyDiffGeneration(root, diff, { ...options(11), diffFiles: [] })).rejects.toThrow(/at least one replication diff/);

      const noBaseline = path.join(root, 'no-baseline'); await fs.mkdir(noBaseline);
      await createPipeline(noBaseline, false);
      await expect(applyDiffGeneration(noBaseline, diff, options(1))).rejects.toThrow(/source descriptor/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('advances empty/stale diffs, removes a no-longer-main node, and builds a way from member coordinates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-version-'));
    try {
      const { pbf } = await createPipeline(root);
      const empty = await writeDiff(root, '<osmChange version="0.6"/>');
      const emptyResult = await applyDiffGeneration(root, empty, { ...options(11), sourcePbf: pbf });
      expect(emptyResult.changedCount).toBe(0);
      const stale = await writeDiff(root, '<osmChange version="0.6"><modify><node id="1" version="2" timestamp="2026-10-15T00:00:00Z" lat="35.5" lon="139.5"><tag k="amenity" v="toilets"/></node></modify></osmChange>');
      const staleResult = await applyDiffGeneration(root, stale, options(12));
      expect(staleResult.changedCount).toBe(0);
      const state = JSON.parse(await fs.readFile(path.join(root, 'data', 'state.json'), 'utf8'));
      expect(state.lastSeq).toBe(12);
      const removeAmenity = await writeDiff(root, '<osmChange version="0.6"><modify><node id="1" version="3" timestamp="2026-10-16T00:00:00Z" lat="35.001" lon="139.001"><tag k="name" v="former amenity"/></node></modify></osmChange>');
      const removed = await applyDiffGeneration(root, removeAmenity, options(13));
      expect(removed.changedCount).toBe(1);
      expect(JSON.parse(await fs.readFile(path.join(root, 'data', 'manifest.json'), 'utf8')).totalElements).toBe(0);
      const createWay = await writeDiff(root, '<osmChange version="0.6"><create><way id="5" version="1" timestamp="2026-10-17T00:00:00Z"><nd ref="1"/><nd ref="2"/><tag k="amenity" v="toilets"/></way></create></osmChange>');
      const created = await applyDiffGeneration(root, createWay, options(14));
      expect(created.changedCount).toBe(1);
      const manifest = JSON.parse(await fs.readFile(path.join(root, 'data', 'manifest.json'), 'utf8'));
      expect(manifest.totalElements).toBe(1);
      const elements = databaseElements(path.join(root, 'data'));
      const way = elements.find((element) => element.type === 'way' && element.id === 5);
      expect(way?.memberCoords.size).toBe(2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('applies a contiguous batch to an inactive candidate without publishing it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-candidate-batch-'));
    try {
      const { pbf, sourceFingerprint } = await createPipeline(root);
      const first = await writeDiff(root, '<osmChange version="0.6"/>');
      const second = await writeDiff(root, '<osmChange version="0.6"/>');
      const candidate = await buildIndex({ pipelineDir: root, source: pbf, sourceFingerprint, amenities: ['toilets'], shardPrecision: 5, sourceTimestamp: '2026-10-14T00:00:00Z', replication: { ...replication, sequenceNumber: 10 }, publish: false });
      const replay = await applyDiffBatchGeneration(root, [first], { fromSequence: 11, toSequence: 11, ...options(11), candidateGenerationDir: candidate.generationDir, sourcePbf: pbf });
      expect(replay.sequence).toBe(11);
      expect(JSON.parse(await fs.readFile(path.join(candidate.generationDir, 'state.json'), 'utf8')).lastSeq).toBe(11);
      expect(JSON.parse(await fs.readFile(path.join(root, 'data', 'state.json'), 'utf8')).lastSeq).toBe(10);
      const applied = await applyDiffBatchGeneration(root, [first, second], { fromSequence: 11, toSequence: 12, ...options(12), sourcePbf: pbf });
      expect(applied.sequence).toBe(12);
      expect(JSON.parse(await fs.readFile(path.join(root, 'data', 'state.json'), 'utf8')).lastSeq).toBe(12);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('coalesces repeated objects and updates each main object once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-parallel-'));
    try {
      await createPipeline(root);
      const first = await writeDiff(root, '<osmChange version="0.6"><modify><node id="1" version="3" timestamp="2026-10-15T00:00:00Z" lat="35.003" lon="139.003"><tag k="amenity" v="toilets"/></node></modify><create><node id="3" version="1" timestamp="2026-10-15T00:00:00Z" lat="35.004" lon="139.004"><tag k="amenity" v="toilets"/></node></create></osmChange>');
      const second = await writeDiff(root, '<osmChange version="0.6"><modify><node id="1" version="4" timestamp="2026-10-16T00:00:00Z" lat="35.005" lon="139.005"><tag k="amenity" v="toilets"/></node><node id="3" version="2" timestamp="2026-10-16T00:00:00Z" lat="35.006" lon="139.006"><tag k="amenity" v="toilets"/></node></modify><create><node id="4" version="1" timestamp="2026-10-16T00:00:00Z" lat="35.007" lon="139.007"><tag k="amenity" v="toilets"/></node></create></osmChange>');
      const result = await applyDiffBatchGeneration(root, [first, second], { fromSequence: 11, toSequence: 12, ...options(12), updateWorkers: 3 });
      expect(result.changedCount).toBe(3);
      const manifest = JSON.parse(await fs.readFile(path.join(root, 'data', 'manifest.json'), 'utf8'));
      expect(manifest.totalElements).toBe(3);
      const rows = databaseElements(path.join(root, 'data'));
      const nodes = new Map(rows.filter((row) => row.type === 'node' && row.tags?.amenity === 'toilets').map((row) => [row.id, row]));
      expect([...nodes.keys()].sort()).toEqual([1, 3, 4]);
      expect(nodes.get(1)?.version).toBe(4);
      expect(nodes.get(1)?.lat).toBe(35.005);
      expect(nodes.get(3)?.version).toBe(2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('reports missing flock explicitly instead of bypassing the generation lock', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-no-flock-'));
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = '';
      await expect(withGenerationLock(root, async () => {})).rejects.toThrow(/requires the Linux flock command/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid candidate inventory/header, sync and pre-activation failures without publishing, then retries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'activate-guards-'));
    const generations = path.join(root, 'data-generations');
    const candidate = path.join(generations, 'candidate');
    await fs.mkdir(path.join(candidate, 'shards'), { recursive: true });
    const manifestPath = path.join(candidate, 'manifest.json'); const statePath = path.join(candidate, 'state.json');
    const config = buildConfigHash({ amenities: ['toilets'], precision: 5 });
    const writeManifest = async (shards: string[], configHash = config.toString('hex')) => fs.writeFile(manifestPath, JSON.stringify({ shards, configHash }));
    try {
      await fs.writeFile(statePath, '{}');
      await writeManifest(['../escape']);
      await expect(activateGeneration(root, candidate)).rejects.toThrow(/invalid candidate shard name/);
      await writeManifest(['bc3']);
      await expect(activateGeneration(root, candidate)).rejects.toThrow();
      await fs.writeFile(path.join(candidate, 'shards', 'bc3.bin'), writeShard('bc3', [], 0, config));
      await writeManifest(['bc3'], 'f'.repeat(64));
      await expect(activateGeneration(root, candidate)).rejects.toThrow(/config hash mismatch/);
      await writeManifest(['bc3']);
      await fs.symlink('missing-target', path.join(candidate, 'unexpected-link'));
      await expect(activateGeneration(root, candidate)).rejects.toThrow(/unsupported filesystem entry/);
      await fs.rm(path.join(candidate, 'unexpected-link'));
      await expect(activateGeneration(root, candidate, { syncGeneration: async () => { throw new Error('simulated fsync failure'); } })).rejects.toThrow(/fsync failure/);
      await expect(fs.lstat(path.join(root, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
      await fs.mkdir(path.join(root, 'outside'));
      await expect(activateGeneration(root, path.join(root, 'outside'))).rejects.toThrow();
      await expect(activateGeneration(root, candidate, { beforeActivate: async () => { throw new Error('simulated pre-activation failure'); } })).rejects.toThrow(/pre-activation failure/);
      await expect(fs.lstat(path.join(root, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
      await activateGeneration(root, candidate);
      expect(await fs.realpath(path.join(root, 'data'))).toBe(candidate);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
