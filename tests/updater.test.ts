import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../src/config.js';
import type { AppLogger } from '../src/logger.js';
import { startUpdater } from '../src/updater.js';

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(signal: NodeJS.Signals) { this.signals.push(signal); return true; }
}
const config = (dataDir = '/srv/osm/data'): ServerConfig => ({
  port: 8080, dataDir, amenities: ['toilets'], shardPrecision: 5, shardCacheMb: 128,
  updateIntervalSeconds: 3600, updateBaseUrl: 'https://planet.openstreetmap.org/replication',
  updateKind: 'planet', updateGranularity: 'minute', sourcePbf: null, reextractSourcePbf: null,
  reextractSourceUrl: null, reextractChecksumUrl: null, reextractEnabled: false,
  reextractEverySeconds: 86400, redisUrl: null, logVerbosity: 'errors'
});
function logger() {
  return { info: vi.fn(), error: vi.fn() } as unknown as AppLogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}
afterEach(() => { vi.useRealTimers(); });

describe('updater process lifecycle', () => {
  it('launches the update script by absolute path and streams child logs', async () => {
    const child = new FakeChild(); const log = logger(); let call: { executable: string; args: string[]; options: SpawnOptions } | undefined;
    const updater = startUpdater(config(), log, {
      spawnProcess: ((executable: string, args: string[], options: SpawnOptions) => {
        call = { executable, args, options }; return child as unknown as ChildProcess;
      }) as never
    });
    expect(call?.executable).toBe(process.execPath);
    expect(path.isAbsolute(call!.args[0])).toBe(true);
    expect(call!.args[0]).toMatch(/scripts[\/]update\.mjs$/);
    expect(call!.args.slice(1)).toEqual(['--data-dir', '/srv/osm', '--watch']);
    expect(path.isAbsolute(call!.options.cwd as string)).toBe(true);
    child.stdout.write('sequence 10 applied\n'); child.stderr.write('one warning\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.info).toHaveBeenCalledWith({ updater: 'sequence 10 applied' }, 'OSM update');
    expect(log.error).toHaveBeenCalledWith({ updater: 'one warning' }, 'OSM update');
    child.emit('exit', 0, null);
    await updater.stop();
  });

  it('restarts after both process exits and spawn errors, then cancels pending restarts on stop', async () => {
    vi.useFakeTimers(); const children: FakeChild[] = [];
    const updater = startUpdater(config('/srv/osm'), logger(), {
      spawnProcess: (() => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; }) as never
    });
    children[0].emit('exit', 2, null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children).toHaveLength(2);
    children[1].emit('error', new Error('spawn failed'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children).toHaveLength(3);
    children[2].emit('exit', 0, null);
    const pendingStop = updater.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    await pendingStop;
    expect(children).toHaveLength(3);
  });

  it('sends SIGTERM and escalates to SIGKILL after the bounded grace period', async () => {
    vi.useFakeTimers(); const child = new FakeChild(); const groups: string[] = [];
    const updater = startUpdater(config(), logger(), {
      shutdownGraceMs: 250,
      spawnProcess: (() => child as unknown as ChildProcess) as never,
      killProcessGroup: (_pid, signal) => groups.push(signal)
    });
    const stopping = updater.stop();
    expect(groups).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(250);
    expect(groups).toEqual(['SIGTERM', 'SIGKILL']);
    child.emit('exit', null, 'SIGKILL');
    await stopping;
  });

  it('falls back to killing a direct child when process-group signaling fails', async () => {
    const child = new FakeChild();
    const updater = startUpdater(config(), logger(), {
      spawnProcess: (() => child as unknown as ChildProcess) as never,
      killProcessGroup: () => { throw new Error('not a process group'); }
    });
    const stopping = updater.stop();
    expect(child.signals).toEqual(['SIGTERM']);
    child.emit('exit', 0, null);
    await stopping;
  });

  it('finishes shutdown on close when an unsuccessful spawn has no PID or exit event', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', -2, null)); return false; });
    const groupKill = vi.fn();
    const updater = startUpdater(config(), logger(), {
      spawnProcess: (() => child as unknown as ChildProcess) as never,
      killProcessGroup: groupKill
    });
    await updater.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(groupKill).not.toHaveBeenCalled();
  });
});
