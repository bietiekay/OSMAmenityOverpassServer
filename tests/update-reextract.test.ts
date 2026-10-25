import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { encodeElement } from '../scripts/extract/lines.mjs';
import { buildIndex } from '../scripts/extract/assembly.mjs';
import { applyDiffGeneration } from '../scripts/update/apply-generation.mjs';
import { isReextractDue, maybeRunReextract, runReextract } from '../scripts/update/reextract.mjs';
import { IndexDatabase } from '../src/index/database.js';
import { writeState } from '../scripts/database/metadata.mjs';
import { databaseElements } from './database-helpers.js';

const replication = { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day' } as const;
const snapshotTime = '2026-10-14T00:00:00Z';
const updateTime = '2026-10-15T00:00:00Z';

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reextract-'));
  const source = path.join(root, 'source.osm.pbf');
  const xml = '<osm version="0.6"><node id="1" version="1" timestamp="2026-10-14T00:00:00Z" lat="35" lon="139"><tag k="amenity" v="toilets"/></node></osm>';
  const { execFileSync } = await import('node:child_process');
  const osm = path.join(root, 'source.osm'); await fs.writeFile(osm, xml);
  execFileSync('osmium', ['cat', osm, '-o', source]);
  const fingerprint = await hash(source);
  const pipelineDir = path.join(root, 'pipeline');
  await writeInputs(pipelineDir, fingerprint);
  await buildIndex({ pipelineDir, source, sourceFingerprint: fingerprint, sourceTimestamp: snapshotTime, replication: { ...replication, sequenceNumber: 1 }, amenities: ['toilets'], shardPrecision: 5 });
  return { root, pipelineDir, source, fingerprint };
}

async function hash(file: string) {
  const content = await fs.readFile(file);
  return createHash('sha256').update(content).digest('hex');
}

async function writeInputs(root: string, fingerprint: string) {
  for (const stage of ['stage1', 'stage2', 'stage3']) await fs.mkdir(path.join(root, 'work', stage), { recursive: true });
  const write = (stage: string, file: string, records: object[]) => fs.writeFile(path.join(root, 'work', stage, file), `${records.map((record) => encodeElement(record as never)).join('\n')}\n`);
  await write('stage1', 'amen_c0000.lines', [{ type: 'node', id: 1, version: 1, timestamp: 1791936000, changeset: 0, lat: 35, lon: 139, tags: { amenity: 'toilets' }, nodeIds: [], members: [] }]);
  await write('stage2', 'ways_c0000.lines', []);
  await write('stage3', 'nodes_c0000.lines', []);
  return { fingerprint };
}

function fetcher(sequence: number, diff: string | null) {
  return async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/state.txt')) return new Response(`sequenceNumber=${sequence}\ntimestamp=${updateTime}\n`, { status: 200 });
    if (url.endsWith('.osc.gz') && diff !== null) return new Response(gzipSync(diff), { status: 200 });
    return new Response('not found', { status: 404 });
  };
}

const addToilet = '<osmChange version="0.6"><create><node id="2" version="1" timestamp="2026-10-15T00:00:00Z" lat="35.01" lon="139.01"><tag k="amenity" v="toilets"/></node></create></osmChange>';

async function extractionFor(fixture: Awaited<ReturnType<typeof makeFixture>>, afterBuild?: () => Promise<void>, namespace = replication,
  snapshot: { sequence?: number; timestamp?: string } = {}) {
  return async (args: string[], deps: { buildIndex: (options: object) => Promise<unknown> }) => {
    const scratch = args[args.indexOf('--data-dir') + 1];
    await writeInputs(scratch, fixture.fingerprint);
    const built = await deps.buildIndex({
      pipelineDir: scratch, source: fixture.source, sourceFingerprint: fixture.fingerprint,
      sourceTimestamp: snapshot.timestamp ?? snapshotTime, replication: { ...namespace, sequenceNumber: snapshot.sequence ?? 1 },
      amenities: ['toilets'], shardPrecision: 5
    });
    await afterBuild?.();
    return built;
  };
}

async function allElements(pipelineDir: string) {
  return databaseElements(path.join(pipelineDir, 'data'));
}

