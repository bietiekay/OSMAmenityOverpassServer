import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetch as undiciFetch } from 'undici';
import { main as runExtraction, sourceMetadata } from '../extract.mjs';
import { buildIndex } from '../extract/assembly.mjs';
import { applyDiffBatchGeneration } from './apply-generation.mjs';
import { activateGeneration, withGenerationLock } from './generation.mjs';
import { downloadDiff, fetchReplicationState } from './replication.mjs';
import { downloadCurrentPlanet } from './source-download.mjs';

const MAX_CATCHUP_DIFFS = 100000;
const MAX_CATCHUP_BYTES = 2 * 1024 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export function pipelineRoot(dataDir) {
  const resolved = path.resolve(dataDir);
  return path.basename(resolved) === 'data' ? path.dirname(resolved) : resolved;
}

function namespaceMatches(left, right) {
  return left?.baseUrl === right?.baseUrl && left?.kind === right?.kind && left?.interval === right?.interval;
}

function timestampMillis(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function isReextractDue(state, now = Date.now(), intervalSeconds = 15552000) {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) return false;
  const last = timestampMillis(state?.lastReextractAt);
  return last !== null && now - last >= intervalSeconds * 1000;
}

async function readActive(pipelineDir) {
  const root = await fs.realpath(path.join(pipelineDir, 'data'));
  const state = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  return { root, state, manifest };
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, file);
}

