import { spawn } from 'node:child_process';
import fs from 'node:fs';
const children = new Set();
let aborted = false;
export const wasAborted = () => aborted;
function terminate(child, signal) { try { if (child.__killGroup && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { try { child.kill(signal); } catch {} } }
export function registerChild(child) { children.add(child); child.once('close', () => children.delete(child)); return () => children.delete(child); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { aborted = true; for (const child of children) terminate(child, 'SIGTERM'); });

function processTreeRssBytes(rootPid) {
  if (!fs.existsSync('/proc')) return null;
  const pending = [rootPid]; const seen = new Set(); let totalKb = 0;
  while (pending.length) {
    const pid = pending.pop(); if (!pid || seen.has(pid)) continue; seen.add(pid);
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssKb = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
      if (rssKb === undefined) return null;
      totalKb += Number(rssKb);
      for (const child of fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/)) if (child) pending.push(Number(child));
    } catch { /* process exited during the sample */ }
  }
  return totalKb * 1024;
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { acceptCodes = [], maxOutputBytes = 8192, maxRssMb, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', ...spawnOptions }); child.__killGroup = process.platform !== 'win32'; registerChild(child); let stdout = ''; let stderr = ''; let overLimit = false;
    const max = maxOutputBytes;
    child.stdout?.on('data', d => { stdout = (stdout + d.toString()).slice(-max); }); child.stderr?.on('data', d => { stderr = (stderr + d.toString()).slice(-max); });
    let warnedNoRss = false;
    const timer = maxRssMb ? setInterval(() => { const rss = child.pid ? processTreeRssBytes(child.pid) : null; if (rss === null && !warnedNoRss) { warnedNoRss = true; console.warn(`RSS supervision unavailable for ${command} on this platform; --worker-ram-mb cannot be enforced`); } if (rss !== null && rss > maxRssMb * 1024 * 1024 && !overLimit) { overLimit = true; terminate(child, 'SIGTERM'); setTimeout(() => terminate(child, 'SIGKILL'), 1500).unref(); } }, 250) : null;
    child.on('error', error => { if (timer) clearInterval(timer); reject(error); });
    child.on('close', code => { if (timer) clearInterval(timer); if (overLimit) reject(new Error(`${command} process tree exceeded ${maxRssMb} MiB RSS`)); else if (code !== 0 && !acceptCodes.includes(code)) reject(new Error(`${command} exited ${code}: ${stderr}`)); else resolve({ stdout, stderr, code }); });
  });
}
/** Start a backpressured argv-only native pipeline and supervise combined RSS. */
export function runPipeline(commands, { maxRssMb, maxOutputBytes = 8192 } = {}) {
  if (!Array.isArray(commands) || commands.length < 2) throw new Error('pipeline needs at least two commands');
  const procs = [];
  let overLimit = false;
  let streamError = null;
  for (let i = 0; i < commands.length; i += 1) {
    const [command, args] = commands[i];
    const child = spawn(command, args, { stdio: [i === 0 ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.__killGroup = process.platform !== 'win32'; registerChild(child); child.stderrText = '';
    child.stderr.on('data', (b) => { child.stderrText = (child.stderrText + b.toString()).slice(-maxOutputBytes); });
    procs.push(child);
    // A downstream command may exit while upstream is still writing. Handle
    // EPIPE here and stop the whole pipeline instead of crashing the controller.
    child.stdin?.on('error', (error) => { streamError ??= error; killAll(); });
    child.stdout.on('error', (error) => { streamError ??= error; killAll(); });
    if (i > 0) procs[i - 1].stdout.pipe(child.stdin);
  }
  const killAll = (signal = 'SIGTERM') => { for (const child of procs) terminate(child, signal); };
  let timer = null; let warnedNoRss = false;
  if (maxRssMb) timer = setInterval(() => {
    let total = 0; let available = false;
    for (const child of procs) { if (!child.pid) continue; const rss = processTreeRssBytes(child.pid); if (rss === null) { available = false; break; } total += rss; available = true; }
    if (!available && !warnedNoRss) { warnedNoRss = true; console.warn(`RSS supervision unavailable for pipeline ${commands.map(([c]) => c).join(' | ')}; --worker-ram-mb cannot be enforced`); }
    if (available && total > maxRssMb * 1024 * 1024 && !overLimit) { overLimit = true; killAll(); setTimeout(() => killAll('SIGKILL'), 1500).unref(); }
  }, 250);
  const done = Promise.all(procs.map((child) => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { if (code !== 0) killAll(); resolve({ code, stderr: child.stderrText }); });
  }))).then((results) => {
    if (timer) clearInterval(timer);
    if (overLimit) throw new Error(`native pipeline exceeded ${maxRssMb} MiB combined RSS`);
    if (streamError) throw new Error(`native pipeline stream failed: ${streamError.message}`, { cause: streamError });
    const failed = results.find((r) => r.code !== 0);
    if (failed) throw new Error(`native pipeline command exited ${failed.code}: ${failed.stderr}`);
    return results;
  }, (error) => { if (timer) clearInterval(timer); killAll(); throw error; });
  return { stdout: procs.at(-1).stdout, done, kill: killAll };
}
export async function pool(items, concurrency, fn) { let next = 0; let error; await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (!error && !aborted) { const i = next++; if (i >= items.length) return; try { await fn(items[i], i); } catch (e) { error = e; } } })); if (error) throw error; if (aborted) throw new Error('extraction interrupted'); }
