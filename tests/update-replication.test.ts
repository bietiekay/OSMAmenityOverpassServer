import { describe, expect, it } from 'vitest';
import { sequenceUrl, stateUrl, fetchReplicationState } from '../scripts/update/replication.mjs';
import { openDiffXml } from '../scripts/update/replication.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('update replication source namespaces', () => {
  it('keeps regional daily and planet minute sequence layouts distinct', () => {
    expect(sequenceUrl({ baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day' }, 4939))
      .toBe('https://download.geofabrik.de/asia/japan-updates/000/004/939.osc.gz');
    expect(stateUrl({ baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day' }))
      .toBe('https://download.geofabrik.de/asia/japan-updates/state.txt');
    expect(sequenceUrl({ baseUrl: 'https://planet.openstreetmap.org/replication', kind: 'planet', interval: 'minute' }, 7329040))
      .toBe('https://planet.openstreetmap.org/replication/minute/007/329/040.osc.gz');
  });

  it('parses direct regional escaped state timestamps', async () => {
    const state = await fetchReplicationState({ baseUrl: 'https://example.test/japan-updates', kind: 'regional', interval: 'day' }, async () => new Response('# version=2\nsequenceNumber=4939\ntimestamp=2026-10-14T20\\:21\\:12Z\n# original OSM minutely replication sequence number 7329040\n'));
    expect(state.sequenceNumber).toBe(4939);
    expect(state.timestamp).toBe('2026-10-14T20:21:12Z');
  });

  it('surfaces truncated gzip failures through the diff stream', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bad-diff-'));
    const file = path.join(dir, 'broken.osc.gz');
    try {
      await fs.writeFile(file, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));
      await expect(async () => { for await (const _ of openDiffXml(file)) { /* drain */ } }).rejects.toThrow();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
