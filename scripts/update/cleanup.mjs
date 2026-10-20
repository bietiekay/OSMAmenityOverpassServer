import fs from 'node:fs/promises';
import path from 'node:path';
import { withGenerationLock } from './generation.mjs';

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

/** Remove only abandoned update work after the active cursor has been published. */
export async function cleanupOrphanedUpdateData(pipelineDir, { olderThanMs, publishedSequence }) {
  if (!Number.isFinite(olderThanMs) || !Number.isSafeInteger(publishedSequence) || publishedSequence < 1) {
    throw new Error('update cleanup requires a run start time and a published sequence');
  }
  return withGenerationLock(pipelineDir, async () => {
    const activeRoot = await fs.realpath(path.join(pipelineDir, 'data'));
    const activeState = JSON.parse(await fs.readFile(path.join(activeRoot, 'state.json'), 'utf8'));
    if (!Number.isSafeInteger(activeState.replication?.sequenceNumber) || activeState.replication.sequenceNumber < publishedSequence) {
      throw new Error('active generation has not published the cleanup sequence');
    }
    const workRoot = path.join(pipelineDir, 'work');
    const workDir = path.join(workRoot, 'update-diffs');
    const removed = { diffs: 0, coalesceDirs: 0, reextractDirs: 0, stagingDirs: 0, lookupDirs: 0, attestations: 0, linkTemps: 0 };
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
    return removed;
  });
}
