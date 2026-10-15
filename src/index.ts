/**
 * Entry point (plan §10): config -> engine -> server -> self-update loop.
 */
import { loadConfig } from './config.js';
import { buildLogger } from './logger.js';
import { AmenityEngine } from './index/engine.js';
import { buildServer } from './server.js';
import { Stats } from './stats.js';

const GENERATOR = 'osm-amenity-overpass-server';

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = buildLogger(config.logVerbosity);

  const engine = new AmenityEngine(
    {
      dataDir: config.dataDir,
      shardPrecision: config.shardPrecision,
      cacheMb: config.shardCacheMb,
      generator: GENERATOR
    },
    logger
  );

  const stats = new Stats();
  const app = await buildServer({
    config,
    engine,
    stats,
    logger,
    serverVersion: GENERATOR
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(
    {
      port: config.port,
      dataDir: config.dataDir,
      amenities: config.amenities,
      shardPrecision: config.shardPrecision,
      updateIntervalSeconds: config.updateIntervalSeconds
    },
    'osm-amenity-overpass-server listening'
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
