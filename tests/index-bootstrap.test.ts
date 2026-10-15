import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../src/config.js';
import type { AppLogger } from '../src/logger.js';
import { main } from '../src/index.js';
import type { UpdaterController } from '../src/updater.js';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

const config: ServerConfig = {
  port: 8090, dataDir: '/srv/osm/data', amenities: ['toilets'], shardPrecision: 5, shardCacheMb: 64,
  updateIntervalSeconds: 60, updateBaseUrl: 'https://planet.openstreetmap.org/replication',
  updateKind: 'planet', updateGranularity: 'minute', sourcePbf: null, reextractSourcePbf: null,
  reextractEverySeconds: 86400, redisUrl: null, logVerbosity: 'errors'
};

function testLogger() {
  return { info: vi.fn(), error: vi.fn() } as unknown as AppLogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function fixture({ failListen = false }: { failListen?: boolean } = {}) {
  const order: string[] = []; const hooks: Array<() => Promise<void>> = []; const signals = new EventEmitter();
  const logger = testLogger(); const stop = vi.fn(async () => { order.push('stop-updater'); });
  const app = {
    listen: vi.fn(async () => { order.push('listen'); if (failListen) throw new Error('bind failed'); }),
    addHook: vi.fn((_name: string, hook: () => Promise<void>) => { hooks.push(hook); }),
    close: vi.fn(async () => { order.push('close'); for (const hook of hooks) await hook(); })
  };
  const dependencies = {
    loadConfig: () => config,
    buildLogger: () => logger,
    createEngine: () => ({}) as never,
    createStats: () => ({}) as never,
    buildServer: async () => app as never,
    startUpdater: () => { order.push('start-updater'); return { stop } as UpdaterController; },
    signalTarget: signals as never
  };
  return { app, dependencies, hooks, logger, order, signals, stop };
}

describe('server bootstrap and shutdown', () => {
  it('starts the updater only after listen succeeds', async () => {
    const state = fixture({ failListen: true });
    await expect(main(state.dependencies)).rejects.toThrow('bind failed');
    expect(state.order).toEqual(['listen', 'close']);
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.app.addHook).toHaveBeenCalledTimes(1);
    expect(state.signals.listenerCount('SIGINT')).toBe(0);
    expect(state.signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('registers close hooks and signal handlers after a successful listen and closes once', async () => {
    const state = fixture();
    await main(state.dependencies);
    expect(state.order).toEqual(['listen', 'start-updater']);
    expect(state.app.addHook).toHaveBeenCalledWith('onClose', expect.any(Function));
    expect(state.signals.listenerCount('SIGINT')).toBe(1);
    expect(state.signals.listenerCount('SIGTERM')).toBe(1);
    state.signals.emit('SIGTERM'); state.signals.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.app.close).toHaveBeenCalledTimes(1);
    expect(state.stop).toHaveBeenCalledTimes(1);
    expect(state.order).toEqual(['listen', 'start-updater', 'close', 'stop-updater']);
  });

  it('uses a real Fastify instance to validate hook ordering and cleans up a rejected listen', async () => {
    const signals = new EventEmitter(); const log = testLogger(); const stop = vi.fn(async () => {});
    let app: FastifyInstance | undefined; let updaterStarts = 0;
    const dependencies = (port: number) => ({
      loadConfig: () => ({ ...config, port }), buildLogger: () => log,
      createEngine: () => ({ configureAmenities: vi.fn() }) as never,
      buildServer: async (options: Parameters<typeof buildServer>[0]) => { app = await buildServer(options); return app; },
      startUpdater: () => { updaterStarts++; return { stop } as UpdaterController; },
      signalTarget: signals as never
    });

    await main(dependencies(0));
    expect(app?.server.listening).toBe(true);
    expect(updaterStarts).toBe(1);
    signals.emit('SIGTERM');
    for (let i = 0; i < 50 && app?.server.listening; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(app?.server.listening).toBe(false);
    expect(stop).toHaveBeenCalledOnce();

    await expect(main(dependencies(-1))).rejects.toThrow();
    expect(updaterStarts).toBe(1);
    expect(app?.server.listening).toBe(false);

    const failedUpdater = dependencies(0);
    failedUpdater.startUpdater = () => { throw new Error('spawn rejected'); };
    await expect(main(failedUpdater)).rejects.toThrow('spawn rejected');
    expect(app?.server.listening).toBe(false);
    expect(updaterStarts).toBe(1);
  }, 10_000);
});
