import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { IndexDatabase, DATABASE_FORMAT } from '../../dist/index/database.js';
import { buildConfigHash } from '../../dist/index/shard.js';
import { readLines } from './storage.mjs';
import { decodeElement } from './lines.mjs';
import { createProgress } from './progress.mjs';
import { createImportResolver } from '../database/import-resolver.mjs';
import { buildGeometry } from '../database/geometry.mjs';
import { readMetadata, writeSidecars } from '../database/metadata.mjs';
import { activateGeneration, withGenerationLock } from '../update/generation.mjs';
const normalizeTimestamp = (value) => { if (value == null)
    return null; const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); };
/** Fresh OAM-SQLITE-1 import. No shard, cell spool, or partition lookup files are produced. */
export async function buildIndex(options) {
    const { pipelineDir, source, amenities = ['toilets'], shardPrecision = 5, ramMB = 8192, publish = true, resumeMode = 'verify' } = options;
    if (!pipelineDir)
        throw new Error('buildIndex requires pipelineDir');
    const select = async (stage, prefix) => {
        const dir = path.join(pipelineDir, 'work', stage);
        if (options.expectedChunkIds) {
            const files = options.expectedChunkIds.map(id => path.join(dir, `${prefix}_${id}.lines`)).sort();
            for (const file of files)
                await fs.access(file).catch(() => { throw new Error(`Stage 4 missing expected input ${file}`); });
            return files;
        }
        return (await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT')
            return []; throw e; })).filter(n => new RegExp(`^${prefix}_c\\d+\\.lines$`).test(n)).sort().map(n => path.join(dir, n));
    };
    const inputs = { nodes: await select('stage3', 'nodes'), ways: await select('stage2', 'ways'), amenities: await select('stage1', 'amen') };
    if (!inputs.amenities.length)
        throw new Error('Stage 4 requires amen_c*.lines inputs');
    const sourcePbf = source ? path.resolve(source) : null;
    const configHash = buildConfigHash({ amenities, precision: shardPrecision }).toString('hex');
    const hash = createHash('sha256').update(JSON.stringify({ format: DATABASE_FORMAT, sourcePbf, sourceFingerprint: options.sourceFingerprint, amenities, shardPrecision, replication: options.replication, sourceTimestamp: options.sourceTimestamp }));
    for (const file of Object.values(inputs).flat()) {
        hash.update(path.basename(file));
        if (resumeMode === 'trust') {
            const stat = await fs.stat(file);
            hash.update(`${stat.size}:${stat.mtimeMs}`);
        }
        else
            for await (const chunk of createReadStream(file))
                hash.update(chunk);
    }
    const fingerprint = hash.digest('hex');
    const activeRoot = await fs.realpath(path.join(pipelineDir, 'data')).catch(e => { if (e.code === 'ENOENT')
        return null; throw e; });
    if (publish && activeRoot) {
        const { manifest } = await readMetadata(activeRoot);
        if (manifest.format === DATABASE_FORMAT && manifest.buildFingerprint === fingerprint) {
            const current = new IndexDatabase(activeRoot, { readOnly: true });
            try {
                current.validate();
            }
            finally {
                current.close();
            }
            return manifest;
        }
    }
    // A stable private staging directory allows resuming chunks without ever modifying an active baseline.
    const generationId = `build-sqlite-${fingerprint}`;
    const generations = path.join(pipelineDir, 'data-generations');
    const staging = path.join(generations, `.${generationId}.staging`);
    await fs.mkdir(generations, { recursive: true });
    // Serialize initial builds as well as updates; a second process must not share the staging DB.
    return withGenerationLock(pipelineDir, async () => {
        await fs.mkdir(staging, { recursive: true });
        const index = new IndexDatabase(staging, { create: true, cacheMb: Math.min(512, Math.max(16, Math.floor(ramMB * .1))) });
        let manifest, state;
        const resolver = createImportResolver(index, { pipelineDir, sourcePbf, sourceFingerprint: options.sourceFingerprint ?? null, onProgress: event => (options.logger ?? console.log)(`${event.phase}: ${event.completed}/${event.total ?? '?'} ${event.unit}`) });
        try {
            for (const [kind, files] of Object.entries(inputs)) {
                const progress = createProgress(`stage 4 SQLite ${kind}`, files.length, options.logger ?? console.log);
                let completed = 0;
                for (const file of files) {
                    const marker = `input:${kind}:${path.basename(file)}`;
                    if (!index.getMetadata(marker)) {
                        index.db.exec('BEGIN IMMEDIATE');
                        try {
                            for await (const line of readLines([file])) {
                                const raw = decodeElement(line);
                                const key = `${raw.type}:${raw.id}`;
                                // Main records take precedence over duplicate support rows at equal versions.
                                index.statement(`INSERT INTO raw_objects VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET version=excluded.version,payload=excluded.payload WHERE excluded.version>=raw_objects.version`).run(key, raw.version, JSON.stringify(raw));
                                index.statement('INSERT OR REPLACE INTO baseline_versions VALUES(?,?)').run(key, raw.version);
                            }
                            index.setMetadata(marker, true);
                            index.db.exec('COMMIT');
                        }
                        catch (error) {
                            index.db.exec('ROLLBACK');
                            throw error;
                        }
                    }
                    progress(++completed, completed === files.length);
                }
            }
            // Keyset pagination keeps both JS and SQLite memory bounded during a planet build.
            let last = String(index.getMetadata('geometry-cursor') ?? '');
            let completed = Number(index.getMetadata('geometry-completed') ?? 0);
            const geometryTotal = Number(index.statement("SELECT count(*) AS n FROM raw_objects WHERE json_extract(payload,'$.tags.amenity') IN (SELECT value FROM json_each(?))").get(JSON.stringify(amenities)).n);
            const progress = createProgress('stage 4 SQLite geometries', geometryTotal, options.logger ?? console.log);
            while (true) {
                const rows = index.statement('SELECT key,payload FROM raw_objects WHERE key>? ORDER BY key LIMIT 256').all(last);
                if (!rows.length)
                    break;
                index.db.exec('BEGIN IMMEDIATE');
                try {
                    for (const row of rows) {
                        const raw = JSON.parse(row.payload);
                        if (amenities.includes(raw.tags?.amenity)) {
                            const built = await buildGeometry(raw, resolver.resolve);
                            const obsolete = index.setMain(built.main, built.helpers, built.dependencies);
                            index.pruneGeometry(obsolete);
                            completed++;
                        }
                        last = String(row.key);
                    }
                    index.setMetadata('geometry-cursor', last);
                    index.setMetadata('geometry-completed', completed);
                    index.db.exec('COMMIT');
                }
                catch (error) {
                    index.db.exec('ROLLBACK');
                    throw error;
                }
                progress(completed);
            }
            const counts = index.counts();
            manifest = { format: DATABASE_FORMAT, generation: generationId, buildFingerprint: fingerprint, source: sourcePbf, sourceFingerprint: options.sourceFingerprint ?? null, sourceTimestamp: normalizeTimestamp(options.sourceTimestamp), amenities, shardPrecision, configHash, buildSequence: 0, completedAt: new Date().toISOString(), shardCount: 0, shards: [], totalElements: counts.mainUnique, counts };
            const replication = options.replication ?? null;
            state = { lastSeq: replication?.kind === 'planet' && replication?.interval === 'minute' ? replication.sequenceNumber : 0, lastUpdate: null, dataTimestamp: manifest.sourceTimestamp, sourcePbf, sourceFingerprint: manifest.sourceFingerprint, replication };
            index.db.exec('BEGIN IMMEDIATE');
            try {
                index.setMetadata('manifest', manifest);
                index.setMetadata('state', state);
                index.validate();
                index.db.exec('COMMIT');
            }
            catch (error) {
                index.db.exec('ROLLBACK');
                throw error;
            }
            index.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
        finally {
            index.close();
            await resolver.close();
        }
        // Keep each published baseline isolated, even if inputs have the same fingerprint.
        const finalId = `${generationId}-${randomUUID()}`;
        const generation = path.join(generations, finalId);
        manifest.generation = finalId;
        const finalized = new IndexDatabase(staging);
        try {
            finalized.setMetadata('manifest', manifest);
            finalized.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
        finally {
            finalized.close();
        }
        await writeSidecars(staging, manifest, state);
        await fs.rename(staging, generation);
        if (!publish)
            return { manifest, generationDir: generation };
        await activateGeneration(pipelineDir, generation, { lockHeld: true, beforeActivate: async ({ activeRoot: current }) => {
                if (!current)
                    return;
                const { state: old } = await readMetadata(current);
                if (old.replication?.sequenceNumber != null) {
                    if (!state.replication || ['baseUrl', 'kind', 'interval'].some(k => old.replication[k] !== state.replication[k]))
                        throw new Error('candidate snapshot has a different or missing source descriptor');
                    if (state.replication.sequenceNumber < old.replication.sequenceNumber)
                        throw new Error(`candidate stage sequence ${state.replication.sequenceNumber} is older than active sequence ${old.replication.sequenceNumber}`);
                }
                if (old.dataTimestamp && state.dataTimestamp && Date.parse(state.dataTimestamp) < Date.parse(old.dataTimestamp))
                    throw new Error('candidate source timestamp is older than active data timestamp');
            } });
        return manifest;
    });
}
