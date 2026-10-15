import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { parseOsmChange } from '../scripts/update/change-parser.mjs';
import { applyChangeStreamToStore } from '../scripts/update/change-apply.mjs';
import { DeltaObjectStore } from '../scripts/update/delta-store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('osmChange parser', () => {
  it('preserves actions, object metadata, members, entities, and chunk boundaries', async () => {
    const xml = `<?xml version="1.0"?><osmChange version="0.6"><create><node id="1" version="2" timestamp="2026-10-15T10:00:00Z" changeset="7" lat="35" lon="139"><tag k="name" v="A &amp; B 🗾"/></node></create><modify><way id="2" version="3" timestamp="2026-10-15T10:01:00Z"><nd ref="1"/><tag k="amenity" v="toilets"/></way></modify><delete><relation id="3" version="4" timestamp="2026-10-15T10:02:00Z"><member type="way" ref="2" role="outer &amp; inner"/></relation></delete></osmChange>`;
    async function* chunks() { for (let i = 0; i < xml.length; i += 7) yield Buffer.from(xml.slice(i, i + 7)); }
    const objects = []; for await (const object of parseOsmChange(Readable.from(chunks()))) objects.push(object);
    expect(objects).toEqual([
      expect.objectContaining({ type: 'node', id: 1, action: 'create', version: 2, changeset: 7, tags: { name: 'A & B 🗾' } }),
      expect.objectContaining({ type: 'way', id: 2, action: 'modify', nodeIds: [1], tags: { amenity: 'toilets' } }),
      expect.objectContaining({ type: 'relation', id: 3, action: 'delete', members: [{ type: 'way', ref: 2, role: 'outer & inner' }] })
    ]);
  });

  it('rejects a truncated change object', async () => {
    const stream = Readable.from(['<osmChange><create><node id="1" version="1" lat="1" lon="2">']);
    const result = [];
    await expect(async () => { for await (const object of parseOsmChange(stream)) result.push(object); }).rejects.toThrow(/truncated/);
  });

  it('accepts a coordinate-free node tombstone and rejects objects outside an action', async () => {
    const rows = [];
    for await (const object of parseOsmChange(Readable.from(['<osmChange><delete><node id="7" version="2"/></delete></osmChange>']))) rows.push(object);
    expect(rows).toEqual([expect.objectContaining({ type: 'node', id: 7, version: 2, action: 'delete' })]);
    await expect(async () => {
      for await (const _ of parseOsmChange(Readable.from(['<osmChange><node id="7" version="2" lat="1" lon="2"/></osmChange>']))) { /* drain */ }
    }).rejects.toThrow(/outside create\/modify\/delete/);
  });

  it('applies bounded batches idempotently across retries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'change-apply-')); const store = new DeltaObjectStore(root);
    const xml = Buffer.from('<osmChange><create><node id="7" version="1" lat="1" lon="2"/></create><modify><node id="7" version="2" lat="3" lon="4"/></modify></osmChange>');
    try {
      expect(await applyChangeStreamToStore(store, Readable.from([xml]), { maxBatchObjects: 1 })).toEqual({ seen: 2, applied: 2 });
      expect(await applyChangeStreamToStore(store, Readable.from([xml]), { maxBatchObjects: 1 })).toEqual({ seen: 2, applied: 0 });
      expect(await store.get('node', 7)).toMatchObject({ version: 2, lat: 3, lon: 4 });
    } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
