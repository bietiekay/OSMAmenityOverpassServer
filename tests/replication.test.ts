import { describe, expect, it } from 'vitest';

import { catchUpSequenceList, minuteFileUrl, parseStateTxt } from '../src/replication.js';

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
});

describe('minuteFileUrl', () => {
  it('builds the standard 3/3/1 split', () => {
    expect(minuteFileUrl('https://planet.openstreetmap.org/replication', 7327518))
      .toBe('https://planet.openstreetmap.org/replication/minute/732/751/8.osc.gz');
  });

  it('zero-pads small sequences', () => {
    expect(minuteFileUrl('https://h', 1)).toBe('https://h/minute/000/000/1.osc.gz');
  });

  it('rejects non-positive sequences', () => {
    expect(() => minuteFileUrl('https://h', 0)).toThrow(/invalid minute sequence/);
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
});
