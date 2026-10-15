import { describe, expect, it } from 'vitest';

import { loadConfig, normalizeAmenityValue, redisInvalidationEnabled } from '../src/config.js';
import { afterEach, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

describe('normalizeAmenityValue', () => {
  it('trims and lowercases', () => {
    expect(normalizeAmenityValue('  Toilets ')).toBe('toilets');
    expect(normalizeAmenityValue('DRINKING_WATER')).toBe('drinking_water');
  });

  it('keeps valid multi-word values', () => {
    expect(normalizeAmenityValue('  drinking water  ')).toBe('drinking water');
  });
});

describe('loadConfig', () => {
  it('returns the documented defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8081);
    expect(config.dataDir).toBe('.');
    expect(config.amenities).toEqual(['toilets']);
    expect(config.shardPrecision).toBe(5);
    expect(config.shardCacheMb).toBe(256);
    expect(config.updateIntervalSeconds).toBe(3600);
    expect(config.updateBaseUrl).toBe('https://planet.openstreetmap.org/replication');
    expect(config.updateKind).toBe('planet');
    expect(config.updateGranularity).toBe('minute');
    expect(config.sourcePbf).toBeNull();
    expect(config.reextractSourcePbf).toBeNull();
    expect(config.reextractEverySeconds).toBe(604800);
    expect(config.redisUrl).toBeNull();
    expect(config.logVerbosity).toBe('info');
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      PORT: '9000',
      OSM_AMENITY_DATA_DIR: '/data/x',
      OSM_AMENITY_AMENITIES: 'Toilets, drinking_water, toilets',
      OSM_AMENITY_SHARD_PRECISION: '4',
      OSM_AMENITY_SHARD_CACHE_MB: '64',
      OSM_AMENITY_UPDATE_INTERVAL_SECONDS: '60',
      OSM_AMENITY_REDIS_URL: 'redis://host:6379'
    });
    expect(config.port).toBe(9000);
    expect(config.dataDir).toBe('/data/x');
    expect(config.amenities).toEqual(['toilets', 'drinking_water']);
    expect(config.shardPrecision).toBe(4);
    expect(config.shardCacheMb).toBe(64);
    expect(config.updateIntervalSeconds).toBe(60);
    expect(config.redisUrl).toBe('redis://host:6379');
  });

  it('strips trailing slashes from the update base url', () => {
    const config = loadConfig({ OSM_AMENITY_UPDATE_BASE_URL: 'https://host/replication/' });
    expect(config.updateBaseUrl).toBe('https://host/replication');
  });

  it('infers regional daily replication for Geofabrik source roots', () => {
    const config = loadConfig({
      OSM_AMENITY_UPDATE_BASE_URL: 'https://download.geofabrik.de/asia/japan-updates/'
    });
    expect(config.updateBaseUrl).toBe('https://download.geofabrik.de/asia/japan-updates');
    expect(config.updateKind).toBe('regional');
    expect(config.updateGranularity).toBe('day');
  });

  it('reads an optional retained PBF path for updates and drift re-extracts', () => {
    expect(loadConfig({ OSM_AMENITY_SOURCE_PBF: ' /source/japan.osm.pbf ' }).sourcePbf)
      .toBe('/source/japan.osm.pbf');
  });

  it('allows a separate PBF source for weekly drift re-extracts', () => {
    expect(loadConfig({ OSM_AMENITY_REEXTRACT_SOURCE_PBF: ' /archive/newer.osm.pbf ' }).reextractSourcePbf)
      .toBe('/archive/newer.osm.pbf');
    expect(loadConfig({ OSM_AMENITY_REEXTRACT_SOURCE_PBF: '  ' }).reextractSourcePbf).toBeNull();
  });

  it('rejects an empty amenity list', () => {
    expect(() => loadConfig({ OSM_AMENITY_AMENITIES: ', , ' })).toThrow(/at least one/);
  });

  it('rejects a non-integer port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT must be an integer/);
  });

  it('rejects non-positive numeric configuration', () => {
    expect(() => loadConfig({ OSM_AMENITY_UPDATE_INTERVAL_SECONDS: '0' })).toThrow(/positive integer/);
    expect(() => loadConfig({ OSM_AMENITY_SHARD_CACHE_MB: '-1' })).toThrow(/positive integer/);
  });

  it('rejects an unsupported shard precision', () => {
    expect(() => loadConfig({ OSM_AMENITY_SHARD_PRECISION: '12' })).toThrow(/must be one of/);
  });

  it('rejects an unknown verbosity', () => {
    expect(() => loadConfig({ LOG_VERBOSITY: 'verbose' })).toThrow(/LOG_VERBOSITY/);
  });

  it('reads the Redis invalidation toggle only when Redis is configured', () => {
    const configured = loadConfig({ OSM_AMENITY_REDIS_URL: 'redis://localhost' });
    const absent = loadConfig({});
    expect(redisInvalidationEnabled(absent)).toBe(false);
    vi.stubEnv('OSM_AMENITY_REDIS_INVALIDATE', 'true');
    expect(redisInvalidationEnabled(configured)).toBe(true);
    vi.stubEnv('OSM_AMENITY_REDIS_INVALIDATE', 'false');
    expect(redisInvalidationEnabled(configured)).toBe(false);
    vi.stubEnv('OSM_AMENITY_REDIS_INVALIDATE', 'maybe');
    expect(() => redisInvalidationEnabled(configured)).toThrow(/true\/false/);
  });
});
