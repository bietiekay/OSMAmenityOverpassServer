import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const TYPES = new Set(['node', 'way', 'relation']);
const PARTITIONS = 16384;
const MAX_PARTITION_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const identity = (type, id) => `${type}:${id}`;
const valid = (type, id) => {
  if (!TYPES.has(type) || !Number.isSafeInteger(Number(id)) || Number(id) < 0) throw new Error(`invalid OSM identity ${type}:${id}`);
};
const hash = (key) => { let h = 2166136261; for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h >>> 0; };
const partition = (key) => hash(key) % PARTITIONS;
export const deltaPartitionForKey = partition;

/** Append-only, hash-partitioned current-object overlay with bounded lookup cache. */
export class DeltaObjectStore {
  constructor(root, { maxPartitionBytes = MAX_PARTITION_BYTES, maxCacheBytes = MAX_CACHE_BYTES } = {}) {
    this.root = root; this.dir = path.join(root, 'delta-objects'); this.maxPartitionBytes = maxPartitionBytes; this.maxCacheBytes = maxCacheBytes; this.cache = new Map(); this.cacheBytes = 0;
  }
  file(bucket) { return path.join(this.dir, `${bucket}.jsonl`); }

  async get(type, id) {
    valid(type, id); const key = identity(type, Number(id)); const bucket = partition(key);
    const values = await this.load(bucket);
    return values.get(key) ?? null;
  }

  async getMany(keys) {
    const output = [];
    for (const { type, id } of keys) output.push(await this.get(type, id));
    return output;
  }

