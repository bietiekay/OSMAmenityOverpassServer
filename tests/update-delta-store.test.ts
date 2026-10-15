import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeltaObjectStore, resolveCurrent } from '../scripts/update/delta-store.mjs';

describe('persistent update delta object store', () => {
  it('compacts repeated versions, evicts cached partitions and preserves hardlinked snapshots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delta-compact-'));
    try {
      const store = new DeltaObjectStore(root, { maxPartitionBytes: 320, maxCacheBytes: 1 });
      const change = { type: 'node', id: 1, version: 1, action: 'create', lat: 1, lon: 2, tags: {} };
      await store.apply(change);
      const names = await fs.readdir(store.dir);
      const snapshot = path.join(root, 'snapshot');
      await fs.link(path.join(store.dir, names[0]), snapshot);
      for (let version = 2; version < 8; version++) await store.apply({ ...change, action: 'modify', version });
      expect(JSON.parse(await fs.readFile(snapshot, 'utf8')).version).toBe(1);
      await store.apply({ ...change, id: 2 });
      expect(store.cache.size).toBe(1);
      expect((await store.getMany([{ type: 'node', id: 1 }, { type: 'node', id: 2 }])).map((row) => row.version)).toEqual([7, 1]);
      await fs.writeFile(path.join(store.dir, 'ignored.txt'), 'ignored');
      await store.compact();
      store.close();
      expect(store.cacheBytes).toBe(0);
      expect((await new DeltaObjectStore(root).get('node', 1)).version).toBe(7);
      expect(await resolveCurrent(store, async () => ({ version: 3 }), 'way', 200)).toEqual({ version: 3 });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('rejects malformed changes and unrepresentable partitions before publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delta-limits-'));
    try {
      const store = new DeltaObjectStore(root, { maxPartitionBytes: 32 });
      await expect(store.get('invalid', 1)).rejects.toThrow('invalid OSM identity');
      await expect(store.apply({ type: 'node', id: 1, version: 0, action: 'create' })).rejects.toThrow('invalid version');
      await expect(store.apply({ type: 'node', id: 1, version: 1, action: 'invalid' })).rejects.toThrow('invalid action');
      await expect(store.applyBatch(new Array(100001))).rejects.toThrow('100000 objects');
      await expect(store.apply({ type: 'node', id: 1, version: 1, action: 'create', tags: { name: 'large record' } })).rejects.toThrow('compacted delta partition');
      expect((await fs.readdir(store.dir)).some((name) => name.endsWith('.tmp'))).toBe(false);
      await expect(new DeltaObjectStore(root, { maxPartitionBytes: 32 }).get('node', 1)).rejects.toThrow('compact it before lookup');
      const empty = new DeltaObjectStore(path.join(root, 'empty'));
      await expect(empty.compact()).resolves.toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('uses typed identities and version guards across restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delta-'));
    try {
      let store = new DeltaObjectStore(root);
      expect((await store.apply({ type: 'node', id: 12, version: 2, action: 'modify', lat: 1, lon: 2, tags: {} })).applied).toBe(true);
      expect((await store.apply({ type: 'way', id: 12, version: 1, action: 'create', nodeIds: [1], tags: {} })).applied).toBe(true);
      expect((await store.apply({ type: 'node', id: 12, version: 2, action: 'modify', lat: 9, lon: 9 })).applied).toBe(false);
      store = new DeltaObjectStore(root);
      expect((await store.get('node', 12))?.lat).toBe(1);
      expect((await store.get('way', 12))?.nodeIds).toEqual([1]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('persists versioned tombstones and overlays them over baseline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delta-delete-'));
    try {
      const store = new DeltaObjectStore(root);
      await store.apply({ type: 'relation', id: 20, version: 5, action: 'delete' });
      const baseline = async () => ({ type: 'relation', id: 20, version: 4, tags: {} });
      expect(await resolveCurrent(store, baseline, 'relation', 20)).toBeNull();
      expect((await store.apply({ type: 'relation', id: 20, version: 4, action: 'modify' })).applied).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