describe('weekly drift re-extract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('catches a candidate snapshot up to the current namespace before one activation', async () => {
    const fixture = await makeFixture();
    try {
      const before = await fs.realpath(path.join(fixture.pipelineDir, 'data'));
      const result = await runReextract({
        dataDir: fixture.pipelineDir, sourcePbf: fixture.source, amenities: ['toilets'], shardPrecision: 5,
        replication, extraction: await extractionFor(fixture), fetchImpl: fetcher(2, addToilet), now: () => '2026-10-15T01:00:00Z'
      });
      expect(result.sequenceNumber).toBe(2);
      expect(await fs.realpath(path.join(fixture.pipelineDir, 'data'))).not.toBe(before);
      expect(JSON.parse(await fs.readFile(path.join(fixture.pipelineDir, 'data/state.json'), 'utf8'))).toMatchObject({
        lastSeq: 0, lastReextractAt: '2026-10-15T01:00:00Z', replication: { sequenceNumber: 2, kind: 'regional', interval: 'day' }
      });
      expect((await allElements(fixture.pipelineDir)).some((element: { id: number; type: string; tags: { amenity?: string } }) => element.type === 'node' && element.id === 2 && element.tags.amenity === 'toilets')).toBe(true);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('preserves a planet minute cursor when the candidate snapshot needs no diffs', async () => {
    const fixture = await makeFixture();
    const planet = { baseUrl: 'https://planet.openstreetmap.org/replication', kind: 'planet', interval: 'minute' } as const;
    try {
      const activeStatePath = path.join(fixture.pipelineDir, 'data/state.json');
      const activeState = JSON.parse(await fs.readFile(activeStatePath, 'utf8'));
      activeState.replication = { ...planet, sequenceNumber: 1 }; activeState.lastSeq = 1;
      await writeState(path.dirname(activeStatePath), activeState);
      await runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, amenities: ['toilets'], shardPrecision: 5,
        replication: planet, extraction: await extractionFor(fixture, undefined, planet), fetchImpl: fetcher(1, null) });
      expect(JSON.parse(await fs.readFile(activeStatePath, 'utf8')).lastSeq).toBe(1);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('re-reads the live cursor after candidate construction and catches up an intervening update', async () => {
    const fixture = await makeFixture();
    try {
      const interveningDiff = path.join(fixture.root, 'active-2.osc.gz');
      await fs.writeFile(interveningDiff, gzipSync(addToilet));
      const extraction = await extractionFor(fixture, async () => {
        await applyDiffGeneration(fixture.pipelineDir, interveningDiff, {
          sequence: 2, replication, amenities: ['toilets'], shardPrecision: 5,
          sourcePbf: fixture.source, sourcePbfFingerprint: fixture.fingerprint, dataTimestamp: updateTime
        });
      });
      const result = await runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction, fetchImpl: fetcher(2, addToilet) });
      expect(result.sequenceNumber).toBe(2);
      expect((await allElements(fixture.pipelineDir)).filter((element: { id: number; type: string }) => element.type === 'node' && element.id === 2)).toHaveLength(1);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('leaves the serving generation untouched when diff catch-up fails', async () => {
    const fixture = await makeFixture();
    try {
      const before = await fs.realpath(path.join(fixture.pipelineDir, 'data'));
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction: await extractionFor(fixture),
        fetchImpl: fetcher(2, null)
      })).rejects.toThrow();
      expect(await fs.realpath(path.join(fixture.pipelineDir, 'data'))).toBe(before);
      expect(JSON.parse(await fs.readFile(path.join(fixture.pipelineDir, 'data/state.json'), 'utf8')).replication.sequenceNumber).toBe(1);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('rejects unknown snapshot cursors and cleans the inactive candidate', async () => {
    const fixture = await makeFixture();
    try {
      const extraction = async (args: string[], deps: { buildIndex: (options: object) => Promise<any> }) => {
        const scratch = args[args.indexOf('--data-dir') + 1]; await writeInputs(scratch, fixture.fingerprint);
        const candidate = await deps.buildIndex({ pipelineDir: scratch, source: fixture.source, sourceFingerprint: fixture.fingerprint,
          sourceTimestamp: snapshotTime, replication: { ...replication, sequenceNumber: 0 }, amenities: ['toilets'], shardPrecision: 5 });
        const statePath = path.join(candidate.generationDir, 'state.json');
        const state = JSON.parse(await fs.readFile(statePath, 'utf8')); state.replication.sequenceNumber = 0;
        await writeState(path.dirname(statePath), state);
      };
      const before = await fs.realpath(path.join(fixture.pipelineDir, 'data'));
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction })).rejects.toThrow(/positive namespace-local/);
      expect(await fs.realpath(path.join(fixture.pipelineDir, 'data'))).toBe(before);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('rejects missing source paths and incomplete replication namespaces before extraction', async () => {
    const fixture = await makeFixture();
    try {
      const extraction = vi.fn();
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: '  ', replication, extraction })).rejects.toThrow(/PBF path is required/);
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication: {}, extraction })).rejects.toThrow(/complete replication namespace/);
      expect(extraction).not.toHaveBeenCalled();
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('rejects a changed active replication namespace before building a candidate', async () => {
    const fixture = await makeFixture();
    try {
      const statePath = path.join(fixture.pipelineDir, 'data/state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      state.replication.baseUrl = 'https://other.example/updates'; await writeState(path.dirname(statePath), state);
      const extraction = vi.fn();
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication, extraction })).rejects.toThrow(/does not match the active generation/);
      expect(extraction).not.toHaveBeenCalled();
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('rejects incomplete candidate PBF provenance and keeps the active generation', async () => {
    const fixture = await makeFixture();
    try {
      const extraction = async (args: string[], deps: { buildIndex: (options: object) => Promise<any> }) => {
        const scratch = args[args.indexOf('--data-dir') + 1]; await writeInputs(scratch, fixture.fingerprint);
        const candidate = await deps.buildIndex({ pipelineDir: scratch, source: fixture.source, sourceFingerprint: fixture.fingerprint,
          sourceTimestamp: snapshotTime, replication: { ...replication, sequenceNumber: 1 }, amenities: ['toilets'], shardPrecision: 5 });
        const statePath = path.join(candidate.generationDir, 'state.json'); const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        state.sourceFingerprint = null; await writeState(path.dirname(statePath), state);
      };
      const active = await fs.realpath(path.join(fixture.pipelineDir, 'data'));
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication, extraction })).rejects.toThrow(/provenance is incomplete/);
      expect(await fs.realpath(path.join(fixture.pipelineDir, 'data'))).toBe(active);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('removes a candidate that fails activation validation after successful catch-up checks', async () => {
    const fixture = await makeFixture();
    try {
      const active = await fs.realpath(path.join(fixture.pipelineDir, 'data'));
      const fetchImpl = async (input: string | URL) => {
        const generations = path.join(fixture.pipelineDir, 'data-generations');
        const candidates = (await fs.readdir(generations)).filter((name) => name.startsWith('reextract-'));
        const candidate = path.join(generations, candidates[0]);
        const manifestPath = path.join(candidate, 'manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        manifest.configHash = '0'.repeat(64);
        const db = new IndexDatabase(candidate); try { db.setMetadata('manifest', manifest); db.db.exec('DELETE FROM spatial'); } finally { db.close(); }
        return new Response(`sequenceNumber=000000001\ntimestamp=${snapshotTime}\n`, { status: 200 });
      };
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction: await extractionFor(fixture), fetchImpl
      })).rejects.toThrow(/config hash mismatch/);
      expect(await fs.realpath(path.join(fixture.pipelineDir, 'data'))).toBe(active);
      expect((await fs.readdir(path.join(fixture.pipelineDir, 'data-generations'))).some((name) => name.startsWith('reextract-'))).toBe(false);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('rejects an active generation with an unknown namespace cursor', async () => {
    const fixture = await makeFixture();
    try {
      const activeStatePath = path.join(fixture.pipelineDir, 'data/state.json');
      const state = JSON.parse(await fs.readFile(activeStatePath, 'utf8'));
      state.replication.sequenceNumber = 0;
      await writeState(path.dirname(activeStatePath), state);
      const before = await fs.realpath(path.join(fixture.pipelineDir, 'data'));
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction: await extractionFor(fixture), fetchImpl: fetcher(2, addToilet)
      })).rejects.toThrow(/active generation has no positive namespace-local cursor/);
      expect(await fs.realpath(path.join(fixture.pipelineDir, 'data'))).toBe(before);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('rejects a candidate from another replication namespace', async () => {
    const fixture = await makeFixture();
    try {
      const extraction = async (args: string[], deps: { buildIndex: (options: object) => Promise<unknown> }) => {
        const scratch = args[args.indexOf('--data-dir') + 1]; await writeInputs(scratch, fixture.fingerprint);
        await deps.buildIndex({ pipelineDir: scratch, source: fixture.source, sourceFingerprint: fixture.fingerprint,
          sourceTimestamp: snapshotTime, replication: { ...replication, baseUrl: `${replication.baseUrl}/wrong`, sequenceNumber: 1 },
          amenities: ['toilets'], shardPrecision: 5 });
      };
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction
      })).rejects.toThrow(/new PBF replication metadata does not match/);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('rejects a snapshot cursor ahead of the live replication source', async () => {
    const fixture = await makeFixture();
    try {
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction: await extractionFor(fixture, undefined, replication, { sequence: 3 }),
        fetchImpl: fetcher(2, null)
      })).rejects.toThrow(/ahead of replication source/);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('rejects snapshots without a timestamp and catch-up gaps over the configured bound', async () => {
    const fixture = await makeFixture();
    try {
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction: await extractionFor(fixture, undefined, replication, { timestamp: 'not-a-time' }),
        fetchImpl: fetcher(1, null)
      })).rejects.toThrow(/no valid source timestamp/);
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction: await extractionFor(fixture),
        fetchImpl: fetcher(4, addToilet), maxCatchupDiffs: 1
      })).rejects.toThrow(/exceeds limit 1/);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('honors cancellation after candidate construction without changing the active generation', async () => {
    const fixture = await makeFixture();
    try {
      const controller = new AbortController();
      const before = await fs.realpath(path.join(fixture.pipelineDir, 'data'));
      const extraction = await extractionFor(fixture, async () => controller.abort(new Error('test cancellation')));
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction, signal: controller.signal
      })).rejects.toThrow(/test cancellation/);
      expect(await fs.realpath(path.join(fixture.pipelineDir, 'data'))).toBe(before);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('rejects a source PBF replaced during extraction', async () => {
    const fixture = await makeFixture();
    try {
      const replacement = path.join(fixture.root, 'replacement.pbf');
      await fs.copyFile(fixture.source, replacement);
      const extraction = await extractionFor(fixture, async () => fs.rename(replacement, fixture.source));
      const before = await fs.realpath(path.join(fixture.pipelineDir, 'data'));
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        amenities: ['toilets'], shardPrecision: 5, extraction
      })).rejects.toThrow(/source PBF changed during extraction/);
      expect(await fs.realpath(path.join(fixture.pipelineDir, 'data'))).toBe(before);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('records a first-check schedule baseline and uses the configured weekly interval', async () => {
    const fixture = await makeFixture();
    try {
      expect(isReextractDue({ lastReextractAt: '2026-10-01T00:00:00Z' }, Date.parse('2026-10-08T00:00:00Z'), 604800)).toBe(true);
      expect(isReextractDue({ lastReextractAt: '2026-10-01T00:00:00Z' }, Date.parse('2026-10-07T23:59:59Z'), 604800)).toBe(false);
      const extraction = vi.fn();
      const result = await maybeRunReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        extraction, now: () => '2026-10-15T00:00:00Z' });
      expect(result).toBeNull(); expect(extraction).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(path.join(fixture.pipelineDir, '.reextract-schedule.json'), 'utf8')))
        .toEqual({ lastReextractAt: '2026-10-15T00:00:00Z', intervalSeconds: 15552000 });
      await expect(maybeRunReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source, replication,
        extraction, now: () => '2026-10-15T00:00:00Z' })).resolves.toBeNull();
      expect(extraction).not.toHaveBeenCalled();
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('runs a due scheduled rebuild and removes its startup baseline after activation', async () => {
    const fixture = await makeFixture();
    try {
      const schedule = path.join(fixture.pipelineDir, '.reextract-schedule.json');
      await fs.writeFile(schedule, JSON.stringify({ lastReextractAt: '2026-10-01T00:00:00Z', intervalSeconds: 604800 }));
      const result = await maybeRunReextract({ dataDir: fixture.pipelineDir, sourcePbf: fixture.source,
        replication, amenities: ['toilets'], shardPrecision: 5, extraction: await extractionFor(fixture),
        fetchImpl: fetcher(1, null), now: () => '2026-10-08T00:00:00Z', intervalSeconds: 604800 });
      expect(result).toMatchObject({ sequenceNumber: 1 });
      await expect(fs.access(schedule)).rejects.toThrow();
      expect(JSON.parse(await fs.readFile(path.join(fixture.pipelineDir, 'data/state.json'), 'utf8')))
        .toMatchObject({ lastReextractAt: '2026-10-08T00:00:00Z' });
      expect(isReextractDue({ lastReextractAt: 'invalid' }, Date.now())).toBe(false);
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('rejects a missing source file before reading active state or building', async () => {
    const fixture = await makeFixture();
    try {
      const extraction = vi.fn();
      await expect(runReextract({ dataDir: fixture.pipelineDir, sourcePbf: path.join(fixture.root, 'missing.pbf'),
        replication, extraction })).rejects.toThrow();
      expect(extraction).not.toHaveBeenCalled();
    } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  }, 20000);

  it('runs the weekly rebuild through the update worker with a real tiny PBF and mocked replication HTTP', async () => {
    const fixture = await makeFixture();
    let worker: ReturnType<typeof spawn> | null = null;
    const server = http.createServer((request, response) => {
      if (request.url?.endsWith('/minute/state.txt')) {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(`sequenceNumber=000000002\ntimestamp=${updateTime}\n`);
      } else if (request.url?.endsWith('/minute/000/000/002.osc.gz')) {
        response.writeHead(200, { 'content-type': 'application/gzip' });
        response.end(gzipSync(addToilet));
      } else { response.writeHead(404); response.end('missing'); }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('mock replication server did not bind TCP');
      const baseUrl = `http://127.0.0.1:${address.port}/replication/planet/minute`;
      const statePath = path.join(fixture.pipelineDir, 'data/state.json');
      const activeState = JSON.parse(await fs.readFile(statePath, 'utf8'));
      activeState.replication = { baseUrl, kind: 'planet', interval: 'minute', sequenceNumber: 1 };
      activeState.lastSeq = 1;
      activeState.lastReextractAt = '2026-10-01T00:00:00Z';
      await writeState(path.dirname(statePath), activeState);
      // The source PBF is real; the shim supplies its replication header metadata
      // while delegating all extraction and source-index commands to osmium.
      const bin = path.join(fixture.root, 'bin'); await fs.mkdir(bin);
      const osmiumPath = execFileSync('which', ['osmium'], { encoding: 'utf8' }).trim();
      const shim = `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const a=process.argv.slice(2);if(a[0]==='fileinfo'){process.stdout.write(JSON.stringify({header:{option:{osmosis_replication_base_url:${JSON.stringify(baseUrl)},osmosis_replication_sequence_number:'000000001',osmosis_replication_timestamp:${JSON.stringify(snapshotTime)}}}}));process.exit(0)}const r=spawnSync(${JSON.stringify(osmiumPath)},a,{stdio:'inherit'});process.exit(r.status??1);\n`;
      const shimPath = path.join(bin, 'osmium'); await fs.writeFile(shimPath, shim); await fs.chmod(shimPath, 0o755);
      worker = spawn(process.execPath, ['scripts/update.mjs', '--watch'], {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OSM_AMENITY_DATA_DIR: fixture.pipelineDir,
          OSM_AMENITY_UPDATE_BASE_URL: baseUrl, OSM_AMENITY_SOURCE_PBF: fixture.source,
          OSM_AMENITY_REEXTRACT_SOURCE_PBF: fixture.source, OSM_AMENITY_REEXTRACT_EVERY_SECONDS: '1',
          OSM_AMENITY_UPDATE_INTERVAL_SECONDS: '3600' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let logs = '';
      worker.stdout?.on('data', (chunk) => { logs += chunk.toString(); });
      worker.stderr?.on('data', (chunk) => { logs += chunk.toString(); });
      const deadline = Date.now() + 45000;
      let activated = false;
      while (Date.now() < deadline) {
        const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        const elements = await allElements(fixture.pipelineDir);
        if (state.replication.sequenceNumber === 2 && state.lastReextractAt && elements.some((element: { id: number; type: string }) => element.type === 'node' && element.id === 2)) {
          activated = true; break;
        }
        if (worker.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!activated) throw new Error(`update worker did not activate the caught-up candidate; output: ${logs}`);
    } finally {
      if (worker && worker.exitCode === null) {
        worker.kill('SIGTERM');
        await new Promise<void>((resolve) => worker?.once('exit', () => resolve()));
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }, 60000);
});
