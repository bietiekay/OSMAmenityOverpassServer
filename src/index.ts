/**
 * Entry point (plan §10): config -> engine -> server -> self-update loop.
 */
import { loadConfig } from './config.js';
import { buildLogger } from './logger.js';
import { AmenityEngine } from './index/engine.js';
import { buildServer } from './server.js';
import { Stats } from './stats.js';
import { startUpdater, type UpdaterController } from './updater.js';
import type { ServerConfig } from './config.js';
import type { AppLogger } from './logger.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATOR = 'osm-amenity-overpass-server';

export interface MainDependencies {
  loadConfig?: typeof loadConfig;
  buildLogger?: typeof buildLogger;
  createEngine?: (options: ConstructorParameters<typeof AmenityEngine>[0], logger: AppLogger) => AmenityEngine;
  createStats?: () => Stats;
  buildServer?: typeof buildServer;
  startUpdater?: (config: ServerConfig, logger: AppLogger) => UpdaterController;
  signalTarget?: { once: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown };
}

export const main = async (dependencies: MainDependencies = {}): Promise<void> => {
  const config = (dependencies.loadConfig ?? loadConfig)();
  const logger = (dependencies.buildLogger ?? buildLogger)(config.logVerbosity);

  const createEngine = dependencies.createEngine ?? ((options, log) => new AmenityEngine(options, log));
  const engine = createEngine(
    {
      dataDir: config.dataDir,
      shardPrecision: config.shardPrecision,
      cacheMb: config.shardCacheMb,
      generator: GENERATOR
    },
    logger
  );

  const stats = (dependencies.createStats ?? (() => new Stats()))();
  const app = await (dependencies.buildServer ?? buildServer)({
    config,
    engine,
    stats,
    logger,
    serverVersion: GENERATOR
  });

  let updater: UpdaterController | null = null;
  app.addHook('onClose', async () => { await updater?.stop(); });
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    try { await app.close(); } catch (closeError) { logger.error({ err: closeError }, 'server cleanup after listen failure failed'); }
    throw error;
  }
  try {
    updater = (dependencies.startUpdater ?? startUpdater)(config, logger);
  } catch (error) {
    try { await app.close(); } catch (closeError) { logger.error({ err: closeError }, 'server cleanup after updater start failure failed'); }
    throw error;
  }
  logger.info({ updateBaseUrl: config.updateBaseUrl, updateKind: config.updateKind, updateGranularity: config.updateGranularity, sourcePbfOverride: config.sourcePbf !== null }, 'OSM updater started');

  const signalTarget = dependencies.signalTarget ?? process;
  let closing = false;
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    await app.close();
  };
  signalTarget.once('SIGINT', () => { void close('SIGINT').catch((error) => logger.error({ err: error }, 'shutdown failed')); });
  signalTarget.once('SIGTERM', () => { void close('SIGTERM').catch((error) => logger.error({ err: error }, 'shutdown failed')); });
  logger.info(
    {
      port: config.port,
      dataDir: config.dataDir,
      amenities: config.amenities,
      shardPrecision: config.shardPrecision,
      updateIntervalSeconds: config.updateIntervalSeconds,
      generationsToKeep: config.generationsToKeep
    },
    'osm-amenity-overpass-server listening'
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
