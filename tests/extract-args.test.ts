import { describe, expect, it } from 'vitest';
import { flagBool, flagInt, parseArgs, parseStages } from '../scripts/extract/args.mjs';
import { createRunConfig, sourceMetadataFromHeader } from '../scripts/extract.mjs';

describe('extract CLI argument parsing', () => {
  it('parses flags, values, aliases, and ranges', () => {
    expect(parseArgs(['--source', 'a.pbf', '--verify', '--keep-chunks', 'false'])).toEqual({ source: 'a.pbf', verify: true, 'keep-chunks': 'false' });
    expect(parseStages(undefined)).toEqual([0]);
    expect(parseStages('4')).toEqual([4]);
    expect(parseStages('0-4')).toEqual([0, 1, 2, 3, 4]);
  });
  it('rejects invalid flags and unsupported stage ranges', () => {
    expect(() => parseArgs(['positional'])).toThrow(/Unexpected argument/);
    expect(() => parseStages('4-0')).toThrow(/within 0..4/);
    expect(() => parseStages('0-5')).toThrow(/within 0..4/);
    expect(() => parseStages('a-b')).toThrow(/like/);
    expect(() => flagInt({ workers: '0' }, 'workers', 2)).toThrow(/positive integer/);
    expect(() => flagBool({ verify: 'maybe' }, 'verify', false)).toThrow(/true\/false/);
  });
  it('normalizes boolean variants and integer defaults', () => {
    expect(flagBool({}, 'verify', false)).toBe(false);
    expect(flagBool({ verify: true }, 'verify', false)).toBe(true);
    expect(flagBool({ verify: 'YES' }, 'verify', false)).toBe(true);
    expect(flagBool({ verify: 'off' }, 'verify', true)).toBe(false);
    expect(flagInt({}, 'workers', 4)).toBe(4);
    expect(flagInt({ workers: '3' }, 'workers', 4)).toBe(3);
  });
  it('caps worker concurrency against RAM and CPU budgets', () => {
    const config = createRunConfig(['--planet-source', 'japan.pbf', '--data-dir', 'out', '--workers', '12', '--ram-mb', '2048', '--worker-ram-mb', '512', '--stages', '1-3'], '/tmp/project', 8);
    expect(config).toMatchObject({ source: 'japan.pbf', dataDir: '/tmp/project/out', workers: 3, stages: [1, 2, 3], chunkMb: 1024, amenities: ['toilets'] });
    expect(createRunConfig(['--workers', '8'], '/tmp/project', 2).workers).toBe(2);
    expect(() => createRunConfig(['--ram-mb', '700', '--worker-ram-mb', '512'])).toThrow(/leave room/);
  });
  it('derives replication namespace and interval from each source header without fabricated values', () => {
    expect(sourceMetadataFromHeader({ option: {} })).toEqual({ timestamp: null, replication: undefined });
    expect(sourceMetadataFromHeader({ option: { timestamp: '2026-10-15T00:00:00Z' } })).toEqual({ timestamp: '2026-10-15T00:00:00Z', replication: undefined });
    expect(sourceMetadataFromHeader({ option: {
      osmosis_replication_base_url: 'https://planet.osm.org/replication/minute',
      osmosis_replication_sequence_number: '123', osmosis_replication_timestamp: '2026-10-15T01:00:00Z'
    } })).toEqual({ timestamp: '2026-10-15T01:00:00Z', replication: {
      baseUrl: 'https://planet.osm.org/replication/minute', sequenceNumber: 123, kind: 'planet', interval: 'minute'
    } });
    expect(sourceMetadataFromHeader({ option: {
      osmosis_replication_base_url: 'https://download.geofabrik.de/asia/japan-updates',
      osmosis_replication_sequence_number: '7'
    } }).replication).toEqual({ baseUrl: 'https://download.geofabrik.de/asia/japan-updates', sequenceNumber: 7, kind: 'regional', interval: 'day' });
    expect(sourceMetadataFromHeader({ option: {
      osmosis_replication_base_url: 'https://example.test/custom', osmosis_replication_sequence_number: 'bad'
    } }).replication).toBeUndefined();
  });
});
