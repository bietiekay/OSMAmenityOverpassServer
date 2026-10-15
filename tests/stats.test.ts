import { describe, expect, it } from 'vitest';

import { percentile, Stats } from '../src/stats.js';

describe('percentile', () => {
  it('returns 0 for empty samples', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('computes p50/p95 with linear interpolation', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(values, 50)).toBe(50.5);
    expect(percentile(values, 95)).toBe(95.05);
  });

  it('handles single-element samples', () => {
    expect(percentile([42], 95)).toBe(42);
  });
});

describe('Stats', () => {
  it('snapshots queries, errors and latencies', () => {
    const stats = new Stats();
    stats.recordQuery(10);
    stats.recordQuery(20);
    stats.recordError();
    const snap = stats.snapshot(3, 2);
    expect(snap.queries).toBe(2);
    expect(snap.errors).toBe(1);
    expect(snap.shardCacheHits).toBe(3);
    expect(snap.shardCacheMisses).toBe(2);
    expect(snap.latencyP50Ms).toBe(15);
    expect(snap.latencyP95Ms).toBe(19.5);
    expect(typeof snap.lastQueryAt).toBe('string');
  });
});
