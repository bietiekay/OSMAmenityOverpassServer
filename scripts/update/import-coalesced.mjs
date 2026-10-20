import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

const FILTER_BYTES = 64 * 1024 * 1024;
const MAX_RELEVANT_BYTES = 128 * 1024 * 1024;
const checkAborted = (signal) => { if (signal?.aborted) throw signal.reason ?? new Error('update aborted'); };
const identity = (value) => `${value.type}:${value.id}`;

function hash(key, seed) {
  let value = seed;
  for (let i = 0; i < key.length; i += 1) value = Math.imul(value ^ key.charCodeAt(i), 16777619) >>> 0;
  return value;
}

class TrackedFilter {
  constructor() { this.bits = Buffer.alloc(FILTER_BYTES); this.bitCount = FILTER_BYTES * 8; }
  positions(key) {
    const first = hash(key, 2166136261);
    const step = hash(key, 33554467) | 1;
    return [0, 1, 2].map((index) => ((first + Math.imul(index, step)) >>> 0) % this.bitCount);
  }
  add(key) { for (const bit of this.positions(key)) this.bits[bit >>> 3] |= 1 << (bit & 7); }
  mightContain(key) { return this.positions(key).every((bit) => (this.bits[bit >>> 3] & (1 << (bit & 7))) !== 0); }
}

async function buildTrackedFilter(indexes, signal, onProgress) {
  const files = [];
  for (const name of ['object-cells', 'reverse-parents']) {
    const dir = path.join(indexes.dir, name);
    for (const file of await fs.readdir(dir)) if (file.endsWith('.jsonl')) files.push(path.join(dir, file));
  }
  const filter = new TrackedFilter();
  onProgress({ phase: 'filtering tracked update keys', completed: 0, total: files.length, unit: 'index files' });
  for (let i = 0; i < files.length; i += 1) {
    checkAborted(signal);
    const lines = readline.createInterface({ input: createReadStream(files[i]), crlfDelay: Infinity });
    for await (const line of lines) filter.add(JSON.parse(line).key);
    onProgress({ phase: 'filtering tracked update keys', completed: i + 1, total: files.length, unit: 'index files' });
  }
  return filter;
}

/** Find changes affecting indexed amenities in an already partition-ordered stream. */
export async function prepareCoalescedImport(coalesced, indexes, amenities, {
  signal, onProgress = () => {}, maxObjectBytes = 8 * 1024 * 1024
} = {}) {
  const filter = await buildTrackedFilter(indexes, signal, onProgress);
  const relevant = [];
  let completed = 0; let relevantBytes = 0;
  onProgress({ phase: 'identifying affected changes', completed, total: coalesced.uniqueCount, unit: 'objects' });
  const lines = readline.createInterface({ input: createReadStream(coalesced.file), crlfDelay: Infinity });
  for await (const line of lines) {
    checkAborted(signal);
    const divider = line.indexOf('\t');
    if (divider < 1) throw new Error('invalid coalesced delta partition row');
    const size = Buffer.byteLength(line) - divider - 1;
    if (size > maxObjectBytes) throw new Error('coalesced change exceeds update object byte limit');
    const change = JSON.parse(line.slice(divider + 1));
    const key = identity(change);
    const configuredMain = amenities.includes(change.tags?.amenity);
    if (configuredMain || filter.mightContain(key)) {
      const tracked = configuredMain || (await indexes.objectCells.get(key)).length > 0 || (await indexes.reverseParents.get(key)).length > 0;
      if (tracked) {
        relevantBytes += size;
        if (relevantBytes > MAX_RELEVANT_BYTES) throw new Error(`possibly affected update objects exceed ${MAX_RELEVANT_BYTES} bytes; use a smaller replication batch`);
        relevant.push(change);
      }
      if (relevant.length > 100000) throw new Error('update has more than 100000 possibly affected objects; use a smaller replication batch');
    }
    completed += 1;
    if (completed % 10000 === 0) onProgress({ phase: 'identifying affected changes', completed, total: coalesced.uniqueCount, unit: 'objects', detail: `${relevant.length.toLocaleString('en-US')} possibly affected objects` });
  }
  onProgress({ phase: 'identifying affected changes', completed, total: coalesced.uniqueCount, unit: 'objects', detail: `${relevant.length.toLocaleString('en-US')} possibly affected objects` });
  if (completed !== coalesced.uniqueCount) throw new Error(`coalesced file contains ${completed} objects, expected ${coalesced.uniqueCount}`);
  return { file: coalesced.file, relevant };
}

async function settledWave(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((item) => item.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((item) => item.value);
}

/** Apply each independent partition once; workers never write the same file. */
export async function importCoalescedPartitions(store, file, total, { workers = 1, signal, onProgress = () => {} } = {}) {
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const wave = [];
  let bucket = null; let changes = []; let groupBytes = 0; let completed = 0; let applied = 0;
  const flushWave = async () => {
    if (!wave.length) return;
    checkAborted(signal);
    const values = await settledWave(wave.map((group) => store.applyPartition(group.bucket, group.changes)));
    for (let i = 0; i < wave.length; i += 1) { completed += wave[i].changes.length; applied += values[i]; }
    wave.length = 0;
    onProgress({ phase: 'writing grouped delta partitions', completed, total, unit: 'objects', detail: `${applied.toLocaleString('en-US')} newer overlay versions; ${workers} workers` });
  };
  const queueGroup = async () => {
    if (bucket === null) return;
    wave.push({ bucket, changes });
    if (wave.length >= workers) await flushWave();
    changes = []; groupBytes = 0;
  };
  onProgress({ phase: 'writing grouped delta partitions', completed: 0, total, unit: 'objects' });
  for await (const line of lines) {
    checkAborted(signal);
    const divider = line.indexOf('\t');
    if (divider < 1) throw new Error('invalid grouped delta spool row');
    const nextBucket = Number(line.slice(0, divider));
    if (!Number.isSafeInteger(nextBucket)) throw new Error('invalid grouped delta partition');
    if (bucket !== null && nextBucket < bucket) throw new Error('grouped delta spool is not ordered by partition');
    if (bucket !== null && nextBucket !== bucket) await queueGroup();
    bucket = nextBucket;
    groupBytes += Buffer.byteLength(line);
    if (groupBytes > store.maxPartitionBytes * 2) throw new Error(`grouped delta partition ${bucket} exceeds the import memory limit`);
    changes.push(JSON.parse(line.slice(divider + 1)));
  }
  await queueGroup();
  await flushWave();
  if (completed !== total) throw new Error(`grouped delta import processed ${completed} objects, expected ${total}`);
  return { applied };
}
