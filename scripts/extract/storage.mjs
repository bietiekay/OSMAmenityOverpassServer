import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

// Hash partitioned JSONL lookup. A caller only materializes one small partition
// at a time; secondary hashing handles unusually large partitions.
const hash = (key) => {
  let h = 2166136261;
  for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h >>> 0;
};
const routeHash = (key, depth) => {
  let h = 2166136261;
  for (const c of `${depth}:${key}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h >>> 0;
};
export const partitionCountForBytes = (bytes, targetPartitionBytes = 2 * 1024 * 1024) => {
  let count = 64; const wanted = Math.ceil(Math.max(0, bytes) / targetPartitionBytes);
  while (count < wanted && count < 65536) count *= 2;
  return count;
};
const bucketFile = (dir, stem) => path.join(dir, `${stem}.jsonl`);

export async function createPartitionedLookup(root, name, records, { partitions = 4096, maxCacheBytes = 64 * 1024 * 1024, maxPartitionBytes = 4 * 1024 * 1024 } = {}) {
  const dir = path.join(root, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const handles = new Map();
  try {
    for await (const record of records) {
      const key = String(record.key);
      const bucket = hash(key) % partitions;
      let handle = handles.get(bucket);
      if (!handle) {
        if (handles.size >= 64) {
          const [old, oldHandle] = handles.entries().next().value;
          await oldHandle.close(); handles.delete(old);
        }
        handle = await fs.open(bucketFile(dir, String(bucket)), 'a');
        handles.set(bucket, handle);
      }
      await handle.write(`${JSON.stringify({ key, value: record.value })}\n`);
    }
  } finally { await Promise.all([...handles.values()].map((h) => h.close())); }
  const splits = {};
  async function splitIfNeeded(stem, depth = 0) {
    const file = bucketFile(dir, stem); let size;
    try { size = (await fs.stat(file)).size; } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (size <= maxPartitionBytes) return;
    if (depth >= 8) throw new Error(`Lookup partition ${stem} remains ${size} bytes after eight splits (limit ${maxPartitionBytes})`);
    const childHandles = new Map();
    try {
      const rows = readline.createInterface({ input: (await import('node:fs')).createReadStream(file), crlfDelay: Infinity });
      for await (const line of rows) {
        const row = JSON.parse(line); const child = routeHash(row.key, depth) & 1; const childStem = `${stem}.${child}`;
        let h = childHandles.get(childStem);
        if (!h) {
          if (childHandles.size >= 64) { const [old, oldHandle] = childHandles.entries().next().value; await oldHandle.close(); childHandles.delete(old); }
          h = await fs.open(bucketFile(dir, childStem), 'a'); childHandles.set(childStem, h);
        }
        await h.write(`${line}\n`);
      }
    } finally { await Promise.all([...childHandles.values()].map((h) => h.close())); }
    await fs.unlink(file); splits[stem] = depth;
    await splitIfNeeded(`${stem}.0`, depth + 1); await splitIfNeeded(`${stem}.1`, depth + 1);
  }
  for (let i = 0; i < partitions; i += 1) await splitIfNeeded(String(i));
  await fs.writeFile(path.join(dir, 'lookup.json'), `${JSON.stringify({ partitions, splits, maxPartitionBytes })}\n`);
  return new PartitionedLookup(dir, partitions, maxCacheBytes, maxPartitionBytes, splits);
}

export async function openPartitionedLookup(dir, { partitions = 4096, maxCacheBytes = 64 * 1024 * 1024, maxPartitionBytes = 4 * 1024 * 1024 } = {}) {
  let routing = { partitions, splits: {}, maxPartitionBytes };
  try { routing = { ...routing, ...JSON.parse(await fs.readFile(path.join(dir, 'lookup.json'), 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') throw e; routing.maxPartitionBytes = Math.max(maxPartitionBytes, 16 * 1024 * 1024); }
  return new PartitionedLookup(dir, routing.partitions, maxCacheBytes, routing.maxPartitionBytes, routing.splits);
}

export class PartitionedLookup {
  constructor(dir, partitions = 4096, maxCacheBytes = 128 * 1024 * 1024, maxPartitionBytes = 4 * 1024 * 1024, splits = {}) {
    this.dir = dir; this.partitions = partitions; this.maxCacheBytes = maxCacheBytes; this.maxPartitionBytes = maxPartitionBytes; this.splits = splits; this.cache = new Map(); this.cacheBytes = 0;
  }
  async get(key) {
    key = String(key);
    let stem = String(hash(key) % this.partitions); let depth = 0;
    while (this.splits[stem] !== undefined) { stem = `${stem}.${routeHash(key, depth++) & 1}`; }
    let values = this.cache.get(stem);
    if (!values) {
      values = new Map();
      const file = bucketFile(this.dir, stem);
      let bytes = 0;
      try {
        const { size } = await fs.stat(file); bytes = size;
        if (size > this.maxPartitionBytes) throw new Error(`Lookup partition ${file} is ${size} bytes; hard limit is ${this.maxPartitionBytes}`);
        const lines = readline.createInterface({ input: (await import('node:fs')).createReadStream(file), crlfDelay: Infinity });
        for await (const line of lines) { const row = JSON.parse(line); values.set(row.key, row.value); }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const estimate = Math.max(bytes * 5, values.size * 128);
      this.cache.set(stem, values);
      this.cacheBytes += estimate;
      values.cacheBytes = estimate;
      while (this.cacheBytes > this.maxCacheBytes && this.cache.size > 1) {
        const old = this.cache.keys().next().value; const evicted = this.cache.get(old);
        this.cacheBytes -= evicted.cacheBytes || 0; this.cache.delete(old);
      }
    } else { this.cache.delete(stem); this.cache.set(stem, values); }
    return values.get(key);
  }
  async close() { this.cache.clear(); this.cacheBytes = 0; }
}

export async function* readLines(files) {
  for (const file of files) {
    const stream = (await import('node:fs')).createReadStream(file);
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) if (line) yield line;
  }
}

export async function countUniqueRecords(root, records, partitions = 4096) {
  const dir = path.join(root, 'unique-counts'); await fs.rm(dir, { recursive: true, force: true }); await fs.mkdir(dir, { recursive: true });
  const handles = new Map();
  try {
    for await (const row of records) {
      const bucket = hash(row.key) % partitions; let h = handles.get(bucket);
      if (!h) {
        if (handles.size >= 64) { const [old, oldHandle] = handles.entries().next().value; await oldHandle.close(); handles.delete(old); }
        h = await fs.open(path.join(dir, `${bucket}.jsonl`), 'a'); handles.set(bucket, h);
      }
      await h.write(`${JSON.stringify(row)}\n`);
    }
  } finally { await Promise.all([...handles.values()].map((h) => h.close())); }
  let main = 0, support = 0;
  for (const name of await fs.readdir(dir)) {
    const file = path.join(dir, name); const { size } = await fs.stat(file);
    if (size > 16 * 1024 * 1024) throw new Error(`Unique-count partition ${name} exceeds 16 MiB`);
    const seen = new Map();
    const lines = readline.createInterface({ input: (await import('node:fs')).createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) { const row = JSON.parse(line); if (row.main) seen.set(row.key, true); else if (!seen.has(row.key)) seen.set(row.key, false); }
    for (const isMain of seen.values()) { if (isMain) main++; else support++; }
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { mainUnique: main, supportUnique: support };
}

export async function createPartitionedMultiIndex(root, name, records, { partitions = 4096 } = {}) {
  const dir = path.join(root, name); await fs.rm(dir, { recursive: true, force: true }); await fs.mkdir(dir, { recursive: true });
  const handles = new Map();
  const bucketBytes = new Map(); const maxPartitionBytes = 2 * 1024 * 1024;
  try {
    for await (const row of records) {
      const bucket = hash(row.key) % partitions;
      const line = `${JSON.stringify(row)}\n`; const size = Buffer.byteLength(line);
      const nextSize = (bucketBytes.get(bucket) ?? 0) + size;
      if (nextSize > maxPartitionBytes) throw new Error(`multi-index ${name} partition ${bucket} exceeds ${maxPartitionBytes} bytes; increase partition count`);
      bucketBytes.set(bucket, nextSize);
      let h = handles.get(bucket);
      if (!h) {
        if (handles.size >= 64) { const [old, oldHandle] = handles.entries().next().value; await oldHandle.close(); handles.delete(old); }
        h = await fs.open(path.join(dir, `${bucket}.jsonl`), 'a'); handles.set(bucket, h);
      }
      await h.write(line);
    }
  } finally { await Promise.all([...handles.values()].map((h) => h.close())); }
  // An object may occur in many spatial shard copies. Store each key/value edge
  // once, with a hard per-partition read budget and only one partition in RAM.
  for (const bucket of bucketBytes.keys()) {
    const file = path.join(dir, `${bucket}.jsonl`); const unique = new Map();
    const lines = readline.createInterface({ input: (await import('node:fs')).createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      const row = JSON.parse(line); let values = unique.get(row.key);
      if (!values) { values = new Set(); unique.set(row.key, values); }
      values.add(row.value);
    }
    const temp = `${file}.tmp`; const out = await fs.open(temp, 'w');
    try { for (const [key, values] of unique) for (const value of values) await out.write(`${JSON.stringify({ key, value })}\n`); }
    finally { await out.close(); }
    await fs.rename(temp, file);
  }
  return openPartitionedMultiIndex(dir, partitions);
}

export function openPartitionedMultiIndex(dir, partitions = 4096, maxPartitionBytes = 2 * 1024 * 1024) {
  const cache = new Map();
  return {
    async get(key) {
      key = String(key); const bucket = hash(key) % partitions; let map = cache.get(bucket);
      if (!map) {
        map = new Map(); const file = path.join(dir, `${bucket}.jsonl`);
        try {
          const { size } = await fs.stat(file); if (size > maxPartitionBytes) throw new Error(`reverse-index partition ${file} exceeds ${maxPartitionBytes} bytes`);
          const lines = readline.createInterface({ input: (await import('node:fs')).createReadStream(file), crlfDelay: Infinity });
          for await (const line of lines) { const row = JSON.parse(line); let values = map.get(row.key); if (!values) { values = []; map.set(row.key, values); } values.push(row.value); }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        cache.set(bucket, map); if (cache.size > 1) cache.delete(cache.keys().next().value);
      } else { cache.delete(bucket); cache.set(bucket, map); }
      return [...new Set(map.get(key) || [])];
    },
    close() { cache.clear(); }
  };
}

/** Append a bounded batch of new edges; stale edges are deliberately retained as safe over-approximation. */
export async function appendPartitionedMultiIndex(dir, partitions, rows, { maxBatchBytes = 16 * 1024 * 1024, maxPartitionBytes = 2 * 1024 * 1024 } = {}) {
  const groups = new Map(); let total = 0;
  for (const row of rows) {
    const bucket = hash(row.key) % partitions; const line = `${JSON.stringify(row)}\n`; const size = Buffer.byteLength(line); total += size;
    if (total > maxBatchBytes) throw new Error(`multi-index update batch exceeds ${maxBatchBytes} bytes`);
    let list = groups.get(bucket); if (!list) { list = []; groups.set(bucket, list); }
    list.push(line);
  }
  for (const [bucket, lines] of groups) {
    const file = path.join(dir, `${bucket}.jsonl`); const size = await fs.stat(file).then((s) => s.size, (e) => e.code === 'ENOENT' ? 0 : Promise.reject(e));
    const extra = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    if (size + extra > maxPartitionBytes) throw new Error(`multi-index update partition ${bucket} exceeds ${maxPartitionBytes} bytes; rebuild tracked indexes with more partitions`);
    try { if ((await fs.stat(file)).nlink > 1) { const copy = `${file}.${randomUUID()}.cow`; await fs.copyFile(file, copy); await fs.rename(copy, file); } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.appendFile(file, lines.join(''));
  }
}
