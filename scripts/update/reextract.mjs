import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { main as runExtraction } from '../extract.mjs';
import { buildIndex } from '../extract/assembly.mjs';
import { applyDiffBatchGeneration } from './apply-generation.mjs';
import { activateGeneration, withGenerationLock } from './generation.mjs';
import { downloadDiff, fetchReplicationState } from './replication.mjs';

const MAX_CATCHUP_DIFFS = 100000;
const MAX_CATCHUP_BYTES = 2 * 1024 * 1024 * 1024;

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

export function isReextractDue(state, now = Date.now(), intervalSeconds = 604800) {
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

async function buildCandidate({ pipelineDir, sourcePbf, amenities, shardPrecision, signal, extractOptions = {}, extraction = runExtraction }) {
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
  signal, fetchImpl = fetch, extraction = runExtraction, maxCatchupDiffs = MAX_CATCHUP_DIFFS,
  maxCatchupBytes = MAX_CATCHUP_BYTES, now = () => new Date().toISOString()
}) {
  const pipelineDir = pipelineRoot(dataDir);
  const source = sourcePbf?.trim();
  if (!source) throw new Error('a PBF path is required for the weekly re-extract');
  if (!replication?.baseUrl || !['planet', 'regional'].includes(replication.kind) || !['minute', 'day'].includes(replication.interval)) {
    throw new Error('a complete replication namespace is required for the weekly re-extract');
  }
  await fs.access(source);
  const initial = await readActive(pipelineDir);
  if (!namespaceMatches(initial.state.replication, replication)) throw new Error('configured replication namespace does not match the active generation');
  const candidate = await buildCandidate({ pipelineDir, sourcePbf: path.resolve(source), amenities, shardPrecision, signal, extraction });
  const candidateDir = candidate.generationDir;
  try {
    const candidateState = JSON.parse(await fs.readFile(path.join(candidateDir, 'state.json'), 'utf8'));
    const snapshotSequence = candidateState.replication?.sequenceNumber;
    if (!Number.isSafeInteger(snapshotSequence) || snapshotSequence <= 0) throw new Error('new PBF has no positive namespace-local replication sequence; refusing catch-up from zero');
    if (!namespaceMatches(candidateState.replication, replication)) throw new Error('new PBF replication metadata does not match the configured namespace');
    if (timestampMillis(candidateState.dataTimestamp) === null) throw new Error('new PBF has no valid source timestamp');
    if (!candidateState.sourceFingerprint || candidateState.sourcePbf !== path.resolve(source)) throw new Error('candidate source PBF provenance is incomplete');

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

/** Establish a weekly timer baseline on first startup, then check at each interval. */
export async function maybeRunReextract(options) {
  const pipelineDir = pipelineRoot(options.dataDir);
  const active = await readActive(pipelineDir);
  const scheduleFile = path.join(pipelineDir, '.reextract-schedule.json');
  const at = options.now?.() ?? new Date().toISOString();
  let schedule;
  try { schedule = JSON.parse(await fs.readFile(scheduleFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lastReextractAt = active.state.lastReextractAt ?? schedule?.lastReextractAt;
  if (!lastReextractAt) {
    await writeJsonAtomic(scheduleFile, { lastReextractAt: at });
    return null;
  }
  const shouldRun = isReextractDue({ lastReextractAt }, Date.parse(at), options.intervalSeconds ?? 604800);
  if (!shouldRun) return null;
  const result = await runReextract(options);
  await fs.rm(scheduleFile, { force: true });
  return result;
}
