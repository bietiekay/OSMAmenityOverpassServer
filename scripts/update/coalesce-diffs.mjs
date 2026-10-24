import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, createReadStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { readLfLines } from '../read-lines.mjs';
import { parseOsmChange } from './change-parser.mjs';
import { openDiffXml } from './replication.mjs';
import { sortWithProgress } from './progress-sort.mjs';
import { deltaPartitionForKey } from './delta-store.mjs';

const MAX_SPOOL_BYTES = 128 * 1024 * 1024 * 1024;

async function writeLine(stream, line) {
  if (!stream.write(line)) await once(stream, 'drain');
}

/** Keep the last sequence-ordered event per typed OSM ID, grouped for delta writes. */
export async function coalesceDiffFiles(diffFiles, workDir, { signal, onProgress = () => {}, maxSpoolBytes = MAX_SPOOL_BYTES } = {}) {
  if (!Array.isArray(diffFiles) || diffFiles.length === 0) throw new Error('at least one replication diff file is required to coalesce');
  const tempDir = path.join(workDir, `coalesce-${process.pid}-${randomUUID()}`);
  const raw = path.join(tempDir, 'changes.unsorted.tsv');
  const sorted = path.join(tempDir, 'changes.sorted.tsv');
  const unique = path.join(tempDir, 'changes.latest.by-partition.tsv');
  await fs.mkdir(tempDir, { recursive: true });
  let rawStream;
  try {
    rawStream = createWriteStream(raw, { flags: 'wx' });
    let eventCount = 0;
    let spoolBytes = 0;
    let maxObjectTimestamp = 0;
    for (let fileIndex = 0; fileIndex < diffFiles.length; fileIndex += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error('update coalescing aborted');
      let objectIndex = 0;
      onProgress({ phase: 'coalescing replication diffs', completed: fileIndex, total: diffFiles.length, unit: 'diffs', batchCompletedDiffs: fileIndex, detail: `reading ${path.basename(diffFiles[fileIndex])}; ${eventCount.toLocaleString('en-US')} changes seen` });
      for await (const change of parseOsmChange(openDiffXml(diffFiles[fileIndex], { signal }))) {
        if (signal?.aborted) throw signal.reason ?? new Error('update coalescing aborted');
        if (change.timestamp > maxObjectTimestamp) maxObjectTimestamp = change.timestamp;
        const key = `${change.type}:${change.id}`;
        const bucket = String(deltaPartitionForKey(key)).padStart(5, '0');
        const orderedKey = `${change.type}:${String(change.id).padStart(16, '0')}`;
        const payload = Buffer.from(JSON.stringify(change), 'utf8').toString('base64');
        const row = `${bucket}\t${orderedKey}\t${String(fileIndex).padStart(6, '0')}\t${String(objectIndex).padStart(16, '0')}\t${payload}\n`;
        spoolBytes += Buffer.byteLength(row);
        if (spoolBytes > maxSpoolBytes) throw new Error(`coalesced diff spool exceeds ${maxSpoolBytes} bytes; reduce the replication gap or use a newer baseline`);
        await writeLine(rawStream, row);
        objectIndex += 1;
        eventCount += 1;
        if (eventCount % 10000 === 0) {
          onProgress({ phase: 'coalescing replication diffs', completed: fileIndex, total: diffFiles.length, unit: 'diffs', batchCompletedDiffs: fileIndex, detail: `${eventCount.toLocaleString('en-US')} changes seen; ${Math.round(spoolBytes / (1024 * 1024))} MiB spool` });
        }
      }
      onProgress({ phase: 'coalescing replication diffs', completed: fileIndex + 1, total: diffFiles.length, unit: 'diffs', batchCompletedDiffs: fileIndex + 1, detail: `${eventCount.toLocaleString('en-US')} changes seen` });
    }
    rawStream.end();
    await finished(rawStream);
    rawStream = null;

    await sortWithProgress(raw, sorted, ['-S', '32M', '-T', tempDir, '-t', '\t', '-k1,1', '-k2,2', '-k3,3', '-k4,4'], {
      signal,
      detail: `${eventCount.toLocaleString('en-US')} changes; ${Math.round(spoolBytes / (1024 * 1024))} MiB spool`,
      onProgress: (event) => onProgress({ phase: 'sorting changes by delta partition', batchCompletedDiffs: diffFiles.length, ...event })
    });
    await fs.rm(raw, { force: true });

    const sortedLines = readLfLines(createReadStream(sorted));
    const output = createWriteStream(unique, { flags: 'wx' });
    let currentKey = null;
    let currentObject = null;
    let currentBucket = null;
    let sortedCount = 0;
    let uniqueCount = 0;
    try {
      onProgress({ phase: 'reducing duplicate object changes', completed: 0, total: eventCount, unit: 'changes', batchCompletedDiffs: diffFiles.length });
      for await (const line of sortedLines) {
        if (signal?.aborted) throw signal.reason ?? new Error('update coalescing aborted');
        const first = line.indexOf('\t');
        const second = line.indexOf('\t', first + 1);
        const third = line.indexOf('\t', second + 1);
        const fourth = line.indexOf('\t', third + 1);
        if (first < 0 || second < 0 || third < 0 || fourth < 0) throw new Error('invalid sorted diff spool row ' + (sortedCount + 1) + ': ' + JSON.stringify(line.slice(0, 1000)));
        const bucket = line.slice(0, first);
        const key = line.slice(0, second);
        const object = line.slice(fourth + 1);
        if (currentKey !== null && key !== currentKey) {
          await writeLine(output, `${currentBucket}\t${currentObject}\n`);
          uniqueCount += 1;
        }
        currentKey = key;
        currentBucket = bucket;
        currentObject = object;
        sortedCount += 1;
        if (sortedCount % 10000 === 0) {
          onProgress({ phase: 'reducing duplicate object changes', completed: sortedCount, total: eventCount, unit: 'changes', batchCompletedDiffs: diffFiles.length, detail: `${uniqueCount.toLocaleString('en-US')} unique objects emitted` });
        }
      }
      if (currentObject !== null) {
        await writeLine(output, `${currentBucket}\t${currentObject}\n`);
        uniqueCount += 1;
      }
      output.end();
      await finished(output);
    } catch (error) {
      output.destroy();
      await finished(output).catch(() => {});
      throw error;
    }
    await fs.rm(sorted, { force: true });
    onProgress({ phase: 'reducing duplicate object changes', completed: eventCount, total: eventCount, unit: 'changes', batchCompletedDiffs: diffFiles.length, detail: `${uniqueCount.toLocaleString('en-US')} unique objects remain` });
    return {
      file: unique,
      eventCount,
      uniqueCount,
      maxObjectTimestamp,
      cleanup: () => fs.rm(tempDir, { recursive: true, force: true })
    };
  } catch (error) {
    rawStream?.destroy();
    await finished(rawStream).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
