import { describe, expect, it } from 'vitest';

import { catchUpSequenceList, downloadFile, fetchState, fileUrl, iterateCatchUpSequences, minuteFileUrl, parseStateTxt } from '../src/replication.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

async function localFeed(status = 200) {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(status);
    response.end(request.url?.endsWith('state.txt') ? STATE_V2 : Buffer.from([1, 2, 3]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local replication feed has no TCP port');
  return { baseUrl: `http://127.0.0.1:${address.port}`,
    requests, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

const STATE_V2 = `#version=2
sequenceNumber=7327518
timestamp=2026-10-13T18:33:25Z
`;

const STATE_V3 = `#version=3
sequenceNumber=123
timestamp=2026-10-14T00:00:00Z
md5sum=abcdef0123456789abcdef0123456789
`;

describe('parseStateTxt', () => {
  it('parses version 2 state', () => {
    const state = parseStateTxt(STATE_V2);
    expect(state.version).toBe(2);
    expect(state.sequenceNumber).toBe(7327518);
    expect(state.timestamp).toBe('2026-10-13T18:33:25Z');
    expect(state.md5).toBeUndefined();
  });

  it('parses version 3 state with md5', () => {
    const state = parseStateTxt(STATE_V3);
    expect(state.version).toBe(3);
    expect(state.sequenceNumber).toBe(123);
    expect(state.md5).toBe('abcdef0123456789abcdef0123456789');
  });

  it('unescapes escaped timestamp separators and records regional global cursor metadata', () => {
    const state = parseStateTxt('#version=3\nsequenceNumber=4939\ntimestamp=2026-10-14T02\\:04\\:00Z\n# original_planet_sequence=7329040\n');
    expect(state.timestamp).toBe('2026-10-14T02:04:00Z');
    expect(state.originalPlanetSequence).toBe(7329040);
  });

  it('reads Geofabrik original minutely sequence comments', () => {
    const state = parseStateTxt('#version=2\nsequenceNumber=4939\ntimestamp=2026-10-14T02:04:00Z\n# original OSM minutely replication sequence number 7329040\n');
    expect(state.originalPlanetSequence).toBe(7329040);
  });

  it('tolerates comment lines and CRLF', () => {
    const state = parseStateTxt('# comment\r\n#version=2\r\nsequenceNumber=42\r\ntimestamp=2026-10-14T01:02:03Z\r\n');
    expect(state.sequenceNumber).toBe(42);
    expect(state.timestamp).toBe('2026-10-14T01:02:03Z');
  });

  it('rejects a missing sequence', () => {
    expect(() => parseStateTxt('timestamp=2026-10-14T00:00:00Z\n')).toThrow(/sequenceNumber/);
  });

  it('rejects a missing timestamp', () => {
    expect(() => parseStateTxt('sequenceNumber=42\n')).toThrow(/timestamp/);
  });

  it('rejects invalid timestamps', () => {
    expect(() => parseStateTxt('sequenceNumber=1\ntimestamp=nope\n')).toThrow(/invalid timestamp/);
  });
});

describe('minuteFileUrl', () => {
  it('builds the standard 3/3/3 split', () => {
    expect(minuteFileUrl('https://planet.openstreetmap.org/replication', 7327518))
      .toBe('https://planet.openstreetmap.org/replication/minute/007/327/518.osc.gz');
  });

  it('zero-pads small sequences', () => {
    expect(minuteFileUrl('https://h', 1)).toBe('https://h/minute/000/000/001.osc.gz');
  });

  it('rejects non-positive sequences', () => {
    expect(() => minuteFileUrl('https://h', 0)).toThrow(/invalid minute sequence/);
  });

  it('keeps a regional daily namespace without converting its cursor', () => {
    expect(fileUrl('https://regional', 4939, 'day')).toBe('https://regional/day/000/004/939.osc.gz');
  });
});

describe('catchUpSequenceList', () => {
  it('lists (last, current]', () => {
    expect(catchUpSequenceList(7327510, 7327513)).toEqual([7327511, 7327512, 7327513]);
  });

  it('is empty when up to date or ahead', () => {
    expect(catchUpSequenceList(7327518, 7327518)).toEqual([]);
    expect(catchUpSequenceList(7327520, 7327518)).toEqual([]);
  });

  it('requires a last sequence', () => {
    expect(() => catchUpSequenceList(null, 5)).toThrow(/lastSeq is required/);
  });

  it('rejects a non-positive current sequence', () => {
    expect(() => catchUpSequenceList(1, 0)).toThrow(/invalid current sequence/);
  });

  it('bounds large ranges through the generator instead of allocating a list', () => {
    const generator = iterateCatchUpSequences(0, 3);
    expect([...generator]).toEqual([1, 2, 3]);
    expect(() => catchUpSequenceList(0, 100_001)).toThrow(/too large/);
  });
});

describe('replication requests', () => {
  it('fetches state and downloads a file, preserving response bytes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'replication-test-'));
    const target = path.join(dir, 'diff.osc.gz');
    const feed = await localFeed();
    try {
      expect((await fetchState(feed.baseUrl, 'day')).sequenceNumber).toBe(7327518);
      expect(await downloadFile(`${feed.baseUrl}/day/001/002/003.osc.gz`, target)).toBe(3);
      expect(feed.requests).toEqual(['/day/state.txt', '/day/001/002/003.osc.gz']);
      expect([...readFileSync(target)]).toEqual([1, 2, 3]);
    } finally { await feed.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports HTTP failures for state and diff downloads', async () => {
    const feed = await localFeed(503);
    try {
      await expect(fetchState(feed.baseUrl)).rejects.toThrow(/HTTP 503/);
      await expect(downloadFile(`${feed.baseUrl}/diff`, '/tmp/unwritten-diff')).rejects.toThrow(/HTTP 503/);
    } finally { await feed.close(); }
  });
});
