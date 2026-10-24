import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { readLfLines } from '../scripts/read-lines.mjs';
import { coalesceDiffFiles } from '../scripts/update/coalesce-diffs.mjs';
import { importCoalescedPartitions, prepareCoalescedImport } from '../scripts/update/import-coalesced.mjs';
import { DeltaObjectStore, deltaPartitionForKey } from '../scripts/update/delta-store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

describe('newline-delimited update data', () => {
  it('treats only LF as a record separator and preserves Unicode line separators in JSON strings', async () => {
    const values = [];
    const bytes = Buffer.from('{"text":"before\u2028after"}\r\n{"text":"last"}');
    for await (const line of readLfLines(Readable.from([bytes.subarray(0, 12), bytes.subarray(12)]))) values.push(line);
    expect(values).toEqual(['{"text":"before\u2028after"}', '{"text":"last"}']);
    expect(JSON.parse(values[0]).text).toBe('before\u2028after');
  });

  it('coalesces and imports tags containing newlines without corrupting sorted spool rows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amenity-newline-'));
    const diff = path.join(root, '1.osc');
    const work = path.join(root, 'work');
    const deltaRoot = path.join(root, 'delta');
    const indexes = { dir: path.join(root, 'indexes'), objectCells: { get: async () => [] }, reverseParents: { get: async () => [] } };
    await fs.mkdir(path.join(indexes.dir, 'object-cells'), { recursive: true });
    await fs.mkdir(path.join(indexes.dir, 'reverse-parents'), { recursive: true });
    await fs.writeFile(diff, gzipSync('<osmChange version="0.6"><create><node id="42" version="1" timestamp="2026-01-01T00:00:00Z" lat="1" lon="2"><tag k="amenity" v="toilets"/><tag k="name" v="before&#10;after"/></node></create></osmChange>'));
    try {
      const coalesced = await coalesceDiffFiles([diff], work);
      const prepared = await prepareCoalescedImport(coalesced, indexes, ['toilets']);
      expect(prepared.relevant).toHaveLength(1);
      expect(prepared.relevant[0].tags.name).toBe('before\nafter');
      const store = new DeltaObjectStore(deltaRoot);
      const result = await importCoalescedPartitions(store, coalesced.file, coalesced.uniqueCount);
      expect(result.applied).toBe(1);
      expect((await store.get('node', 42))?.tags.name).toBe('before\nafter');
      store.close();
      await coalesced.cleanup();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('preserves U+2028 inside persisted delta JSONL values', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amenity-delta-separator-'));
    try {
      const store = new DeltaObjectStore(root);
      const bucket = deltaPartitionForKey('node:9');
      await fs.mkdir(store.dir, { recursive: true });
      await fs.writeFile(store.file(bucket), `${JSON.stringify({ type: 'node', id: 9, version: 1, tags: { operator: 'Alpha\u2028Beta' } })}\n`);
      expect((await store.get('node', 9))?.tags.operator).toBe('Alpha\u2028Beta');
      store.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
