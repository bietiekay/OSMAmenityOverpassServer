import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readShard } from '../../dist/index/shard.js';

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Force every file and directory in a private generation before publishing it. */
export async function syncGenerationTree(root) {
  const syncTree = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await syncTree(target);
      else if (entry.isFile()) {
        const file = await fs.open(target, 'r');
        try { await file.sync(); } finally { await file.close(); }
      } else throw new Error(`generation contains unsupported filesystem entry: ${target}`);
    }
    await syncDirectory(directory);
  };
  await syncTree(root);
}

async function cloneTree(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await cloneTree(from, to);
    else if (entry.isFile()) {
      try { await fs.link(from, to); }
      catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'EMLINK'].includes(error.code)) throw error;
        await fs.copyFile(from, to);
      }
    } else throw new Error(`generation contains unsupported filesystem entry: ${from}`);
  }
}

/**
 * Build an isolated copy of the active generation, validate it, and atomically
 * switch data/ only after the callback completes. Files are hardlinked until
 * changed; callers must replace modified files atomically (write temp+rename)
 * so the currently served generation remains immutable.
 */
export async function withGenerationLock(dataDir, callback) {
  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, '.generation.lock');
  // This stable inode is never unlinked. flock attaches to the open file
  // description retained here, so the kernel releases it after crashes/SIGKILL.
  const lock = await fs.open(lockPath, 'a+');
  try {
    const acquired = await new Promise((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'pipe', lock.fd] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.slice(0, 8192 - stderr.length); });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stderr }));
    });
    if (acquired.code === 1) throw new Error('generation transaction already active');
    if (acquired.code !== 0) throw new Error(`could not acquire generation transaction lock with flock (exit ${acquired.code ?? acquired.signal}): ${acquired.stderr}`);
    await lock.truncate(0);
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await lock.sync();
    await syncDirectory(dataDir);
    return await callback();
  } catch (error) {
    if (error.code === 'ENOENT' && error.syscall === 'spawn flock') {
      throw new Error('generation locking requires the Linux flock command (install util-linux)');
    }
    throw error;
  } finally {
    await lock.close();
  }
}

export async function withGenerationTransaction(dataDir, mutate, options = {}) {
  return withGenerationLock(dataDir, () => runTransaction(dataDir, mutate, options));
}

/** Atomically activate a complete generation. Caller may hold the update lock. */
export async function activateGeneration(dataDir, generationDir, { lockHeld = false, beforeActivate = async () => {}, syncGeneration = syncGenerationTree } = {}) {
  const activate = async () => {
    const candidate = await fs.realpath(generationDir);
    const generations = await fs.realpath(path.join(dataDir, 'data-generations'));
    if (!candidate.startsWith(`${generations}${path.sep}`)) throw new Error('candidate generation must be inside data-generations');
    const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'manifest.json'), 'utf8'));
    const state = JSON.parse(await fs.readFile(path.join(candidate, 'state.json'), 'utf8'));
    if (!Array.isArray(manifest.shards)) throw new Error('candidate manifest has no declared shard list');
    for (const value of manifest.shards) {
      const cell = String(value).replace(/\.bin$/, '');
      if (!/^[0-9bcdefghjkmnpqrstuvwxyz]+$/.test(cell)) throw new Error(`invalid candidate shard name ${value}`);
      const shard = readShard(await fs.readFile(path.join(candidate, 'shards', `${cell}.bin`)));
      if (shard.header.configHash !== manifest.configHash) throw new Error(`candidate shard ${cell} config hash mismatch`);
    }
    const activeLink = path.join(dataDir, 'data');
    const activeRoot = await fs.realpath(activeLink).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    await beforeActivate({ activeRoot, candidateRoot: candidate, manifest, state });
    await syncGeneration(candidate);
    await syncDirectory(generations);
    const linkTemp = path.join(dataDir, `.data-${randomUUID()}`);
    await fs.symlink(path.relative(dataDir, candidate), linkTemp, 'dir');
    await fs.rename(linkTemp, activeLink);
    await syncDirectory(dataDir);
    return { generationDir: candidate, manifest, state };
  };
  return lockHeld ? activate() : withGenerationLock(dataDir, activate);
}

async function runTransaction(dataDir, mutate, { validate = async () => {}, beforeActivate = null, afterActivate = null } = {}) {
  const activeLink = path.join(dataDir, 'data');
  const activeRoot = await fs.realpath(activeLink);
  const generations = path.join(dataDir, 'data-generations');
  const txid = `update-${Date.now()}-${randomUUID()}`;
  const staging = path.join(generations, `.${txid}.staging`);
  const published = path.join(generations, txid);
  let activated = false;
  await fs.mkdir(generations, { recursive: true });
  try {
    await cloneTree(activeRoot, staging);
    const result = await mutate(staging, activeRoot);
    await validate(staging, result);
    if (beforeActivate) await beforeActivate(staging, result);
    await syncGenerationTree(staging);
    await fs.rename(staging, published);
    await syncDirectory(generations);
    const nextLink = path.join(dataDir, `.data-${txid}`);
    await fs.symlink(path.relative(dataDir, published), nextLink, 'dir');
    await fs.rename(nextLink, activeLink);
    activated = true;
    await syncDirectory(dataDir);
    if (afterActivate) { try { await afterActivate(published, result); } catch { /* publication is already valid; cache invalidation is best-effort */ } }
    return { generationDir: published, result };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (!activated) await fs.rm(published, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(dataDir, `.data-${txid}`), { force: true }).catch(() => {});
    throw error;
  }
}

/** Atomically replace a file, forcing data before the rename. */
export async function atomicWrite(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, file);
  await syncDirectory(path.dirname(file));
}