  async load(bucket) {
    let values = this.cache.get(bucket);
    if (values) { this.cache.delete(bucket); this.cache.set(bucket, values); return values; }
    values = new Map(); const file = this.file(bucket); let size = 0;
    try {
      size = (await fs.stat(file)).size;
      if (size > this.maxPartitionBytes) throw new Error(`delta partition ${bucket} is ${size} bytes; compact it before lookup (limit ${this.maxPartitionBytes})`);
      const rows = readline.createInterface({ input: (await import('node:fs')).createReadStream(file), crlfDelay: Infinity });
      for await (const line of rows) { const row = JSON.parse(line); const key = identity(row.type, row.id); const prev = values.get(key); if (!prev || row.version > prev.version) values.set(key, row); }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const estimated = Math.max(size * 3, values.size * 96);
    this.cache.set(bucket, values); this.cacheBytes += estimated; values.cacheBytes = estimated;
    while (this.cacheBytes > this.maxCacheBytes && this.cache.size > 1) { const old = this.cache.keys().next().value; const evicted = this.cache.get(old); this.cacheBytes -= evicted.cacheBytes ?? 0; this.cache.delete(old); }
    return values;
  }

  async apply(change) {
    const [result] = await this.applyBatch([change]); return result;
  }

  /** Group one bounded diff batch by bucket, compare versions, and append atomically per record. */
  async applyBatch(changes) {
    if (changes.length > 100000) throw new Error('delta batch exceeds 100000 objects');
    const groups = new Map(); let batchBytes = 0;
    for (const change of changes) {
      valid(change.type, change.id);
      if (!Number.isSafeInteger(change.version) || change.version < 1) throw new Error(`invalid version for ${change.type}:${change.id}`);
      if (!['create', 'modify', 'delete'].includes(change.action)) throw new Error(`invalid action for ${change.type}:${change.id}`);
      const key = identity(change.type, Number(change.id)); const bucket = partition(key); let group = groups.get(bucket);
      if (!group) { group = []; groups.set(bucket, group); }
      batchBytes += Buffer.byteLength(JSON.stringify(change));
      if (batchBytes > 32 * 1024 * 1024) throw new Error('delta batch exceeds 32 MiB object budget');
      group.push({ ...change, id: Number(change.id), key, deleted: change.action === 'delete' });
    }
    await fs.mkdir(this.dir, { recursive: true }); const results = [];
    for (const [bucket, group] of groups) {
      const values = await this.load(bucket); const accepted = []; const pending = new Map();
      for (const change of group) {
        const previous = pending.get(change.key) ?? values.get(change.key) ?? null;
        if (previous && previous.version >= change.version) { results.push({ key: change.key, version: change.version, applied: false, previous }); continue; }
        const record = change.deleted
          ? { type: change.type, id: change.id, version: change.version, deleted: true }
          : { ...change, key: undefined, action: undefined, deleted: false };
        pending.set(change.key, record); accepted.push(record); results.push({ key: change.key, version: change.version, applied: true, previous });
      }
      if (accepted.length) {
        const file = this.file(bucket); await this.ensureWritable(file); const handle = await fs.open(file, 'a'); let appendedBytes = 0;
        try { for (const record of accepted) { const line = `${JSON.stringify(record)}\n`; appendedBytes += Buffer.byteLength(line); await handle.write(line); } await handle.sync(); }
        finally { await handle.close(); }
        for (const record of accepted) values.set(identity(record.type, record.id), record);
        values.cacheBytes = (values.cacheBytes ?? 0) + appendedBytes * 5; this.cacheBytes += appendedBytes * 5;
        while (this.cacheBytes > this.maxCacheBytes && this.cache.size > 1) { const oldest = this.cache.keys().next().value; const evicted = this.cache.get(oldest); this.cacheBytes -= evicted.cacheBytes ?? 0; this.cache.delete(oldest); }
        if ((await fs.stat(file)).size > this.maxPartitionBytes) await this.compactPartition(bucket);
      }
    }
    return results;
  }

  /** Replace one candidate-generation partition after an externally grouped import. */
  async applyPartition(bucket, changes) {
    if (!Number.isSafeInteger(bucket) || bucket < 0 || bucket >= PARTITIONS) throw new Error(`invalid delta partition ${bucket}`);
    const values = await this.load(bucket);
    let applied = 0;
    for (const change of changes) {
      valid(change.type, change.id);
      if (!Number.isSafeInteger(change.version) || change.version < 1) throw new Error(`invalid version for ${change.type}:${change.id}`);
      if (!['create', 'modify', 'delete'].includes(change.action)) throw new Error(`invalid action for ${change.type}:${change.id}`);
      const key = identity(change.type, Number(change.id));
      if (partition(key) !== bucket) throw new Error(`change ${key} is in the wrong delta partition`);
      if ((values.get(key)?.version ?? 0) >= change.version) continue;
      const record = change.action === 'delete'
        ? { type: change.type, id: change.id, version: change.version, deleted: true }
        : { ...change, action: undefined, deleted: false };
      values.set(key, record);
      applied += 1;
    }
    if (!applied) return 0;
    const file = this.file(bucket);
    const temp = `${file}.${randomUUID()}.bulk`;
    let output = ''; let outputBytes = 0;
    for (const value of values.values()) {
      const line = `${JSON.stringify(value)}\n`;
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > this.maxPartitionBytes) throw new Error(`compacted delta partition ${bucket} exceeds ${this.maxPartitionBytes} bytes`);
      output += line;
    }
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(output); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
    } catch (error) { await fs.rm(temp, { force: true }); throw error; }
    this.cache.clear(); this.cacheBytes = 0;
    return applied;
  }

  async compactPartition(bucket) {
    const values = await this.load(bucket); const file = this.file(bucket); const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx');
    let bytes = 0;
    try {
      for (const value of values.values()) {
        const line = `${JSON.stringify(value)}\n`; bytes += Buffer.byteLength(line);
        if (bytes > this.maxPartitionBytes) throw new Error(`compacted delta partition ${bucket} exceeds ${this.maxPartitionBytes} bytes`);
        await handle.write(line);
      }
      await handle.sync();
    } catch (error) {
      await handle.close(); await fs.rm(temp, { force: true }); throw error;
    }
    await handle.close();
    await fs.rename(temp, file); this.cache.delete(bucket); this.cacheBytes = [...this.cache.values()].reduce((n, m) => n + (m.cacheBytes ?? 0), 0);
  }

  async ensureWritable(file) {
    try {
      if ((await fs.stat(file)).nlink <= 1) return;
      const copy = `${file}.${randomUUID()}.cow`; await fs.copyFile(file, copy); await fs.rename(copy, file);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }

  async compact() {
    for (const name of await fs.readdir(this.dir).catch((e) => e.code === 'ENOENT' ? [] : Promise.reject(e))) {
      const match = name.match(/^(\d+)\.jsonl$/); if (match) await this.compactPartition(Number(match[1]));
    }
  }
  close() { this.cache.clear(); this.cacheBytes = 0; }
}

/** Resolve overlay over a baseline resolver with tombstones and strict version precedence. */
export async function resolveCurrent(store, baseline, type, id) {
  const delta = await store.get(type, id);
  if (delta) return delta.deleted ? null : delta;
  return baseline(type, id);
}