async function fileIdentity(file) {
  const stat = await fs.stat(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}

function sameFileIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function metadataForReextract(sourcePbf, replication, signal, onLog = () => {}) {
  const metadata = sourceMetadata(sourcePbf, { allowBootstrap: false });
  if (timestampMillis(metadata.timestamp) === null) throw new Error('new source PBF has no valid snapshot timestamp');
  if (metadata.replication && !namespaceMatches(metadata.replication, replication)) {
    throw new Error('new source PBF declares a different replication namespace');
  }
  if (metadata.replication && namespaceMatches(metadata.replication, replication) &&
      Number.isSafeInteger(metadata.replication.sequenceNumber) && metadata.replication.sequenceNumber > 0) return metadata;
  if (replication.kind !== 'planet' || replication.interval !== 'minute') {
    throw new Error('new source PBF has no valid cursor in the configured replication namespace');
  }
  onLog('re-extract source: deriving the new planet minute cursor from PBF timestamp');
  let stdout;
  try { ({ stdout } = await execFileAsync('pyosmium-get-changes', ['-O', sourcePbf], { encoding: 'utf8', signal })); }
  catch (error) { throw new Error(`could not derive minute cursor from new planet PBF: ${error.stderr || error.message}`); }
  const nextSequence = Number(stdout.trim());
  if (!Number.isSafeInteger(nextSequence) || nextSequence <= 1) throw new Error('pyosmium returned an invalid next replication sequence');
  return { ...metadata, replication: { ...replication, sequenceNumber: nextSequence - 1 } };
}

async function buildCandidate({ pipelineDir, sourcePbf, amenities, shardPrecision, metadata, signal, extractOptions = {}, extraction = runExtraction }) {
  const scratch = path.join(pipelineDir, 'work', `reextract-${randomUUID()}`);
  const sourceIdentity = await fileIdentity(sourcePbf);
  await fs.mkdir(scratch, { recursive: true });
  let candidate;
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('re-extract aborted');
    await extraction([
      '--source', sourcePbf,
      '--data-dir', scratch,
      '--stages', '0-4',
      '--amenities', amenities.join(','),
      '--shard-precision', String(shardPrecision),
      '--keep-chunks', 'false',
      ...Object.entries(extractOptions).flatMap(([key, value]) => [`--${key}`, String(value)])
    ], {
      ...(metadata ? { sourceMetadata: () => metadata } : {}),
      buildIndex: async (options) => {
        candidate = await buildIndex({ ...options, publish: false });
        return candidate;
      },
      wasAborted: () => Boolean(signal?.aborted)
    });
    if (signal?.aborted) throw signal.reason ?? new Error('re-extract aborted');
    if (!sameFileIdentity(sourceIdentity, await fileIdentity(sourcePbf))) throw new Error('re-extract source PBF changed during extraction');
    if (!candidate?.generationDir) throw new Error('extraction completed without producing a candidate generation');
    const scratchRoot = await fs.realpath(candidate.generationDir);
    const generations = path.join(pipelineDir, 'data-generations');
    await fs.mkdir(generations, { recursive: true });
    const destination = path.join(generations, `reextract-${randomUUID()}`);
    await fs.rename(scratchRoot, destination);
    candidate.generationDir = destination;
    candidate.manifest.generation = path.basename(destination);
    await writeJsonAtomic(path.join(destination, 'manifest.json'), candidate.manifest);
    return candidate;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Build from a PBF in isolation, catch it up to the live namespace, then activate once. */
export async function runReextract({
  dataDir, sourcePbf, amenities = ['toilets'], shardPrecision = 5, replication,
  signal, fetchImpl = undiciFetch, extraction = runExtraction, maxCatchupDiffs = MAX_CATCHUP_DIFFS,
  maxCatchupBytes = MAX_CATCHUP_BYTES, now = () => new Date().toISOString(), requireNewSource = false,
  onLog = () => {}
}) {
  const pipelineDir = pipelineRoot(dataDir);
  const source = sourcePbf?.trim();
  if (!source) throw new Error('a newer PBF path is required for the full re-extract');
  if (!replication?.baseUrl || !['planet', 'regional'].includes(replication.kind) || !['minute', 'day'].includes(replication.interval)) {
    throw new Error('a complete replication namespace is required for the full re-extract');
  }
  await fs.access(source);
  const initial = await readActive(pipelineDir);
  if (!namespaceMatches(initial.state.replication, replication)) throw new Error('configured replication namespace does not match the active generation');
  if (requireNewSource && path.resolve(source) === initial.state.sourcePbf) throw new Error('scheduled re-extract requires a new immutable source PBF; refusing to rebuild from the active baseline');
  const metadata = extraction === runExtraction ? await metadataForReextract(path.resolve(source), replication, signal, onLog) : null;
  if (requireNewSource && metadata && timestampMillis(metadata.timestamp) <= timestampMillis(initial.manifest.sourceTimestamp)) {
    throw new Error('new source PBF is not newer than the active baseline snapshot');
  }
  const candidate = await buildCandidate({ pipelineDir, sourcePbf: path.resolve(source), amenities, shardPrecision, metadata, signal, extraction });
  const candidateDir = candidate.generationDir;
  try {
    const candidateState = JSON.parse(await fs.readFile(path.join(candidateDir, 'state.json'), 'utf8'));
    const snapshotSequence = candidateState.replication?.sequenceNumber;
    if (!Number.isSafeInteger(snapshotSequence) || snapshotSequence <= 0) throw new Error('new PBF has no positive namespace-local replication sequence; refusing catch-up from zero');
    if (!namespaceMatches(candidateState.replication, replication)) throw new Error('new PBF replication metadata does not match the configured namespace');
    if (timestampMillis(candidateState.dataTimestamp) === null) throw new Error('new PBF has no valid source timestamp');
    if (!candidateState.sourceFingerprint || candidateState.sourcePbf !== path.resolve(source)) throw new Error('candidate source PBF provenance is incomplete');
    if (requireNewSource && candidateState.sourceFingerprint === initial.state.sourceFingerprint) throw new Error('new source PBF has the same fingerprint as the active baseline');
    if (requireNewSource && timestampMillis(candidateState.dataTimestamp) <= timestampMillis(initial.manifest.sourceTimestamp)) {
      throw new Error('new source PBF is not newer than the active baseline snapshot');
    }

    return await withGenerationLock(pipelineDir, async () => {
      if (signal?.aborted) throw signal.reason ?? new Error('re-extract aborted');
      const active = await readActive(pipelineDir);
      if (!namespaceMatches(active.state.replication, replication)) throw new Error('active generation changed to a different replication namespace during re-extract');
      const activeSequence = active.state.replication.sequenceNumber;
      if (!Number.isSafeInteger(activeSequence) || activeSequence <= 0) throw new Error('active generation has no positive namespace-local cursor; refusing catch-up from zero');
      const remote = await fetchReplicationState(replication, fetchImpl, { signal });
      const targetSequence = Math.max(activeSequence, remote.sequenceNumber);
      if (!Number.isSafeInteger(remote.sequenceNumber) || remote.sequenceNumber <= 0) throw new Error('replication source has no positive sequence');
      if (snapshotSequence > targetSequence) throw new Error(`new PBF cursor ${snapshotSequence} is ahead of replication source ${targetSequence}`);
      const gap = targetSequence - snapshotSequence;
      if (gap > maxCatchupDiffs) throw new Error(`new PBF catch-up gap ${gap} exceeds limit ${maxCatchupDiffs}`);
      let dataTimestamp = candidateState.dataTimestamp;
      if (gap > 0) {
        const files = [];
        let bytes = 0;
        try {
          for (let sequence = snapshotSequence + 1; sequence <= targetSequence; sequence += 1) {
            if (signal?.aborted) throw signal.reason ?? new Error('re-extract aborted');
            const file = path.join(pipelineDir, 'work', 'reextract-diffs', `${sequence}-${randomUUID()}.osc.gz`);
            const result = await downloadDiff(replication, sequence, file, {
              maxBytes: 512 * 1024 * 1024,
              expectedMd5: sequence === remote.sequenceNumber ? remote.md5 : null,
              signal, fetchImpl
            });
            bytes += result.bytes;
            if (bytes > maxCatchupBytes) throw new Error(`new PBF catch-up exceeds ${maxCatchupBytes} compressed bytes`);
            files.push(file);
          }
          const descriptor = { ...replication };
          if (remote.originalPlanetSequence) descriptor.originalMinuteSeq = remote.originalPlanetSequence;
          await applyDiffBatchGeneration(pipelineDir, files, {
            fromSequence: snapshotSequence + 1,
            toSequence: targetSequence,
            candidateGenerationDir: candidateDir,
            replication: descriptor,
            dataTimestamp: remote.sequenceNumber >= targetSequence ? remote.timestamp : active.state.dataTimestamp,
            amenities, shardPrecision,
            sourcePbf: path.resolve(source),
            sourcePbfFingerprint: candidateState.sourceFingerprint,
            signal
          });
          dataTimestamp = remote.sequenceNumber >= targetSequence ? remote.timestamp : active.state.dataTimestamp;
        } finally {
          await Promise.all(files.map((file) => fs.rm(file, { force: true })));
        }
      }
      if (signal?.aborted) throw signal.reason ?? new Error('re-extract aborted');
      const updatedState = JSON.parse(await fs.readFile(path.join(candidateDir, 'state.json'), 'utf8'));
      if (updatedState.replication.sequenceNumber < activeSequence || updatedState.replication.sequenceNumber < snapshotSequence) {
        throw new Error('candidate cursor would regress the active generation');
      }
      if (timestampMillis(dataTimestamp) !== null) updatedState.dataTimestamp = dataTimestamp;
      updatedState.lastSeq = replication.kind === 'planet' && replication.interval === 'minute'
        ? updatedState.replication.sequenceNumber
        : 0;
      updatedState.lastReextractAt = now();
      await writeJsonAtomic(path.join(candidateDir, 'state.json'), updatedState);
      await activateGeneration(pipelineDir, candidateDir, {
        lockHeld: true,
        beforeActivate: ({ activeRoot, state }) => {
          if (activeRoot !== active.root) throw new Error('active generation changed during locked re-extract');
          if (!namespaceMatches(state.replication, replication) || state.replication.sequenceNumber < activeSequence) {
            throw new Error('candidate is not caught up to the locked active generation');
          }
        }
      });
      return { generationDir: candidateDir, sequenceNumber: updatedState.replication.sequenceNumber, dataTimestamp: updatedState.dataTimestamp };
    });
  } catch (error) {
    const current = await fs.realpath(path.join(pipelineDir, 'data')).catch(() => null);
    const candidate = await fs.realpath(candidateDir).catch(() => null);
    // activateGeneration can switch the symlink and then fail while syncing its
    // parent directory. Never remove a candidate that is already serving.
    if (candidate && current !== candidate) await fs.rm(candidate, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Establish a timer baseline on first enabled check, then rebuild when due. */
export async function maybeRunReextract(options) {
  const intervalSeconds = options.intervalSeconds ?? 15552000;
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) return null;
  const pipelineDir = pipelineRoot(options.dataDir);
  const active = await readActive(pipelineDir);
  const scheduleFile = path.join(pipelineDir, '.reextract-schedule.json');
  const at = options.now?.() ?? new Date().toISOString();
  let schedule;
  try { schedule = JSON.parse(await fs.readFile(scheduleFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!active.state.lastReextractAt && schedule?.intervalSeconds !== intervalSeconds) {
    await writeJsonAtomic(scheduleFile, { lastReextractAt: at, intervalSeconds });
    return null;
  }
  const lastReextractAt = active.state.lastReextractAt ?? schedule?.lastReextractAt;
  if (!lastReextractAt) {
    await writeJsonAtomic(scheduleFile, { lastReextractAt: at, intervalSeconds });
    return null;
  }
  const shouldRun = isReextractDue({ lastReextractAt }, Date.parse(at), intervalSeconds);
  if (!shouldRun) return null;
  let sourcePbf = options.sourcePbf;
  if (!sourcePbf) {
    if (options.replication?.kind !== 'planet' || options.replication?.interval !== 'minute') {
      throw new Error('regional re-extract requires an explicit newer source PBF');
    }
    sourcePbf = await downloadCurrentPlanet(pipelineDir, {
      url: options.sourceUrl, checksumUrl: options.checksumUrl,
      signal: options.signal, fetchImpl: options.fetchImpl ?? undiciFetch,
      onLog: options.onLog
    });
  }
  const result = await runReextract({ ...options, sourcePbf });
  await fs.rm(scheduleFile, { force: true });
  return result;
}
