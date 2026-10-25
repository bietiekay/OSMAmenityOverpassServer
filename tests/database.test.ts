import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { IndexDatabase } from '../src/index/database.js';
import { AmenityEngine } from '../src/index/engine.js';
import { buildLogger } from '../src/logger.js';
import { parseAmenityQuery } from '../src/query.js';
import { readDataState } from '../src/server.js';
import { buildIndex } from '../scripts/extract/assembly.mjs';
import { encodeElement } from '../scripts/extract/lines.mjs';
import { applyDiffGeneration, applyDiffBatchGeneration } from '../scripts/update/apply-generation.mjs';
const replication = { baseUrl: 'https://planet.example/minute', kind: 'planet', interval: 'minute' };
const quiet = () => { };
async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oam-sqlite-'));
    const pbf = path.join(root, 'source.pbf');
    const xml = path.join(root, 'source.osm');
    await fs.writeFile(xml, `<osm version="0.6"><node id="1" version="1" lat="35" lon="139"/><node id="2" version="1" lat="35.01" lon="139.01"/><node id="3" version="5" lat="36" lon="140"/><way id="10" version="1"><nd ref="1"/><nd ref="2"/><tag k="amenity" v="toilets"/></way><relation id="20" version="1"><member type="way" ref="10" role="outer"/><tag k="amenity" v="toilets"/></relation></osm>`);
    execFileSync('osmium', ['cat', xml, '-o', pbf]);
    const sourceFingerprint = createHash('sha256').update(await fs.readFile(pbf)).digest('hex');
    for (const stage of ['stage1', 'stage2', 'stage3'])
        await fs.mkdir(path.join(root, 'work', stage), { recursive: true });
    const put = async (stage: string, name: string, rows: object[]) => fs.writeFile(path.join(root, 'work', stage, name), rows.map(r => encodeElement(r as never)).join('\n') + '\n');
    await put('stage3', 'nodes_c0000.lines', [
        { type: 'node', id: 1, version: 1, lat: 35, lon: 139 }, { type: 'node', id: 2, version: 1, lat: 35.01, lon: 139.01 }
    ]);
    await put('stage2', 'ways_c0000.lines', [{ type: 'way', id: 10, version: 1, nodeIds: [1, 2], tags: { amenity: 'toilets' } }]);
    await put('stage1', 'amen_c0000.lines', [
        { type: 'way', id: 10, version: 1, nodeIds: [1, 2], tags: { amenity: 'toilets' } },
        { type: 'relation', id: 20, version: 1, members: [{ type: 'way', ref: 10, role: 'outer' }], tags: { amenity: 'toilets' } }
    ]);
    const options = { pipelineDir: root, source: pbf, sourceFingerprint, amenities: ['toilets'], shardPrecision: 5, sourceTimestamp: '2026-10-14T00:00:00Z', replication: { ...replication, sequenceNumber: 10 }, logger: quiet };
    const manifest = await buildIndex(options);
    const diff = async (body: string) => { const file = path.join(root, `diff-${Math.random()}.osc.gz`); await fs.writeFile(file, gzipSync(`<osmChange version="0.6">${body}</osmChange>`)); return file; };
    const apply = async (sequence: number, body: string, extra: object = {}) => applyDiffGeneration(root, await diff(body), { sequence, replication, onProgress: quiet, ...extra });
    const read = <T>(fn: (d: IndexDatabase) => T) => { const d = new IndexDatabase(path.join(root, 'data'), { readOnly: true }); try {
        return fn(d);
    }
    finally {
        d.close();
    } };
    const engine = new AmenityEngine({ dataDir: path.join(root, 'data'), shardPrecision: 5, cacheMb: 16, generator: 'test', amenities: ['toilets'] }, buildLogger('silent'));
    const query = async (bbox = '34,138,37,142') => JSON.parse((await engine.query(parseAmenityQuery(`[out:json];(node[amenity=toilets](${bbox});way[amenity=toilets](${bbox});relation[amenity=toilets](${bbox}););out geom;`)!)).payload);
    return { root, pbf, options, manifest, diff, apply, read, engine, query };
}
describe('OAM-SQLITE-1 fresh planet storage', () => {
    it('deduplicates main/support geometry, uses spatial queries, and reuses a validated import', async () => {
        const f = await fixture();
        try {
            expect(f.manifest.format).toBe('OAM-SQLITE-1');
            expect(f.manifest.totalElements).toBe(2);
            const files = await fs.readdir(path.join(f.root, 'data'));
            expect(files).toContain('index.sqlite');
            expect(files).not.toContain('shards');
            expect(files).not.toContain('objects');
            expect(f.read(d => d.counts())).toMatchObject({ mainUnique: 2, duplicatedRecords: 0 });
            expect(f.read(d => d.getGeometry('way:10')?.memberCoords.size)).toBe(2);
            expect((await f.query()).elements.map((e: any) => `${e.type}:${e.id}`).sort()).toEqual(['relation:20', 'way:10']);
            expect((await f.query('0,0,1,1')).elements).toEqual([]);
            expect((await buildIndex(f.options)).generation).toBe(f.manifest.generation);
            const global = parseAmenityQuery('[out:json];(node[amenity=toilets](-90,-180,90,180);way[amenity=toilets](-90,-180,90,180);relation[amenity=toilets](-90,-180,90,180););out tags;')!;
            expect((await f.engine.query(global)).elementCount).toBe(2);
            f.read(d => d.validate());
        }
        finally {
            await fs.rm(f.root, { recursive: true, force: true });
        }
    });
    it('updates a shared member and its parents in place, with consistent concurrent readers and rollback', async () => {
        const f = await fixture();
        try {
            const original = await fs.realpath(path.join(f.root, 'data'));
            const reader = new IndexDatabase(path.join(f.root, 'data'), { readOnly: true });
            reader.db.exec('BEGIN');
            expect(reader.getRaw('node:1')?.version).toBe(1);
            await f.apply(11, '<modify><node id="1" version="2" lat="35.2" lon="139.2"/></modify>');
            expect(reader.getRaw('node:1')?.version).toBe(1);
            reader.db.exec('COMMIT');
            expect(reader.getRaw('node:1')?.version).toBe(2);
            reader.close();
            expect(await fs.realpath(path.join(f.root, 'data'))).toBe(original);
            expect(f.read(d => d.getGeometry('way:10')?.memberCoords.get(1))).toEqual({ lat: 35.2, lon: 139.2 });
            expect(f.read(d => d.getGeometry('relation:20')?.bbox)).toEqual([35.01, 139.01, 35.2, 139.2]);
            const change = '<modify><node id="1" version="3" lat="35.3" lon="139.3"/></modify>';
            await expect(f.apply(12, change, { beforePublish: async () => { throw new Error('injected crash'); } })).rejects.toThrow('injected crash');
            expect(f.read(d => d.getRaw('node:1')?.version)).toBe(2);
            expect((await readDataState(path.join(f.root, 'data'))).lastSeq).toBe(11);
            await f.apply(12, change);
            expect(f.read(d => d.getRaw('node:1')?.version)).toBe(3);
            expect((await readDataState(path.join(f.root, 'data'))).lastSeq).toBe(12);
            f.read(d => d.validate());
        }
        finally {
            await fs.rm(f.root, { recursive: true, force: true });
        }
    });
    it('keeps removed amenities as current helpers, prunes unused geometry and rejects missing references atomically', async () => {
        const f = await fixture();
        try {
            await f.apply(11, '<modify><way id="10" version="2"><nd ref="2"/></way></modify>');
            expect(f.read(d => d.counts().mainUnique)).toBe(1);
            expect(f.read(d => d.getGeometry('way:10')?.nodeIds)).toEqual([2]);
            expect(f.read(d => d.getGeometry('relation:20')?.bbox)).toEqual([35.01, 139.01, 35.01, 139.01]);
            await f.apply(12, '<delete><relation id="20" version="2"/></delete>');
            expect(f.read(d => d.counts())).toMatchObject({ mainUnique: 0, supportObjects: 0 });
            await expect(f.apply(13, '<create><way id="30" version="1"><nd ref="999"/><tag k="amenity" v="toilets"/></way></create>')).rejects.toThrow(/missing references/);
            expect(f.read(d => d.getRaw('way:30'))).toBeNull();
            expect((await readDataState(path.join(f.root, 'data'))).lastSeq).toBe(12);
        }
        finally {
            await fs.rm(f.root, { recursive: true, force: true });
        }
    });
    it('retains unrelated deltas for future dependencies and compares unknown objects against the baseline', async () => {
        const f = await fixture();
        try {
            await f.apply(11, '<modify><node id="3" version="4" lat="1" lon="1"/></modify><create><node id="4" version="1" lat="36.1" lon="140.1"/></create>');
            await f.apply(12, '<create><way id="40" version="1"><nd ref="3"/><nd ref="4"/><tag k="amenity" v="toilets"/></way></create>');
            expect(f.read(d => d.getGeometry('way:40')?.memberCoords.get(3))).toEqual({ lat: 36, lon: 140 });
            expect(f.read(d => d.getGeometry('way:40')?.memberCoords.get(4))).toEqual({ lat: 36.1, lon: 140.1 });
            const stale = await f.apply(13, '<modify><node id="3" version="5" lat="2" lon="2"/></modify>');
            expect(stale.changedCount).toBe(0);
            expect((await readDataState(path.join(f.root, 'data'))).lastSeq).toBe(13);
            f.read(d => d.validate());
        }
        finally {
            await fs.rm(f.root, { recursive: true, force: true });
        }
    });
    it('coalesces batches and keeps the database authoritative if JSON sidecars are stale', async () => {
        const f = await fixture();
        try {
            const first = await f.diff('<modify><node id="1" version="2" lat="35.2" lon="139.2"/></modify>');
            const second = await f.diff('<modify><node id="1" version="3" lat="35.3" lon="139.3"/></modify>');
            await applyDiffBatchGeneration(f.root, [first, second], { fromSequence: 11, toSequence: 12, replication, updateWorkers: 2 });
            expect(f.read(d => d.getRaw('node:1')?.version)).toBe(3);
            await fs.writeFile(path.join(f.root, 'data', 'state.json'), '{}');
            await fs.writeFile(path.join(f.root, 'data', 'manifest.json'), '{}');
            expect((await readDataState(path.join(f.root, 'data'))).lastSeq).toBe(12);
            await f.apply(13, '');
            expect((await f.query()).elements.length).toBe(2);
            await expect(f.apply(15, '')).rejects.toThrow(/sequence batch gap/);
            await expect(f.apply(14, '', { replication: { ...replication, kind: 'regional' } })).rejects.toThrow(/source descriptor/);
        }
        finally {
            await fs.rm(f.root, { recursive: true, force: true });
        }
    });
});
it('recovers from a killed writer without publishing partial data or cursor', async () => {
    const f = await fixture();
    try {
        const file = await f.diff('<modify><node id="1" version="2" lat="35.5" lon="139.5"/></modify>');
        const { spawn } = await import('node:child_process');
        const code = `import { applyDiffGeneration } from './scripts/update/apply-generation.mjs';
      await applyDiffGeneration(process.argv[1],process.argv[2],{sequence:11,replication:JSON.parse(process.argv[3]),beforePublish:()=>process.kill(process.pid,'SIGKILL')});`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.root, file, JSON.stringify(replication)], { stdio: 'ignore' });
        const outcome = await new Promise<{
            code: number | null;
            signal: string | null;
        }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
        expect(outcome.signal).toBe('SIGKILL');
        expect(f.read(d => d.getRaw('node:1')?.version)).toBe(1);
        expect((await readDataState(path.join(f.root, 'data'))).lastSeq).toBe(10);
        await f.apply(11, '<modify><node id="1" version="2" lat="35.5" lon="139.5"/></modify>');
        expect(f.read(d => d.getGeometry('way:10')?.memberCoords.get(1))).toEqual({ lat: 35.5, lon: 139.5 });
    }
    finally {
        await fs.rm(f.root, { recursive: true, force: true });
    }
});
it('imports nested relation geometry from the retained PBF and records its transitive dependencies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oam-nested-'));
    try {
        const source = path.join(root, 'nested.pbf');
        const xml = path.join(root, 'nested.osm');
        await fs.writeFile(xml, '<osm version="0.6"><node id="1" version="1" lat="35" lon="139"/><way id="10" version="1"><nd ref="1"/></way><relation id="20" version="1"><member type="way" ref="10" role="outer"/></relation><relation id="30" version="1"><member type="relation" ref="20" role="part"/><tag k="amenity" v="toilets"/></relation></osm>');
        execFileSync('osmium', ['cat', xml, '-o', source]);
        const stage1 = path.join(root, 'work', 'stage1');
        await fs.mkdir(stage1, { recursive: true });
        await fs.writeFile(path.join(stage1, 'amen_c0000.lines'), encodeElement({ type: 'relation', id: 30, version: 1, members: [{ type: 'relation', ref: 20, role: 'part' }], tags: { amenity: 'toilets' } }) + '\n');
        await buildIndex({ pipelineDir: root, source, sourceFingerprint: createHash('sha256').update(await fs.readFile(source)).digest('hex'), replication: { ...replication, sequenceNumber: 10 }, logger: quiet });
        const db = new IndexDatabase(path.join(root, 'data'), { readOnly: true });
        try {
            expect(db.getGeometry('relation:30')?.bbox).toEqual([35, 139, 35, 139]);
            expect(db.affectedMains('node:1')).toEqual(['relation:30']);
            expect(db.getGeometry('way:10')?.memberCoords.get(1)).toEqual({ lat: 35, lon: 139 });
            db.validate();
        }
        finally {
            db.close();
        }
    }
    finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
