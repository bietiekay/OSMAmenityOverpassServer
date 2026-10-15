#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const parseArgs = (argv) => {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    values[key.slice(2)] = value;
  }
  if (!values.url) throw new Error('usage: node scripts/verify-http.mjs --url http://127.0.0.1:8081 [--expected-nodes file.json] [--amenity toilets]');
  return values;
};

const expectedFields = ['type', 'id', 'lat', 'lon', 'tags', 'version', 'timestamp', 'changeset'];
const equivalentNode = (actual, expected) => expectedFields.every((key) =>
  expected[key] === undefined || isDeepStrictEqual(actual[key], expected[key]));

export async function verifyHttp({ url, expectedNodes = [], amenity = 'toilets' }) {
  const base = url.replace(/\/+$/, '');
  const nodes = expectedNodes;
  // Safe bounded default for a smoke probe when no source fixture is supplied.
  let bbox = [35.0, 139.0, 36.0, 140.0];
  if (nodes.length > 0) {
    const lats = nodes.map((node) => node.lat);
    const lons = nodes.map((node) => node.lon);
    bbox = [Math.min(...lats) - 0.001, Math.min(...lons) - 0.001,
      Math.max(...lats) + 0.001, Math.max(...lons) + 0.001];
  }
  const bboxText = bbox.join(',');
  const jsonQuery = `[out:json][timeout:120];node["amenity"="${amenity}"](${bboxText});out body meta;`;
  const xmlQuery = `[out:xml][timeout:120];node["amenity"="${amenity}"](${bboxText});out body meta;`;
  const getResponse = await fetch(`${base}/api/interpreter?${new URLSearchParams({ data: jsonQuery })}`);
  assert.equal(getResponse.status, 200, 'GET interpreter query must succeed');
  assert.match(getResponse.headers.get('content-type') ?? '', /application\/json/);
  const getBody = await getResponse.json();
  assert.equal(getBody.version, 0.6);
  assert.ok(Array.isArray(getBody.elements));
  const etag = getResponse.headers.get('etag');
  assert.ok(etag, 'JSON response must have an ETag');

  const postResponse = await fetch(`${base}/api/interpreter`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: jsonQuery })
  });
  assert.equal(postResponse.status, 200, 'POST interpreter query must succeed');
  assert.equal(postResponse.headers.get('etag'), etag, 'identical GET/POST queries must have stable ETags');
  assert.deepEqual(await postResponse.json(), getBody);

  for (const expected of nodes) {
    const found = getBody.elements.find((element) => element.type === 'node' && element.id === expected.id);
    assert.ok(found, `expected node ${expected.id} is missing`);
    assert.ok(equivalentNode(found, expected), `node ${expected.id} differs from expected source record`);
  }

  const xmlResponse = await fetch(`${base}/api/interpreter`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: xmlQuery })
  });
  assert.equal(xmlResponse.status, 200, 'XML interpreter query must succeed');
  assert.match(xmlResponse.headers.get('content-type') ?? '', /text\/xml/);
  assert.match(await xmlResponse.text(), /<osm version="0\.6"/);

  for (const endpoint of ['/', '/api/status', '/api/interpreter']) {
    const response = await fetch(`${base}${endpoint}`, { method: 'HEAD' });
    assert.ok(response.status >= 200 && response.status < 300, `HEAD ${endpoint} must be successful`);
  }
  const status = await fetch(`${base}/api/status`);
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(typeof statusBody.osm_osm_change, 'string');
  assert.ok(statusBody.localEngine);

  const bad = await fetch(`${base}/api/interpreter`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'data='
  });
  assert.equal(bad.status, 400, 'blank query must return 400');
  const outOfScope = await fetch(`${base}/api/interpreter`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: `node["highway"="residential"](${bboxText});out;` })
  });
  assert.equal(outOfScope.status, 501, 'unsupported query must return 501');
  const kill = await fetch(`${base}/api/kill_my_queries`, { method: 'POST' });
  assert.equal(kill.status, 200);

  return { elements: getBody.elements.length, expectedNodes: nodes.length, etag };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const expectedNodes = args['expected-nodes']
      ? JSON.parse(await readFile(args['expected-nodes'], 'utf8')) : [];
    const result = await verifyHttp({ url: args.url, expectedNodes, amenity: args.amenity ?? 'toilets' });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
