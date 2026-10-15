import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeltaObjectStore } from '../scripts/update/delta-store.mjs';
import { resolveCurrentObjects } from '../scripts/update/object-resolver.mjs';

describe('current object resolver', () => {
  it('prefers delta creates/updates and tombstones while resolving unchanged IDs from source', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'object-resolver-'));
    const store = new DeltaObjectStore(root);
    const baselineCalls: string[][] = [];
    const baseline = {
      async resolveObjects(requests: { type: string; id: number }[]) {
        baselineCalls.push(requests.map((r) => `${r.type}:${r.id}`));
        return { objects: requests.filter((r) => r.id === 5).map((r) => ({ ...r, version: 1, tags: { source: 'yes' } })), missing: [] };
      }
    };
    try {
      await store.applyBatch([
        { action: 'modify', type: 'node', id: 5, version: 2, lat: 1, lon: 1, tags: { delta: 'yes' } },
        { action: 'delete', type: 'way', id: 5, version: 3 },
        { action: 'create', type: 'relation', id: 6, version: 1, members: [] }
      ]);
      const found = await resolveCurrentObjects(store, baseline, [
        { type: 'node', id: 5 }, { type: 'way', id: 5 }, { type: 'relation', id: 6 }, { type: 'node', id: 8 }
      ]);
      expect(found.objects.get('node:5')).toMatchObject({ version: 2, tags: { delta: 'yes' } });
      expect(found.objects.has('way:5')).toBe(false);
      expect(found.objects.get('relation:6')).toMatchObject({ version: 1 });
      expect(found.missing).toEqual(['way:5', 'node:8']);
      expect(baselineCalls).toEqual([['node:8']]);
    } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
