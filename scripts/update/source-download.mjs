import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch as undiciFetch } from 'undici';

const DEFAULT_PBF_URL = 'https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf';

function httpsUrl(value, label) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return parsed.href;
}

async function hashExisting(file, hash, signal) {
  let bytes = 0;
  for await (const chunk of createReadStream(file, { signal })) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return bytes;
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Download a checksummed current planet into a new immutable pipeline source file. */
export async function downloadCurrentPlanet(pipelineDir, {
  url = DEFAULT_PBF_URL, checksumUrl = `${url}.md5`, signal,
  fetchImpl = undiciFetch, onLog = () => {}
} = {}) {
  const sourceUrl = httpsUrl(url, 'planet PBF URL');
  const md5Url = httpsUrl(checksumUrl, 'planet checksum URL');
  const checksumResponse = await fetchImpl(md5Url, { signal });
  if (!checksumResponse.ok) throw new Error(`planet checksum download failed: HTTP ${checksumResponse.status}`);
  if (checksumResponse.url) httpsUrl(checksumResponse.url, 'planet checksum response URL');
  if (!checksumResponse.body) throw new Error('planet checksum download returned no body');
  let checksumText = '';
  for await (const chunk of Readable.fromWeb(checksumResponse.body)) {
    checksumText += chunk.toString('utf8');
    if (checksumText.length > 4096) throw new Error('planet checksum response is too large');
  }
  const match = /^\s*([a-f0-9]{32})(?:\s|$)/i.exec(checksumText);
  if (!match) throw new Error('planet checksum response has no MD5 digest');
  const expected = match[1].toLowerCase();
  const directory = path.join(pipelineDir, 'source-snapshots');
  const final = path.join(directory, `planet-${expected}.osm.pbf`);
  const partial = `${final}.part`;
  await fs.mkdir(directory, { recursive: true });

  const existingFinal = await fs.stat(final).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existingFinal) {
    const actual = createHash('md5');
    await hashExisting(final, actual, signal);
    if (actual.digest('hex') !== expected) throw new Error(`retained planet PBF checksum mismatch: ${final}`);
    onLog(`re-extract source: reusing verified ${final}`);
    return final;
  }

  const md5 = createHash('md5');
  let offset = await fs.stat(partial).then((stat) => stat.size, (error) => error.code === 'ENOENT' ? 0 : Promise.reject(error));
  if (!offset) await fs.rm(partial, { force: true });
  if (offset) {
    onLog(`re-extract source: verifying ${offset} already downloaded bytes`);
    await hashExisting(partial, md5, signal);
    if (md5.copy().digest('hex') === expected) {
      const handle = await fs.open(partial, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      await fs.chmod(partial, 0o444);
      await fs.rename(partial, final);
      await syncDirectory(directory);
      onLog(`re-extract source: verified current planet PBF ${final}`);
      return final;
    }
  }
  const headers = offset ? { range: `bytes=${offset}-`, 'accept-encoding': 'identity' } : { 'accept-encoding': 'identity' };
  const response = await fetchImpl(sourceUrl, { headers, signal });
  if (response.url) httpsUrl(response.url, 'planet PBF response URL');
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('planet server returned a transfer-encoded PBF; byte-range resume is unsafe');
  if (offset && response.status !== 206) throw new Error('planet server did not honor the partial download range; remove the .part file to restart safely');
  if (!offset && !response.ok) throw new Error(`planet PBF download failed: HTTP ${response.status}`);
  if (offset && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) {
    throw new Error('planet server returned the wrong partial download range');
  }
  if (!response.body) throw new Error('planet PBF download returned no body');
  onLog(`re-extract source: downloading current planet to ${final}${offset ? ` (resuming at ${offset} bytes)` : ''}`);
  let lastLog = Date.now();
  const digest = new Transform({ transform(chunk, _encoding, callback) {
    md5.update(chunk);
    offset += chunk.length;
    if (Date.now() - lastLog >= 30000) {
      onLog(`re-extract source: ${Math.round(offset / (1024 * 1024))} MiB downloaded`);
      lastLog = Date.now();
    }
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), digest, createWriteStream(partial, { flags: headers.range ? 'a' : 'wx' }), { signal });
  if (md5.digest('hex') !== expected) {
    await fs.rm(partial, { force: true });
    throw new Error('current planet PBF checksum did not match; source may have rotated during download');
  }
  const handle = await fs.open(partial, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await fs.chmod(partial, 0o444);
  await fs.rename(partial, final);
  await syncDirectory(directory);
  onLog(`re-extract source: verified current planet PBF ${final}`);
  return final;
}
