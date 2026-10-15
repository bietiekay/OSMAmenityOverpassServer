import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendPartitionedMultiIndex, countUniqueRecords, createPartitionedLookup,
  createPartitionedMultiIndex, openPartitionedLookup, openPartitionedMultiIndex,
  partitionCountForBytes, readLines
} from '../scripts/extract/storage.mjs';

const roots: string[] = [];
async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'osm-storage-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function* records(rows: unknown[]) { for (const row of rows) yield row; }
function keysInDistinctBuckets(count: number, partitions: number) {
  const found = new Map<number, string>();
  for (let i = 0; found.size < count; i += 1) {
    const key = `bucket-key-${i}`; let h = 2166136261;
    for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    const bucket = h % partitions; if (!found.has(bucket)) found.set(bucket, key);
  }
  return [...found.values()];
}

describe('bounded extraction storage', () => {
  it('chooses power-of-two partition counts and streams nonempty lines across files', async () => {
    expect(partitionCountForBytes(-1)).toBe(64);
    expect(partitionCountForBytes(2 * 1024 * 1024)).toBe(64);
    expect(partitionCountForBytes(64 * 1024 * 1024 + 1, 1024 * 1024)).toBe(128);
    const root = await tempRoot();
    const a = path.join(root, 'a'); const b = path.join(root, 'b');
    await fs.writeFile(a, 'one\n\n two\n'); await fs.writeFile(b, 'three');
    const lines: string[] = [];
    for await (const line of readLines([a, b])) lines.push(line);
    expect(lines).toEqual(['one', ' two', 'three']);
  });

  it('splits oversized lookup buckets, resolves duplicate keys, misses, and cache eviction', async () => {
    const root = await tempRoot();
    const source = Array.from({ length: 32 }, (_, i) => ({ key: `key-${i}`, value: `v-${i}-${'x'.repeat(400)}` }));
    source.push({ key: 'key-4', value: 'last' });
    const lookup = await createPartitionedLookup(root, 'lookup', records(source), {
      partitions: 1, maxPartitionBytes: 7000, maxCacheBytes: 1
    });
    expect(await lookup.get('key-4')).toBe('last');
    expect(await lookup.get('key-17')).toBe(`v-17-${'x'.repeat(400)}`);
    expect(await lookup.get('missing')).toBeUndefined();
    expect(Object.keys(lookup.splits).length).toBeGreaterThan(0);
    await lookup.close();
    const reopened = await openPartitionedLookup(path.join(root, 'lookup'), { maxCacheBytes: 1 });
    expect(await reopened.get('key-4')).toBe('last');
    await reopened.close();
  });

  it('reads a legacy lookup without routing metadata and rejects corrupt routing JSON', async () => {
    const root = await tempRoot(); const dir = path.join(root, 'legacy');
    await fs.mkdir(dir); await fs.writeFile(path.join(dir, '0.jsonl'), '{"key":"x","value":7}\n');
    const legacy = await openPartitionedLookup(dir, { partitions: 1 });
    expect(await legacy.get('x')).toBe(7); await legacy.close();
    await fs.writeFile(path.join(dir, 'lookup.json'), '{bad');
    await expect(openPartitionedLookup(dir)).rejects.toThrow();
  });

  it('deduplicates main and support records with main taking precedence and removes scratch data', async () => {
    const root = await tempRoot();
    const counts = await countUniqueRecords(root, records([
      { key: 'a', main: false }, { key: 'b', main: false }, { key: 'a', main: true },
      { key: 'a', main: false }, { key: 'c', main: true }, { key: 'c', main: true }
    ]), 2);
    expect(counts).toEqual({ mainUnique: 2, supportUnique: 1 });
    await expect(fs.stat(path.join(root, 'unique-counts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deduplicates reverse-index edges, appends over-approximate edges, and enforces budgets', async () => {
    const root = await tempRoot();
    const index = await createPartitionedMultiIndex(root, 'reverse', records([
      { key: 'way:1', value: 'node:4' }, { key: 'way:1', value: 'node:4' }, { key: 'way:1', value: 'node:5' }
    ]), { partitions: 1 });
    expect(await index.get('way:1')).toEqual(['node:4', 'node:5']);
    expect(await index.get('none')).toEqual([]);
    await appendPartitionedMultiIndex(path.join(root, 'reverse'), 1, [
      { key: 'way:1', value: 'node:6' }
    ]);
    await index.close();
    const reopened = openPartitionedMultiIndex(path.join(root, 'reverse'), 1);
    expect(await reopened.get('way:1')).toEqual(['node:4', 'node:5', 'node:6']);
    await expect(appendPartitionedMultiIndex(path.join(root, 'reverse'), 1,
      [{ key: 'x', value: 'y'.repeat(100) }], { maxBatchBytes: 10 })).rejects.toThrow(/batch exceeds/);
    await expect(appendPartitionedMultiIndex(path.join(root, 'reverse'), 1,
      [{ key: 'way:1', value: 'z'.repeat(500) }], { maxPartitionBytes: 10 })).rejects.toThrow(/partition .* exceeds/);
    await reopened.close();
  });

  it('uses copy-on-write when appending to a hard-linked generation', async () => {
    const root = await tempRoot();
    const index = await createPartitionedMultiIndex(root, 'source', records([{ key: 'x', value: 'old' }]), { partitions: 1 });
    await index.close();
    const sourceFile = path.join(root, 'source', '0.jsonl');
    const linkedDir = path.join(root, 'linked'); await fs.mkdir(linkedDir);
    const linkedFile = path.join(linkedDir, '0.jsonl'); await fs.link(sourceFile, linkedFile);
    await appendPartitionedMultiIndex(linkedDir, 1, [{ key: 'x', value: 'new' }]);
    expect(await fs.readFile(sourceFile, 'utf8')).toBe('{"key":"x","value":"old"}\n');
    const linked = openPartitionedMultiIndex(linkedDir, 1);
    expect(await linked.get('x')).toEqual(['old', 'new']); await linked.close();
  });

  it('bounds open-file handles and cache memory while traversing many partitions', async () => {
    const root = await tempRoot(); const keys = keysInDistinctBuckets(70, 128);
    const rows = keys.map((key, i) => ({ key, value: `v-${i}` }));
    const lookup = await createPartitionedLookup(root, 'many', records(rows), {
      partitions: 128, maxCacheBytes: 1
    });
    expect(await lookup.get(keys[0])).toBe('v-0');
    expect(await lookup.get(keys[69])).toBe('v-69');
    await lookup.close();
    expect(await countUniqueRecords(root, records(rows.map(row => ({ ...row, main: true }))), 128))
      .toEqual({ mainUnique: 70, supportUnique: 0 });
    const multi = await createPartitionedMultiIndex(root, 'many-multi', records(rows), { partitions: 128 });
    expect(await multi.get(keys[69])).toEqual(['v-69']); await multi.close();
  });

  it('returns misses for absent lookup and reverse-index partitions and creates append-only buckets', async () => {
    const root = await tempRoot(); const absent = path.join(root, 'absent'); await fs.mkdir(absent);
    const lookup = await openPartitionedLookup(absent, { partitions: 8 });
    expect(await lookup.get('nothing')).toBeUndefined(); await lookup.close();
    const multi = openPartitionedMultiIndex(absent, 8);
    expect(await multi.get('nothing')).toEqual([]); await multi.close();
    await appendPartitionedMultiIndex(absent, 8, [{ key: 'new-edge', value: 'node:1' }]);
    const after = openPartitionedMultiIndex(absent, 8);
    expect(await after.get('new-edge')).toEqual(['node:1']); await after.close();
  });

  it('enforces hard partition limits while building bounded indexes', async () => {
    const root = await tempRoot();
    await expect(createPartitionedMultiIndex(root, 'too-large', records([
      { key: 'x', value: 'x'.repeat(2 * 1024 * 1024) }
    ]), { partitions: 1 })).rejects.toThrow(/exceeds 2097152 bytes/);
    async function* oversizedUnique() {
      yield { key: 'x', main: true };
      yield { key: 'x', main: false, note: 'x'.repeat(17 * 1024 * 1024) };
    }
    await expect(countUniqueRecords(root, oversizedUnique(), 1)).rejects.toThrow(/exceeds 16 MiB/);
  });
});
