import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { activateGeneration, syncGenerationTree, withGenerationLock, withGenerationTransaction, atomicWrite } from '../scripts/update/generation.mjs';

describe('generation update transaction', () => {
  it('keeps active bytes intact on failure and activates only after validation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-tx-'));
    const generations = path.join(root, 'data-generations');
    const original = path.join(generations, 'base');
    await fs.mkdir(path.join(original, 'shards'), { recursive: true });
    await fs.writeFile(path.join(original, 'shards', 'abc.bin'), 'old-shard');
    await fs.writeFile(path.join(original, 'state.json'), '{"lastSeq":1}\n');
    await fs.symlink(path.relative(root, original), path.join(root, 'data'), 'dir');
    const activeBytes = await fs.readFile(path.join(root, 'data/shards/abc.bin'));
    try {
      await expect(withGenerationTransaction(root, async (staging) => {
        await atomicWrite(path.join(staging, 'shards', 'abc.bin'), 'new-shard');
        throw new Error('simulated diff failure');
      })).rejects.toThrow('simulated diff failure');
      expect(await fs.readFile(path.join(root, 'data/shards/abc.bin'))).toEqual(activeBytes);
      await withGenerationTransaction(root, async (staging) => {
        await atomicWrite(path.join(staging, 'shards', 'abc.bin'), 'new-shard');
        await atomicWrite(path.join(staging, 'state.json'), '{"lastSeq":2}\n');
      }, { validate: async (staging) => {
        expect(await fs.readFile(path.join(staging, 'shards/abc.bin'), 'utf8')).toBe('new-shard');
      } });
      expect(await fs.readFile(path.join(root, 'data/shards/abc.bin'), 'utf8')).toBe('new-shard');
      expect(JSON.parse(await fs.readFile(path.join(root, 'data/state.json'), 'utf8')).lastSeq).toBe(2);
      expect(await fs.readFile(path.join(original, 'shards/abc.bin'), 'utf8')).toBe('old-shard');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('refuses overlapping update transactions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-lock-'));
    const original = path.join(root, 'data-generations', 'base');
    await fs.mkdir(original, { recursive: true }); await fs.writeFile(path.join(original, 'state.json'), '{}');
    await fs.symlink(path.relative(root, original), path.join(root, 'data'), 'dir');
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const pending = withGenerationTransaction(root, async () => { entered(); await gate; });
    try {
      await inside;
      await expect(withGenerationTransaction(root, async () => {})).rejects.toThrow(/already active/);
      release(); await pending;
    } finally { release(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it('releases the kernel lock after the owning process is killed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-kill-'));
    const ready = path.join(root, 'ready');
    const moduleUrl = pathToFileURL(path.resolve('scripts/update/generation.mjs')).href;
    const childCode = `import fs from 'node:fs/promises'; import { withGenerationLock } from ${JSON.stringify(moduleUrl)}; await withGenerationLock(${JSON.stringify(root)}, async () => { await fs.writeFile(${JSON.stringify(ready)}, 'locked'); setInterval(() => {}, 1000); await new Promise(() => {}); });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const childClosed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
    try {
      let started = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await fs.stat(ready).catch(() => null)) { started = true; break; }
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(started, stderr).toBe(true);
      child.kill('SIGKILL');
      await childClosed;
      let acquired = false;
      await withGenerationLock(root, async () => { acquired = true; });
      expect(acquired).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10000);

  it('syncs a complete candidate tree before the active symlink is published', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-sync-'));
    const candidate = path.join(root, 'data-generations', 'candidate');
    await fs.mkdir(path.join(candidate, 'nested'), { recursive: true });
    await fs.writeFile(path.join(candidate, 'manifest.json'), JSON.stringify({ configHash: '0'.repeat(64), shards: [] }));
    await fs.writeFile(path.join(candidate, 'state.json'), '{}\n');
    await fs.writeFile(path.join(candidate, 'nested', 'objects.bin'), 'durable payload');
    let syncCompletedBeforeLink = false;
    try {
      await activateGeneration(root, candidate, {
        syncGeneration: async (directory) => {
          await syncGenerationTree(directory);
          syncCompletedBeforeLink = !(await fs.lstat(path.join(root, 'data')).catch(() => null));
        }
      });
      expect(syncCompletedBeforeLink).toBe(true);
      expect(await fs.readFile(path.join(root, 'data', 'nested', 'objects.bin'), 'utf8')).toBe('durable payload');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
