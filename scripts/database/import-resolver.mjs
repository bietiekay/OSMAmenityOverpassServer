import fs from 'node:fs/promises';
import path from 'node:path';
import { buildSourceBlockIndex, openSourceBlockIndex } from '../extract/source-index.mjs';
/** Fill references absent from the direct-member extraction streams (nested relations). */
export function createImportResolver(index, { pipelineDir, sourcePbf, sourceFingerprint, onProgress = () => { } }) {
    let source = null;
    let unavailable = false;
    const openSource = async () => {
        if (source || unavailable)
            return source;
        if (!sourcePbf || !await fs.stat(sourcePbf).catch(error => { if (error.code === 'ENOENT')
            return null; throw error; })) {
            unavailable = true;
            return null;
        }
        const cacheDir = path.join(pipelineDir, 'update-cache', `source-${sourceFingerprint ?? 'unknown'}`);
        const cached = await fs.readFile(path.join(cacheDir, 'index.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT' || error instanceof SyntaxError)
            return null; throw error; });
        if (!cached || cached.sourceFingerprint !== sourceFingerprint)
            await buildSourceBlockIndex(sourcePbf, cacheDir, { sourceFingerprint, onProgress });
        source = await openSourceBlockIndex(cacheDir, { sourcePbf, expectedFingerprint: sourceFingerprint });
        return source;
    };
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
    const many = async (requests) => {
        const missing = [...new Map(requests.map(r => [`${r.type}:${r.id}`, r])).values()].filter(r => !index.getRaw(`${r.type}:${r.id}`));
        if (!missing.length || !await openSource())
            return;
        for (let offset = 0; offset < missing.length; offset += 400) {
            const part = missing.slice(offset, offset + 400);
            const objects = await resolvePart(part);
            for (const raw of objects) {
                index.putRaw(raw);
                index.statement('INSERT OR REPLACE INTO baseline_versions VALUES(?,?)').run(`${raw.type}:${raw.id}`, raw.version);
            }
        }
    };
    const resolve = async (type, id) => { await many([{ type, id }]); return index.getRaw(`${type}:${id}`); };
    resolve.many = many;
    return { resolve, close: async () => { if (source)
            await source.close(); } };
}
