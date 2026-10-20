import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Count bytes entering and leaving an external sort without buffering its input in Node. */
export async function sortWithProgress(input, output, args, { signal, onProgress = () => {}, detail = '' } = {}) {
  const inputBytes = (await fs.stat(input)).size;
  const total = Math.max(1, inputBytes * 2);
  let readBytes = 0;
  let writtenBytes = 0;
  let lastPercent = -1;
  const report = (force = false) => {
    const completed = Math.min(inputBytes, readBytes) + Math.min(inputBytes, writtenBytes);
    const percent = Math.floor(completed / total * 100);
    if (!force && percent === lastPercent) return;
    lastPercent = percent;
    const step = readBytes < inputBytes ? 'reading sort input' : 'writing sorted output (merge may pause progress)';
    onProgress({ completed, total, unit: 'bytes', showEta: false, detail: detail ? `${detail}; ${step}` : step });
  };
  report(true);

  const child = spawn('sort', args, { env: { ...process.env, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length);
  });
  const abort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  const countInput = new Transform({ transform(chunk, encoding, callback) {
    readBytes += chunk.length;
    report();
    callback(null, chunk);
  } });
  const countOutput = new Transform({ transform(chunk, encoding, callback) {
    writtenBytes += chunk.length;
    report();
    callback(null, chunk);
  } });
  const childDone = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, childSignal) => {
      if (code === 0) resolve();
      else reject(signal?.aborted ? signal.reason ?? new Error('update sort aborted') : new Error(`sort failed (${code ?? childSignal}): ${stderr}`));
    });
  });
  const pipelineOptions = signal ? { signal } : {};
  const inputDone = pipeline(createReadStream(input), countInput, child.stdin, pipelineOptions).catch((error) => { abort(); throw error; });
  const outputDone = pipeline(child.stdout, countOutput, createWriteStream(output, { flags: 'wx' }), pipelineOptions).catch((error) => { abort(); throw error; });
  try {
    const results = await Promise.allSettled([inputDone, outputDone, childDone]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (readBytes !== inputBytes || writtenBytes !== inputBytes) {
      throw new Error(`sort byte count mismatch: input ${inputBytes}, read ${readBytes}, output ${writtenBytes}`);
    }
    onProgress({ completed: total, total, unit: 'bytes', showEta: false, detail: detail ? `${detail}; sorted output complete` : 'sorted output complete' });
  } catch (error) {
    await fs.rm(output, { force: true });
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