it('runs a fresh native PBF import through all stages and serves HTTP JSON/XML/status', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oam-native-sqlite-'));
    let app: Awaited<ReturnType<typeof import('../src/server.js')['buildServer']>> | undefined;
    try {
        const source = path.join(root, 'tiny.pbf');
        const xml = path.join(root, 'tiny.osm');
        const pipeline = path.join(root, 'pipeline');
        await fs.writeFile(xml, '<osm version="0.6"><node id="1" version="1" lat="35" lon="139"/><node id="2" version="1" lat="35.01" lon="139.01"/><node id="3" version="1" lat="35.005" lon="139.005"><tag k="amenity" v="toilets"/></node><way id="10" version="1"><nd ref="1"/><nd ref="2"/><tag k="amenity" v="toilets"/></way><relation id="20" version="1"><member type="way" ref="10" role="outer"/><tag k="amenity" v="toilets"/></relation></osm>');
        execFileSync('osmium', ['cat', xml, '-o', source]);
        const { main } = await import('../scripts/extract.mjs');
        await main(['--source', source, '--data-dir', pipeline, '--stages', '0-4', '--amenities', 'toilets', '--workers', '1', '--chunk-mb', '1', '--ram-mb', '2048', '--worker-ram-mb', '512'], {
            sourceMetadata: () => ({ timestamp: '2026-10-14T00:00:00Z', replication: { ...replication, sequenceNumber: 10 } }), logger: quiet
        });
        const { buildServer } = await import('../src/server.js');
        const { loadConfig } = await import('../src/config.js');
        const { Stats } = await import('../src/stats.js');
        const config = loadConfig({ OSM_AMENITY_DATA_DIR: path.join(pipeline, 'data'), OSM_AMENITY_AMENITIES: 'toilets' });
        const logger = buildLogger('silent');
        const engine = new AmenityEngine({ dataDir: config.dataDir, shardPrecision: 5, cacheMb: 16, generator: 'test' }, logger);
        app = await buildServer({ config, engine, logger, stats: new Stats(), serverVersion: 'test' });
        const q = '[out:json];(node[amenity=toilets](34.9,138.9,35.2,139.2);way[amenity=toilets](34.9,138.9,35.2,139.2);relation[amenity=toilets](34.9,138.9,35.2,139.2););out geom;>;out skel qt;';
        const json = await app.inject({ method: 'POST', url: '/api/interpreter', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ data: q }).toString() });
        expect(json.statusCode).toBe(200);
        expect(json.json().elements.map((e: any) => `${e.type}:${e.id}`).sort()).toEqual(['node:1', 'node:2', 'node:3', 'relation:20', 'way:10']);
        const xmlResponse = await app.inject({ method: 'GET', url: '/api/interpreter?' + new URLSearchParams({ data: q.replace('[out:json]', '[out:xml]') }) });
        expect(xmlResponse.statusCode).toBe(200);
        expect(xmlResponse.body).toContain('<relation');
        expect(xmlResponse.body).toContain('<nd');
        const status = (await app.inject({ method: 'GET', url: '/api/status' })).json();
        expect(status.localEngine).toMatchObject({ storageFormat: 'OAM-SQLITE-1', elements: 3, shards: 0 });
        expect(status.osm_osm_change).toBe('10');
    }
    finally {
        await app?.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}, 30000);
it('retains the active and newest rollback SQLite baseline and prunes older builds', async () => {
    const f = await fixture();
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
        const { cleanupOrphanedUpdateData } = await import('../scripts/update/cleanup.mjs');
        const old = await fs.realpath(path.join(f.root, 'data'));
        const second = await buildIndex({ ...f.options, sourceTimestamp: '2026-10-15T00:00:00Z' });
        const third = await buildIndex({ ...f.options, sourceTimestamp: '2026-10-16T00:00:00Z' });
        const realNow = Date.now();
        clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 60 * 60 * 1000);
        const result = await cleanupOrphanedUpdateData(f.root, { olderThanMs: realNow, publishedSequence: 10, generationsToKeep: 2 });
        expect(result.publishedGenerations).toBe(1);
        await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await fs.stat(path.join(f.root, 'data-generations', second.generation))).isDirectory()).toBe(true);
        expect(await fs.realpath(path.join(f.root, 'data'))).toBe(path.join(f.root, 'data-generations', third.generation));
    }
    finally {
        clock?.mockRestore();
        await fs.rm(f.root, { recursive: true, force: true });
    }
});
