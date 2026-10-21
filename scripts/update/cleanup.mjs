import fs from 'node:fs/promises';
import path from 'node:path';
import { withGenerationLock } from './generation.mjs';

const GENERATION_GRACE_MS = 60 * 60 * 1000;

const entries = async (directory) => fs.readdir(directory, { withFileTypes: true })
  .catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));

async function removeOldDirectories(directory, pattern, olderThanMs) {
  let removed = 0;
  for (const entry of await entries(directory)) {
    if (!entry.isDirectory() || !pattern.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const stat = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat?.isDirectory() || stat.mtimeMs >= olderThanMs) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function removePublishedDiffs(directory, pattern, publishedSequence) {
  let removed = 0;
  for (const entry of await entries(directory)) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(pattern);
    if (!match || Number(match[1]) > publishedSequence) continue;
    await fs.rm(path.join(directory, entry.name), { force: true });
    removed += 1;
  }
  return removed;
}

async function removeOldFiles(directory, pattern, olderThanMs) {
  let removed = 0;
  for (const entry of await entries(directory)) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const stat = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat?.isFile() || stat.mtimeMs >= olderThanMs) continue;
    await fs.rm(target, { force: true });
    removed += 1;
  }
  return removed;
}

async function prunePublishedGenerations(pipelineDir, activeRoot, keepCount, onProgress) {
  const directory = path.join(pipelineDir, 'data-generations');
  const generationRoot = await fs.realpath(directory);
  if (path.dirname(activeRoot) !== generationRoot) throw new Error('active generation is outside data-generations; retention skipped');
  const candidates = [];
  for (const entry of await entries(generationRoot)) {
    if (!entry.isDirectory()) continue;
    const update = /^update-(\d+)-[0-9a-f-]+$/.exec(entry.name);
    const build = /^build-[0-9a-f]{64}-[0-9a-f-]+$/.test(entry.name);
    const reextract = /^reextract-[0-9a-f-]+$/.test(entry.name);
    if (!update && !build && !reextract) continue;
    const target = path.join(generationRoot, entry.name);
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) continue;
    const state = await fs.readFile(path.join(target, 'state.json'), 'utf8').then(JSON.parse).catch(() => null);
    const manifest = await fs.readFile(path.join(target, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (!Number.isSafeInteger(state?.replication?.sequenceNumber) || !Array.isArray(manifest?.shards)) continue;
    // A re-extract is moved into data-generations before activation. Its
    // completion marker distinguishes a published generation from that work.
    const markerTime = update ? Number(update[1]) : reextract ? Date.parse(state.lastReextractAt ?? '') : stat.mtimeMs;
    if (!Number.isFinite(markerTime) || markerTime <= 0) continue;
    // The update ID records transaction start, not publication. The directory
    // ctime advances when it is renamed into its published location, so use
    // the later time for the in-flight-query grace period.
    const publishedAt = Math.max(markerTime, stat.ctimeMs);
    candidates.push({ target, name: entry.name, publishedAt });
  }
  candidates.sort((left, right) => right.publishedAt - left.publishedAt || right.name.localeCompare(left.name));
  const kept = new Set([activeRoot]);
  for (const candidate of candidates) {
    if (kept.size >= keepCount) break;
    kept.add(candidate.target);
  }
  const cutoff = Date.now() - GENERATION_GRACE_MS;
  const obsolete = candidates.filter((candidate) => !kept.has(candidate.target) && candidate.publishedAt < cutoff);
  let removed = 0;
  for (const candidate of obsolete) {
    onProgress(`generation retention: removing ${candidate.name} (${removed + 1}/${obsolete.length})`);
    await fs.rm(candidate.target, { recursive: true });
    removed += 1;
  }
  return removed;
}

/** Remove abandoned update work and old published generations under the generation lock. */
export async function cleanupOrphanedUpdateData(pipelineDir, { olderThanMs, publishedSequence, generationsToKeep = 2, onProgress = () => {} }) {
  if (!Number.isFinite(olderThanMs) || !Number.isSafeInteger(publishedSequence) || publishedSequence < 1 ||
      !Number.isSafeInteger(generationsToKeep) || generationsToKeep < 2) {
    throw new Error('update cleanup requires a run start time, a published sequence, and at least two retained generations');
  }
  return withGenerationLock(pipelineDir, async () => {
    const activeRoot = await fs.realpath(path.join(pipelineDir, 'data'));
    const activeState = JSON.parse(await fs.readFile(path.join(activeRoot, 'state.json'), 'utf8'));
    if (!Number.isSafeInteger(activeState.replication?.sequenceNumber) || activeState.replication.sequenceNumber < publishedSequence) {
      throw new Error('active generation has not published the cleanup sequence');
    }
    const workRoot = path.join(pipelineDir, 'work');
    const workDir = path.join(workRoot, 'update-diffs');
    const removed = { diffs: 0, coalesceDirs: 0, reextractDirs: 0, stagingDirs: 0, lookupDirs: 0, attestations: 0, linkTemps: 0, publishedGenerations: 0 };
    removed.diffs += await removePublishedDiffs(
      workDir, /^([1-9]\d*)\.osc\.gz(?:\.[0-9a-f-]+\.tmp)?$/, publishedSequence
    );
    removed.diffs += await removePublishedDiffs(
      path.join(workRoot, 'reextract-diffs'), /^([1-9]\d*)-[0-9a-f-]+\.osc\.gz(?:\.[0-9a-f-]+\.tmp)?$/, publishedSequence
    );
    removed.coalesceDirs = await removeOldDirectories(workDir, /^coalesce-\d+-[0-9a-f-]+$/, olderThanMs);
    removed.reextractDirs = await removeOldDirectories(workRoot, /^reextract-[0-9a-f-]+$/, olderThanMs);
    removed.stagingDirs = await removeOldDirectories(
      path.join(pipelineDir, 'data-generations'), /^\.update-\d+-[0-9a-f-]+\.staging$/, olderThanMs
    );
    const cacheDir = path.join(pipelineDir, 'update-cache');
    removed.attestations = await removeOldFiles(
      path.join(cacheDir, 'source-pbf-attestations'), /^[0-9a-f]{64}\.json\.\d+\.tmp$/, olderThanMs
    );
    for (const source of await entries(cacheDir)) {
      if (!source.isDirectory() || !/^source-(?:[0-9a-f]+|unknown)$/.test(source.name)) continue;
      removed.lookupDirs += await removeOldDirectories(
        path.join(cacheDir, source.name, 'tmp'), /^resolve-[0-9a-f-]+$/, olderThanMs
      );
    }
    for (const entry of await entries(pipelineDir)) {
      if (!entry.isSymbolicLink() || !/^\.data-(?:update-\d+-)?[0-9a-f-]+$/.test(entry.name)) continue;
      const target = path.join(pipelineDir, entry.name);
      const stat = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!stat?.isSymbolicLink() || stat.mtimeMs >= olderThanMs) continue;
      await fs.rm(target, { force: true });
      removed.linkTemps += 1;
    }
    removed.publishedGenerations = await prunePublishedGenerations(pipelineDir, activeRoot, generationsToKeep, onProgress);
    return removed;
  });
}
