import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { ServerConfig } from './config.js';
import type { AppLogger } from './logger.js';

export interface UpdaterController {
  stop: () => Promise<void>;
}

export interface UpdaterDependencies {
  spawnProcess?: typeof spawn;
  shutdownGraceMs?: number;
  killProcessGroup?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
}

/** Run replication catch-up out of process so native osmium work stays isolated. */
export const startUpdater = (config: ServerConfig, logger: AppLogger, dependencies: UpdaterDependencies = {}): UpdaterController => {
  const pipelineDir = path.resolve(
    path.basename(config.dataDir) === 'data' ? path.dirname(config.dataDir) : config.dataDir
  );
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/update.mjs');
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const shutdownGraceMs = dependencies.shutdownGraceMs ?? 5_000;
  let child: ChildProcess | null = null;
  let stopped = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const launch = (): void => {
    if (stopped) return;
    const current = spawnProcess(process.execPath, [script, '--data-dir', pipelineDir, '--watch'], {
      cwd: path.dirname(path.dirname(script)),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    child = current;
    if (current.stdout) {
      const out = createInterface({ input: current.stdout });
      out.on('line', (line) => logger.info({ updater: line }, 'OSM update'));
    }
    if (current.stderr) {
      const err = createInterface({ input: current.stderr });
      err.on('line', (line) => logger.error({ updater: line }, 'OSM update'));
    }
    let finished = false;
    const finishedChild = (code: number | null, signal: string | null, error?: Error): void => {
      if (finished) return;
      finished = true;
      if (error) logger.error({ err: error }, 'updater process failed to start');
      if (child === current) child = null;
      if (stopped) return;
      logger.error({ code, signal }, 'updater process exited; restarting after 10 seconds');
      restartTimer = setTimeout(launch, 10_000);
      restartTimer.unref();
    };
    current.once('error', (error) => finishedChild(null, null, error));
    current.once('exit', (code, signal) => finishedChild(code, signal));
  };
  launch();

  return {
    stop: async () => {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      const current = child;
      if (!current) return;
      await new Promise<void>((resolve) => {
        const signalGroup = (signal: 'SIGTERM' | 'SIGKILL'): void => {
          if (process.platform !== 'win32' && current.pid) {
            try {
              if (dependencies.killProcessGroup) dependencies.killProcessGroup(current.pid, signal);
              else process.kill(-current.pid, signal);
              return;
            } catch { /* fall back to the direct child */ }
          }
          current.kill(signal);
        };
        const timeout = setTimeout(() => signalGroup('SIGKILL'), shutdownGraceMs);
        const done = (): void => { clearTimeout(timeout); resolve(); };
        current.once('exit', done);
        current.once('close', done);
        signalGroup('SIGTERM');
      });
      child = null;
    }
  };
};
