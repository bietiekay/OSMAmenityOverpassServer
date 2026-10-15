import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { parseStateTxt, iterateCatchUpSequences } from '../../dist/replication.js';

const parts = (sequence) => String(sequence).padStart(9, '0').match(/.{3}/g);

/** Namespace-local replication URL. Regional feeds use a direct base layout. */
export function sequenceUrl(replication, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error(`invalid replication sequence ${sequence}`);
  if (sequence > 999999999) throw new Error(`replication sequence ${sequence} exceeds the nine-digit URL layout`);
  const [a, b, c] = parts(sequence);
  const base = replication.baseUrl.replace(/\/+$/, '');
  const prefix = replication.kind === 'regional' || base.endsWith(`/${replication.interval}`) ? base : `${base}/${replication.interval}`;
  return `${prefix}/${a}/${b}/${c}.osc.gz`;
}

export function stateUrl(replication) {
  const base = replication.baseUrl.replace(/\/+$/, '');
  return replication.kind === 'regional' || base.endsWith(`/${replication.interval}`)
    ? `${base}/state.txt`
    : `${base}/${replication.interval}/state.txt`;
}

export async function fetchReplicationState(replication, fetchImpl = fetch, { signal } = {}) {
  const url = stateUrl(replication); const response = await fetchImpl(url, { signal, headers: { 'user-agent': 'osm-amenity-overpass-server' } });
  if (!response.ok) throw new Error(`replication state fetch failed: HTTP ${response.status} for ${url}`);
  return parseStateTxt(await response.text());
}

/** Stream a compressed diff to a temp path without keeping its bytes in memory. */
export async function downloadDiff(replication, sequence, destination, { fetchImpl = fetch, maxBytes = 128 * 1024 * 1024, expectedMd5 = null, signal } = {}) {
  const url = sequenceUrl(replication, sequence); const response = await fetchImpl(url, { signal, headers: { 'user-agent': 'osm-amenity-overpass-server' } });
  if (!response.ok || !response.body) throw new Error(`replication diff fetch failed: HTTP ${response.status} for ${url}`);
  const temporary = `${destination}.${randomUUID()}.tmp`; await fs.mkdir(path.dirname(destination), { recursive: true });
  let count = 0; const digest = createHash('md5');
  const limiter = new (await import('node:stream')).Transform({ transform(chunk, _encoding, callback) { count += chunk.length; digest.update(chunk); callback(count > maxBytes ? new Error(`replication diff exceeds ${maxBytes} compressed bytes`) : null, chunk); } });
  try {
    await pipeline(response.body, limiter, createWriteStream(temporary, { flags: 'wx' }));
    const md5 = digest.digest('hex');
    if (expectedMd5 && md5.toLowerCase() !== expectedMd5.toLowerCase()) throw new Error(`replication diff checksum mismatch for sequence ${sequence}`);
    await fs.rename(temporary, destination);
    return { bytes: count, url, md5 };
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

export async function* openDiffXml(file, { maxUncompressedBytes = 512 * 1024 * 1024, signal } = {}) {
  let count = 0;
  const limiter = new Transform({ transform(chunk, _encoding, callback) { count += chunk.length; callback(count > maxUncompressedBytes ? new Error(`replication diff exceeds ${maxUncompressedBytes} uncompressed bytes`) : null, chunk); } });
  const output = new PassThrough();
  const completed = signal
    ? pipeline((await import('node:fs')).createReadStream(file), createGunzip(), limiter, output, { signal })
    : pipeline((await import('node:fs')).createReadStream(file), createGunzip(), limiter, output);
  try {
    for await (const chunk of output) yield chunk;
    await completed;
  } catch (error) {
    await completed.catch(() => {});
    throw error;
  }
}

export function* sequencesAfter(lastSequence, currentSequence) {
  yield* iterateCatchUpSequences(lastSequence, currentSequence);
}
