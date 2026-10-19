import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fetch as undiciFetch } from 'undici';
import { loadConfig } from '../dist/config.js';
import { fetchReplicationState, downloadDiff } from './update/replication.mjs';
import { applyDiffGeneration } from './update/apply-generation.mjs';
import { maybeRunReextract } from './update/reextract.mjs';

const MAX_DIFFS = 100000;
const MAX_DIFF_BYTES = 2 * 1024 * 1024 * 1024;

export function pipelineRoot(dataDir) {
  const resolved = path.resolve(dataDir);
  return path.basename(resolved) === 'data' ? path.dirname(resolved) : resolved;
}

export async function attestSourcePbf(pipelineDir, sourcePbf) {
  if (!sourcePbf) return null;
  const source = path.resolve(sourcePbf);
  const active = await fs.realpath(path.join(pipelineDir, 'data'));
  const state = JSON.parse(await fs.readFile(path.join(active, 'state.json'), 'utf8'));
  const expectedFingerprint = state.sourceFingerprint;
  if (!expectedFingerprint) throw new Error('active generation has no source fingerprint for validating OSM_AMENITY_SOURCE_PBF');
  const stat = await fs.stat(source, { bigint: true });
  const identity = { path: source, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
  const cacheKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const cacheDir = path.join(pipelineDir, 'update-cache', 'source-pbf-attestations');
  const attestationPath = path.join(cacheDir, `${cacheKey}.json`);
  let attestation = null;
  try { attestation = JSON.parse(await fs.readFile(attestationPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let fingerprint = attestation?.fingerprint;
  if (!attestation || attestation.fingerprint === undefined || Object.keys(identity).some((key) => attestation.identity?.[key] !== identity[key])) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    fingerprint = hash.digest('hex');
    await fs.mkdir(cacheDir, { recursive: true });
    const tmp = `${attestationPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ identity, fingerprint })}\n`);
    await fs.rename(tmp, attestationPath);
  }
  if (fingerprint !== expectedFingerprint) throw new Error('OSM_AMENITY_SOURCE_PBF fingerprint does not match active generation source');
  return fingerprint;
}

async function readState(pipelineDir) {
  const active = await fs.realpath(path.join(pipelineDir, 'data'));
  return { active, state: JSON.parse(await fs.readFile(path.join(active, 'state.json'), 'utf8')) };
}

async function resolveStateSource(pipelineDir, configuredSource, state) {
  const candidates = [...new Set([state.sourcePbf, configuredSource].filter(Boolean).map((file) => path.resolve(file)))];
  let lastError = null;
  for (const candidate of candidates) {
    try { return { sourcePbf: candidate, sourcePbfFingerprint: await attestSourcePbf(pipelineDir, candidate) }; }
    catch (error) { lastError = error; }
  }
  throw new Error(`no retained source PBF matches active generation fingerprint: ${lastError?.message ?? 'source path is missing'}`);
}

function sameNamespace(stateReplication, replication) {
  return stateReplication?.baseUrl === replication.baseUrl && stateReplication?.kind === replication.kind && stateReplication?.interval === replication.interval;
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('update cycle aborted');
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError(signal)); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Create an importable updater worker with network and mutation dependencies injectable for tests. */
export function createUpdateWorker({
  pipelineDir, replication, sourcePbf = null,
  amenities = ['toilets'], shardPrecision = 5, updateIntervalSeconds = 3600,
  reextractEverySeconds = 604800, reextractSourcePbf = null,
  fetchImpl = undiciFetch, fetchState = fetchReplicationState, download = downloadDiff,
  apply = applyDiffGeneration, checkReextract = maybeRunReextract,
  onLog = (message) => console.log(message), onError = (error) => console.error(error.stack ?? error),
  maxDiffs = MAX_DIFFS, maxDiffBytes = MAX_DIFF_BYTES
}) {
  const root = pipelineRoot(pipelineDir);

  async function runOnce(signal = undefined) {
    if (signal?.aborted) throw abortError(signal);
    const { state } = await readState(root);
    const cursor = state.replication?.sequenceNumber;
    if (!Number.isSafeInteger(cursor) || cursor <= 0) throw new Error('active generation has no valid namespace-local replication baseline; refusing catch-up from zero');
    if (!sameNamespace(state.replication, replication)) throw new Error('configured update source does not match the active generation replication namespace');
    const latest = await fetchState(replication, fetchImpl, { signal });
    if (latest.sequenceNumber < cursor) throw new Error(`replication source regressed from local sequence ${cursor} to ${latest.sequenceNumber}`);
    const gap = latest.sequenceNumber - cursor;
    if (gap > maxDiffs) throw new Error(`catch-up gap of ${gap} sequences exceeds the ${maxDiffs}-diff update limit; rebuild from a newer baseline`);
    if (gap === 0) { onLog(`up to date at ${cursor}`); return { fromSequence: cursor, toSequence: cursor, changedCount: 0, cells: [] }; }
    const verifiedSource = await resolveStateSource(root, sourcePbf, state);
    const diffFiles = [];
    let compressedBytes = 0;
    try {
      for (let sequence = cursor + 1; sequence <= latest.sequenceNumber; sequence += 1) {
        if (signal?.aborted) throw abortError(signal);
        const diff = path.join(root, 'work', 'update-diffs', `${sequence}.osc.gz`);
        const downloaded = await download(replication, sequence, diff, {
          maxBytes: 512 * 1024 * 1024,
          expectedMd5: sequence === latest.sequenceNumber ? latest.md5 : null,
          signal, fetchImpl
        });
        diffFiles.push(diff);
        compressedBytes += downloaded.bytes;
        if (compressedBytes > maxDiffBytes) throw new Error(`replication catch-up batch exceeds ${maxDiffBytes} compressed bytes`);
      }
      if (signal?.aborted) throw abortError(signal);
      const descriptor = { ...replication };
      if (latest.originalPlanetSequence) descriptor.originalMinuteSeq = latest.originalPlanetSequence;
      const result = await apply(root, diffFiles[0], {
        sequence: latest.sequenceNumber, diffFiles, replication: descriptor,
        dataTimestamp: latest.timestamp, amenities, shardPrecision, ...verifiedSource,
        signal
      });
      onLog(`applied ${replication.kind}/${replication.interval} sequences ${cursor + 1}-${latest.sequenceNumber}: ${result.changedCount} changed objects, ${result.cells.length} cells`);
      return { ...result, fromSequence: cursor + 1, toSequence: latest.sequenceNumber };
    } finally { await Promise.all(diffFiles.map((diff) => fs.rm(diff, { force: true }))); }
  }

  async function runWatch({ signal, checkIntervalSeconds = updateIntervalSeconds } = {}) {
    while (!signal?.aborted) {
      try { await runOnce(signal); } catch (error) { if (!signal?.aborted) onError(error); }
      if (!signal?.aborted) {
        try {
          let rebuildPbf = reextractSourcePbf ?? sourcePbf;
          if (!rebuildPbf) rebuildPbf = (await readState(root)).state.sourcePbf ?? null;
          const rebuilt = await checkReextract({ dataDir: root, sourcePbf: rebuildPbf, amenities, shardPrecision,
            replication, intervalSeconds: reextractEverySeconds, signal });
          if (rebuilt) onLog(`weekly re-extract activated sequence ${rebuilt.sequenceNumber}`);
        } catch (error) { if (!signal?.aborted) onError(error); }
      }
      if (signal?.aborted) break;
      try { await delay(checkIntervalSeconds * 1000, signal); } catch { break; }
    }
  }

  return { runOnce, runWatch };
}

export async function runOnce(options, signal = undefined) {
  return createUpdateWorker(options).runOnce(signal);
}

export async function runWatch(options, watchOptions = {}) {
  return createUpdateWorker(options).runWatch(watchOptions);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = loadConfig(env);
  const valueFor = (key) => { const at = argv.indexOf(key); return at < 0 ? null : argv[at + 1] ?? null; };
  const pipelineDir = pipelineRoot(valueFor('--data-dir') ?? config.dataDir);
  const sourcePbf = config.sourcePbf ? path.resolve(config.sourcePbf) : null;
  const replication = { baseUrl: config.updateBaseUrl, kind: config.updateKind, interval: config.updateGranularity };
  const worker = createUpdateWorker({ pipelineDir, replication, sourcePbf,
    reextractSourcePbf: config.reextractSourcePbf ? path.resolve(config.reextractSourcePbf) : null,
    amenities: config.amenities, shardPrecision: config.shardPrecision,
    updateIntervalSeconds: config.updateIntervalSeconds, reextractEverySeconds: config.reextractEverySeconds });
  if (!argv.includes('--watch')) return worker.runOnce();
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('update worker stopping'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await worker.runWatch({ signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}
