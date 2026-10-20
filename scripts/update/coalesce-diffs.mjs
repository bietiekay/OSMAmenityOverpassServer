import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, createReadStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import readline from 'node:readline';
import { parseOsmChange } from './change-parser.mjs';
import { openDiffXml } from './replication.mjs';

const MAX_SPOOL_BYTES = 128 * 1024 * 1024 * 1024;

async function writeLine(stream, line) {
  if (!stream.write(line)) await once(stream, 'drain');
}

async function sortChanges(input, output, tempDir, signal) {
  await new Promise((resolve, reject) => {
    const child = spawn('sort', ['-S', '32M', '-T', tempDir, '-t', '\t', '-k1,1', '-k2,2', '-k3,3', input, '-o', output], {
      env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length); });
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code, childSignal) => {
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve();
      else reject(signal?.aborted ? signal.reason ?? new Error('update coalescing aborted') : new Error(`sort coalesced diffs failed (${code ?? childSignal}): ${stderr}`));
    });
    if (signal?.aborted) abort();
  });
}

/** Keep only the last sequence-ordered change for each typed OSM ID using an external bounded-memory sort. */
export async function coalesceDiffFiles(diffFiles, workDir, { signal, onProgress = () => {}, maxSpoolBytes = MAX_SPOOL_BYTES } = {}) {
  if (!Array.isArray(diffFiles) || diffFiles.length === 0) throw new Error('at least one replication diff file is required to coalesce');
  const tempDir = path.join(workDir, `coalesce-${process.pid}-${randomUUID()}`);
  const raw = path.join(tempDir, 'changes.unsorted.tsv');
  const sorted = path.join(tempDir, 'changes.sorted.tsv');
  const unique = path.join(tempDir, 'changes.latest.jsonl');
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
        const id = String(change.id).padStart(16, '0');
        const row = `${change.type}:${id}\t${String(fileIndex).padStart(6, '0')}\t${String(objectIndex).padStart(16, '0')}\t${JSON.stringify(change)}\n`;
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

    onProgress({ phase: 'sorting coalesced changes', completed: 0, total: null, unit: 'changes', batchCompletedDiffs: diffFiles.length, detail: `${eventCount.toLocaleString('en-US')} changes; ${Math.round(spoolBytes / (1024 * 1024))} MiB spool` });
    await sortChanges(raw, sorted, tempDir, signal);
    await fs.rm(raw, { force: true });

    const sortedLines = readline.createInterface({ input: createReadStream(sorted), crlfDelay: Infinity });
    const output = createWriteStream(unique, { flags: 'wx' });
    let currentKey = null;
    let currentObject = null;
    let sortedCount = 0;
    let uniqueCount = 0;
    try {
      onProgress({ phase: 'reducing duplicate object changes', completed: 0, total: eventCount, unit: 'changes', batchCompletedDiffs: diffFiles.length });
      for await (const line of sortedLines) {
        if (signal?.aborted) throw signal.reason ?? new Error('update coalescing aborted');
        const first = line.indexOf('\t');
        const second = line.indexOf('\t', first + 1);
        const third = line.indexOf('\t', second + 1);
        if (first < 0 || second < 0 || third < 0) throw new Error('invalid sorted diff spool row');
        const key = line.slice(0, first);
        const object = line.slice(third + 1);
        if (currentKey !== null && key !== currentKey) {
          await writeLine(output, `${currentObject}\n`);
          uniqueCount += 1;
        }
        currentKey = key;
        currentObject = object;
        sortedCount += 1;
        if (sortedCount % 10000 === 0) {
          onProgress({ phase: 'reducing duplicate object changes', completed: sortedCount, total: eventCount, unit: 'changes', batchCompletedDiffs: diffFiles.length, detail: `${uniqueCount.toLocaleString('en-US')} unique objects emitted` });
        }
      }
      if (currentObject !== null) {
        await writeLine(output, `${currentObject}\n`);
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
