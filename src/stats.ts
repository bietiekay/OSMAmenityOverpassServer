/**
 * Local stats provider (plan §10): query latency p50/p95, shard-cache
 * hit/miss counters, error counts. Feeds /api/status and the TTL-tuning
 * measurement phase (plan §9).
 */

export interface StatsSnapshot {
  queries: number;
  errors: number;
  shardCacheHits: number;
  shardCacheMisses: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  lastQueryAt: string | null;
}

/** Linear-interpolation percentile over an unsorted sample. */
export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) {
    return sorted[low];
  }
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
};

const MAX_LATENCY_SAMPLES = 4096;

export class Stats {
  private latencies: number[] = [];
  private queries = 0;
  private errors = 0;
  private lastQueryAt: number | null = null;

  public recordQuery = (latencyMs: number): void => {
    this.queries += 1;
    this.lastQueryAt = Date.now();
    this.latencies.push(latencyMs);
    if (this.latencies.length > MAX_LATENCY_SAMPLES) {
      this.latencies.splice(0, this.latencies.length - MAX_LATENCY_SAMPLES);
    }
  };

  public recordError = (): void => {
    this.errors += 1;
  };

  public snapshot = (cacheHits: number, cacheMisses: number): StatsSnapshot => ({
    queries: this.queries,
    errors: this.errors,
    shardCacheHits: cacheHits,
    shardCacheMisses: cacheMisses,
    latencyP50Ms: Math.round(percentile(this.latencies, 50) * 100) / 100,
    latencyP95Ms: Math.round(percentile(this.latencies, 95) * 100) / 100,
    lastQueryAt: this.lastQueryAt === null ? null : new Date(this.lastQueryAt).toISOString()
  });
}
