import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { IndexDatabase, objectKey } from '../../dist/index/database.js';
import { buildConfigHash } from '../../dist/index/shard.js';
import { readLfLines } from '../read-lines.mjs';
import { buildSourceBlockIndex, openSourceBlockIndex } from '../extract/source-index.mjs';
import { coalesceDiffFiles } from '../update/coalesce-diffs.mjs';
import { withGenerationLock } from '../update/generation.mjs';
import { buildGeometry } from './geometry.mjs';
import { writeSidecars } from './metadata.mjs';
const check = (signal) => { if (signal?.aborted)
    throw signal.reason ?? new Error('update aborted'); };
const sameNamespace = (a, b) => a && b && ['baseUrl', 'kind', 'interval'].every(k => a[k] === b[k]);
/** In-place, atomic diff batch. The baseline directory remains stable until a full rebuild. */
export async function applyDatabaseDiff(pipelineDir, diffFile, options) {
    const { sequence, replication, amenities = ['toilets'], shardPrecision = 5, signal, onProgress = () => { }, candidateGenerationDir = null, fromSequence = null, dataTimestamp = null, beforePublish = null, engine = null, maxBatchBytes = 8 * 1024 * 1024 } = options;
    const inputs = options.diffFiles ?? [diffFile];
    if (!Number.isSafeInteger(sequence) || sequence <= 0)
        throw new Error('valid target sequence is required');
    if (!Array.isArray(inputs) || !inputs.length)
        throw new Error('at least one replication diff file is required');
    const workers = Number(options.updateWorkers ?? process.env.OSM_AMENITY_UPDATE_WORKERS ?? 1);
    if (!Number.isSafeInteger(workers) || workers < 1 || workers > 16)
        throw new Error('OSM_AMENITY_UPDATE_WORKERS must be an integer from 1 to 16');
    check(signal);
    const spool = await coalesceDiffFiles(inputs, path.join(pipelineDir, 'work', 'update-diffs'), { signal, onProgress });
    const run = async () => {
        const root = candidateGenerationDir ?? await fs.realpath(path.join(pipelineDir, 'data'));
        const index = new IndexDatabase(root);
        let source = null;
        let inTransaction = false;
        let state, manifest, result;
        try {
            state = index.getMetadata('state');
            manifest = index.getMetadata('manifest');
            if (manifest.configHash !== buildConfigHash({ amenities, precision: shardPrecision }).toString('hex'))
                throw new Error('active generation config does not match updater config');
            if (!sameNamespace(state.replication, replication))
                throw new Error('replication source descriptor does not match the active generation baseline');
            const cursor = state.replication.sequenceNumber;
            if (!Number.isSafeInteger(cursor) || cursor <= 0)
                throw new Error('active generation has no namespace-local replication sequence');
            if (sequence !== cursor + inputs.length)
                throw new Error(`diff sequence batch gap: expected ${cursor + inputs.length}, got ${sequence}`);
            if (fromSequence !== null && fromSequence !== cursor + 1)
                throw new Error(`diff batch starts at ${fromSequence}, but generation cursor requires ${cursor + 1}`);
            const sourcePbf = options.sourcePbf ?? state.sourcePbf;
            if (!sourcePbf)
                throw new Error('active generation has no retained source PBF for baseline lookups');
            if (options.sourcePbfFingerprint && options.sourcePbfFingerprint !== state.sourceFingerprint)
                throw new Error('source PBF override fingerprint does not match the active generation');
            const cacheDir = path.join(pipelineDir, 'update-cache', `source-${state.sourceFingerprint ?? 'unknown'}`);
            let cached = await fs.readFile(path.join(cacheDir, 'index.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT' || e instanceof SyntaxError)
                return null; throw e; });
            if (cached && state.sourceFingerprint && cached.sourceFingerprint !== state.sourceFingerprint)
                cached = null;
            if (!cached)
                await buildSourceBlockIndex(sourcePbf, cacheDir, { sourceFingerprint: state.sourceFingerprint, onProgress });
            source = await openSourceBlockIndex(cacheDir, { sourcePbf, expectedFingerprint: state.sourceFingerprint });
            const resolvePart = async (requests) => {
                try {
                    return (await source.resolveObjects(requests, { maxRequests: 400, maxCandidateBytes: 64 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024 })).objects;
                }
                catch (error) {
                    if (requests.length <= 1 || !/request a smaller lookup batch/.test(error.message))
                        throw error;
                    const half = Math.floor(requests.length / 2);
                    return [...await resolvePart(requests.slice(0, half)), ...await resolvePart(requests.slice(half))];
                }
            };
            // Baseline versions are cached separately: an unrelated delta can be older
            // than the baseline and must not win when it later becomes a dependency.
            const ensureBaseline = async (requests) => {
                const missing = [...new Map(requests.map(r => [objectKey(r), r])).values()].filter(r => !index.statement('SELECT 1 FROM baseline_versions WHERE key=?').get(objectKey(r)));
                for (let offset = 0; offset < missing.length; offset += 400 * workers) {
                    check(signal);
                    const parts = [];
                    for (let i = offset; i < Math.min(missing.length, offset + 400 * workers); i += 400)
                        parts.push(missing.slice(i, i + 400));
                    const settled = await Promise.allSettled(parts.map(resolvePart));
                    const failed = settled.find(r => r.status === 'rejected');
                    if (failed)
                        throw failed.reason;
                    for (let i = 0; i < parts.length; i++) {
                        const found = new Map(settled[i].value.map(raw => [objectKey(raw), raw]));
                        for (const request of parts[i]) {
                            const key = objectKey(request), raw = found.get(key);
                            if (raw)
                                index.putRaw(raw);
                            index.statement('INSERT INTO baseline_versions VALUES(?,?)').run(key, raw?.version ?? 0);
                        }
                    }
                }
            };
            index.db.exec(`CREATE TEMP TABLE changes(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TEMP TABLE affected(key TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TEMP TABLE obsolete(key TEXT PRIMARY KEY) WITHOUT ROWID;`);
            // Parsing and staging do not hold the write transaction on the live database.
            let seen = 0;
            index.db.exec('BEGIN');
            inTransaction = true;
            for await (const line of readLfLines(createReadStream(spool.file))) {
                check(signal);
                const divider = line.indexOf('\t');
                if (divider < 1)
                    throw new Error('invalid coalesced diff row');
                const payload = Buffer.from(line.slice(divider + 1), 'base64').toString('utf8');
                if (Buffer.byteLength(payload) > maxBatchBytes)
                    throw new Error('coalesced change exceeds update object byte limit');
                const change = JSON.parse(payload);
                index.statement('INSERT INTO changes VALUES(?,?)').run(objectKey(change), payload);
                seen++;
            }
            if (seen !== spool.uniqueCount)
                throw new Error('coalesced update count mismatch');
            index.db.exec('COMMIT');
            inTransaction = false;
            index.db.exec('BEGIN IMMEDIATE');
            inTransaction = true;
            const relevantSql = `SELECT c.key,c.payload FROM changes c WHERE c.key>? AND (
        EXISTS(SELECT 1 FROM dependencies d WHERE d.object_key=c.key)
        OR EXISTS(SELECT 1 FROM geometry g WHERE g.key=c.key AND g.is_main=1)
        OR json_extract(c.payload,'$.tags.amenity') IN (SELECT value FROM json_each(?))) ORDER BY c.key LIMIT 400`;
            let last = '';
            let relevant = 0;
            while (true) {
                const rows = index.statement(relevantSql).all(last, JSON.stringify(amenities));
                if (!rows.length)
                    break;
                await ensureBaseline(rows.map(row => JSON.parse(row.payload)));
                for (const row of rows) {
                    const change = JSON.parse(row.payload);
                    const old = index.getRaw(row.key);
                    if (change.version > (old?.version ?? 0)) {
                        for (const main of index.affectedMains(row.key))
                            index.statement('INSERT OR IGNORE INTO affected VALUES(?)').run(main);
                        if (index.isMain(row.key) || amenities.includes(change.tags?.amenity))
                            index.statement('INSERT OR IGNORE INTO affected VALUES(?)').run(row.key);
                        relevant++;
                    }
                    last = String(row.key);
                }
                onProgress({ phase: 'identifying affected database objects', completed: relevant, total: null, unit: 'objects' });
            }
            const affectedCount = Number(index.statement('SELECT count(*) AS n FROM affected').get().n);
            if (affectedCount > 50000)
                throw new Error('update dependency closure exceeds 50000 OSM objects; split the update batch');
            // Persist all current delta objects, including currently unrelated geometry:
            // a later toilet may start referencing any of them.
            last = '';
            let applied = 0;
            while (true) {
                const rows = index.statement('SELECT key,payload FROM changes WHERE key>? ORDER BY key LIMIT 1000').all(last);
                if (!rows.length)
                    break;
                for (const row of rows) {
                    check(signal);
                    const raw = JSON.parse(row.payload);
                    raw.deleted = raw.action === 'delete';
                    delete raw.action;
                    index.putRaw(raw);
                    last = String(row.key);
                    applied++;
                }
                onProgress({ phase: 'writing database delta objects', completed: applied, total: seen, unit: 'objects' });
            }
            const resolve = async (type, id) => {
                await ensureBaseline([{ type, id }]);
                const raw = index.getRaw(`${type}:${id}`);
                return raw?.deleted ? null : raw;
            };
            resolve.many = ensureBaseline;
            // Demote all affected mains before rebuilding helpers shared with them.
            // This avoids retaining stale main payloads when an amenity loses its tag
            // but remains a geometry member of another amenity.
            for (const row of index.statement('SELECT key FROM affected').all()) {
                for (const key of index.clearMain(String(row.key)))
                    index.statement('INSERT OR IGNORE INTO obsolete VALUES(?)').run(key);
            }
            last = '';
            let rebuilt = 0;
            while (true) {
                const rows = index.statement('SELECT key FROM affected WHERE key>? ORDER BY key LIMIT 100').all(last);
                if (!rows.length)
                    break;
                for (const row of rows) {
                    check(signal);
                    const [type, id] = row.key.split(':');
                    const raw = await resolve(type, Number(id));
                    const obsolete = raw && amenities.includes(raw.tags?.amenity) ? null : index.clearMain(row.key);
                    if (obsolete)
                        for (const key of obsolete)
                            index.statement('INSERT OR IGNORE INTO obsolete VALUES(?)').run(key);
                    else {
                        const built = await buildGeometry(raw, resolve, { signal });
                        for (const key of index.setMain(built.main, built.helpers, built.dependencies))
                            index.statement('INSERT OR IGNORE INTO obsolete VALUES(?)').run(key);
                    }
                    last = String(row.key);
                    rebuilt++;
                    onProgress({ phase: 'rebuilding affected database geometry', completed: rebuilt, total: affectedCount, unit: 'amenities' });
                }
            }
            // Prune only touched helper geometries; no whole-index sweep or recount.
            for (const row of index.statement('SELECT key FROM obsolete').iterate())
                index.pruneGeometry([String(row.key)]);
            manifest = { ...manifest, buildSequence: sequence, totalElements: index.counts().mainUnique, counts: index.counts() };
            const stamp = dataTimestamp ?? (spool.maxObjectTimestamp ? new Date(spool.maxObjectTimestamp * 1000).toISOString() : state.dataTimestamp);
            state = { ...state, lastSeq: replication.kind === 'planet' && replication.interval === 'minute' ? sequence : state.lastSeq, lastUpdate: new Date().toISOString(), dataTimestamp: stamp, replication: { ...replication, sequenceNumber: sequence } };
            index.setMetadata('manifest', manifest);
            index.setMetadata('state', state);
            result = { sequence, changedCount: relevant, cells: [], affectedObjects: affectedCount };
            if (beforePublish)
                await beforePublish(root, result);
            check(signal);
            onProgress({ phase: 'committing database update', completed: 0, total: 1, unit: 'transactions' });
            index.db.exec('COMMIT');
            inTransaction = false;
            onProgress({ phase: 'committing database update', completed: 1, total: 1, unit: 'transactions' });
            // Readers use bounded snapshots. PASSIVE never waits for active readers.
            try {
                index.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
            }
            catch (error) {
                onProgress({ phase: 'database checkpoint warning', completed: 0, total: null, unit: 'checkpoints', detail: error.message });
            }
            engine?.invalidateCells([]);
        }
        catch (error) {
            if (inTransaction)
                index.db.exec('ROLLBACK');
            throw error;
        }
        finally {
            index.close();
            if (source)
                await source.close();
        }
        // A diagnostic sidecar failure cannot undo a committed replication cursor.
        try {
            await writeSidecars(root, manifest, state);
        }
        catch (error) {
            onProgress({ phase: 'database sidecar warning', completed: 0, total: null, unit: 'files', detail: error.message });
        }
        return result;
    };
    try {
        return candidateGenerationDir ? await run() : await withGenerationLock(pipelineDir, run);
    }
    finally {
        await spool.cleanup();
    }
}
