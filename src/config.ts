/**
 * Server configuration from the OSM_AMENITY_* environment namespace (plan §11).
 *
 * Replication cadence is inferred from the configured base URL. Planet uses
 * minute diffs; Geofabrik regional sources use daily diffs.
 */

export type Env = Record<string, string | undefined>;

export interface ServerConfig {
  port: number;
  dataDir: string;
  amenities: string[];
  shardPrecision: number;
  shardCacheMb: number;
  updateIntervalSeconds: number;
  generationsToKeep: number;
  updateBaseUrl: string;
  updateKind: 'regional' | 'planet';
  updateGranularity: 'minute' | 'day';
  sourcePbf: string | null;
  reextractSourcePbf: string | null;
  reextractEverySeconds: number;
  redisUrl: string | null;
  logVerbosity: 'errors' | 'info' | 'debug';
}

export const normalizeAmenityValue = (value: string): string => value.trim().toLowerCase();

const readInt = (
  env: Env,
  name: string,
  fallback: number,
  allowed?: number[]
): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  if (value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  if (allowed && !allowed.includes(value)) {
    throw new Error(`${name} must be one of [${allowed.join(', ')}], got: ${value}`);
  }
  return value;
};

const readBool = (env: Env, name: string, fallback: boolean): boolean => {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  throw new Error(`${name} must be true/false, got: ${raw}`);
};

export const loadConfig = (env: Env = process.env): ServerConfig => {
  const amenities = (env.OSM_AMENITY_AMENITIES ?? 'toilets')
    .split(',')
    .map((value) => normalizeAmenityValue(value))
    .filter((value) => value.length > 0);

  if (amenities.length === 0) {
    throw new Error('OSM_AMENITY_AMENITIES must contain at least one amenity value');
  }

  const logVerbosityRaw = (env.LOG_VERBOSITY ?? 'info').trim().toLowerCase();
  if (logVerbosityRaw !== 'errors' && logVerbosityRaw !== 'info' && logVerbosityRaw !== 'debug') {
    throw new Error(`LOG_VERBOSITY must be errors|info|debug, got: ${logVerbosityRaw}`);
  }

  const redisUrlRaw = env.OSM_AMENITY_REDIS_URL;

  const updateBaseUrl = (env.OSM_AMENITY_UPDATE_BASE_URL ?? 'https://planet.openstreetmap.org/replication')
    .replace(/\/+$/, '');
  const regional = /(?:^|\.)geofabrik\.de(?:\/|$)/i.test(new URL(updateBaseUrl).hostname);
  const generationsToKeep = readInt(env, 'OSM_AMENITY_GENERATIONS_TO_KEEP', 2);
  if (generationsToKeep < 2) throw new Error('OSM_AMENITY_GENERATIONS_TO_KEEP must be at least 2');

  return {
    port: readInt(env, 'PORT', 8081),
    dataDir: env.OSM_AMENITY_DATA_DIR?.trim() ? env.OSM_AMENITY_DATA_DIR.trim() : '.',
    amenities: [...new Set(amenities)],
    shardPrecision: readInt(env, 'OSM_AMENITY_SHARD_PRECISION', 5, [3, 4, 5, 6, 7]),
    shardCacheMb: readInt(env, 'OSM_AMENITY_SHARD_CACHE_MB', 256),
    updateIntervalSeconds: readInt(env, 'OSM_AMENITY_UPDATE_INTERVAL_SECONDS', 3600),
    generationsToKeep,
    updateBaseUrl,
    updateKind: regional ? 'regional' : 'planet',
    updateGranularity: regional ? 'day' : 'minute',
    sourcePbf: env.OSM_AMENITY_SOURCE_PBF?.trim() || null,
    reextractSourcePbf: env.OSM_AMENITY_REEXTRACT_SOURCE_PBF?.trim() || null,
    reextractEverySeconds: readInt(env, 'OSM_AMENITY_REEXTRACT_EVERY_SECONDS', 604800),
    redisUrl:
      redisUrlRaw && redisUrlRaw.trim().length > 0 ? redisUrlRaw.trim() : null,
    logVerbosity: logVerbosityRaw
  };
};

/** Reserved for Phase 2 (optional direct tile-key invalidation via the proxy Redis). */
export const redisInvalidationEnabled = (config: ServerConfig): boolean =>
  config.redisUrl !== null && readBool(process.env, 'OSM_AMENITY_REDIS_INVALIDATE', false);
