#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])])
  );
  return value;
}

/** Compare element semantics; response generator/runtime fields are diagnostic. */
export function compareResponses(local, reference) {
  const index = (body) => {
    if (!Array.isArray(body?.elements)) throw new Error('response has no elements array');
    const values = new Map();
    for (const element of body.elements) {
      if (!['node', 'way', 'relation'].includes(element.type) || !Number.isSafeInteger(element.id)) {
        throw new Error('response contains an invalid typed object ID');
      }
      const key = `${element.type}:${element.id}`;
      if (values.has(key)) throw new Error(`response contains duplicate ${key}`);
      values.set(key, canonical(element));
    }
    return values;
  };
  const actual = index(local), expected = index(reference);
  const missing = [], extra = [], changed = [];
  for (const [key, value] of expected) {
    if (!actual.has(key)) missing.push(key);
    else if (!isDeepStrictEqual(actual.get(key), value)) changed.push(key);
  }
  for (const key of actual.keys()) if (!expected.has(key)) extra.push(key);
  return {
    ok: missing.length === 0 && extra.length === 0 && changed.length === 0,
    localElements: actual.size, referenceElements: expected.size,
    localTimestamp: local.osm3s?.timestamp_osm_base ?? null,
    referenceTimestamp: reference.osm3s?.timestamp_osm_base ?? null,
    missing: missing.sort(), extra: extra.sort(), changed: changed.sort()
  };
}

async function request(endpoint, query, fetchImpl) {
  const response = await fetchImpl(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`);
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024 * 1024) throw new Error('parity response exceeds 64 MiB; use a smaller query');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) { throw new Error(`cannot read ${endpoint}: ${error.message}`, { cause: error }); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function runParity({ localUrl, referenceUrl, query, fetchImpl = fetch }) {
  if (!query?.trim() || Buffer.byteLength(query) > 1024 * 1024) throw new Error('provide a nonempty query of at most 1 MiB');
  for (const endpoint of [localUrl, referenceUrl]) {
    if (!['http:', 'https:'].includes(new URL(endpoint).protocol)) throw new Error('endpoints must use HTTP or HTTPS');
  }
  const [local, reference] = await Promise.all([
    request(localUrl, query, fetchImpl), request(referenceUrl, query, fetchImpl)
  ]);
  return compareResponses(local, reference);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i]; const value = process.argv[i + 1];
      if (!['--local-url', '--reference-url', '--query-file'].includes(key) || !value) {
        throw new Error('usage: npm run parity -- --local-url URL/api/interpreter --reference-url URL/api/interpreter --query-file query.ql');
      }
      options[key.slice(2)] = value;
    }
    const query = await readFile(options['query-file'], 'utf8');
    const result = await runParity({ localUrl: options['local-url'], referenceUrl: options['reference-url'], query });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
