import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { coalesceDiffFiles } from './coalesce-diffs.mjs';
import { prepareCoalescedImport, importCoalescedPartitions } from './import-coalesced.mjs';
import { DeltaObjectStore } from './delta-store.mjs';
import { resolveCurrentObjects } from './object-resolver.mjs';
import { withGenerationTransaction, atomicWrite } from './generation.mjs';
import { buildSourceBlockIndex, openSourceBlockIndex, buildTrackedIndexes } from '../extract/source-index.mjs';
import { appendPartitionedMultiIndex, openPartitionedMultiIndex } from '../extract/storage.mjs';
import { readShard, writeShard, buildConfigHash } from '../../dist/index/shard.js';
import { cellsIntersectingBbox, pointToCell } from '../../dist/index/geohash.js';

const ID = (type, id) => `${type}:${id}`;
const REF_BATCH = 400;
const MAX_AFFECTED = 50000;
const MAX_CELLS = 5000;
const MAX_REBUILD_BYTES = 64 * 1024 * 1024;
const MAX_RESOLVED_BYTES = 64 * 1024 * 1024;
const checkAborted = (signal) => { if (signal?.aborted) throw signal.reason ?? new Error('update aborted'); };
const readUpdateWorkers = (value) => {
  const count = Number(value ?? process.env.OSM_AMENITY_UPDATE_WORKERS ?? 1);
  if (!Number.isSafeInteger(count) || count < 1 || count > 16) throw new Error('OSM_AMENITY_UPDATE_WORKERS must be an integer from 1 to 16');
  return count;
};

/** Finish every task in a wave before returning an error, so shared readers stay open. */
async function settledWave(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((item) => item.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((item) => item.value);
}

async function sortUniqueFile(input, output) {
  await new Promise((resolve, reject) => {
    const child = spawn('sort', ['-u', '-S', '32M', input, '-o', output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`sort unique object keys failed (${code}): ${stderr}`)));
  });
}

async function countLines(file) {
  let count = 0;
  const lines = (await import('node:readline')).createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const _line of lines) count += 1;
  return count;
}

/** Recompute exact global unique-object and shard-record counts with external sort. */
async function recountManifest(generation, manifest, amenities, onProgress = () => {}) {
  const temp = path.join(generation, `.counts-${process.pid}-${Date.now()}`);
  await fs.mkdir(temp, { recursive: true });
  const mainRaw = path.join(temp, 'main.raw'); const supportRaw = path.join(temp, 'support.raw');
  const mainOut = path.join(temp, 'main.sorted'); const supportOut = path.join(temp, 'support.sorted');
  const mainStream = createWriteStream(mainRaw, { flags: 'wx' }); const supportStream = createWriteStream(supportRaw, { flags: 'wx' });
  let shardRecords = 0;
  const write = async (stream, value) => { if (!stream.write(`${value}\n`)) await new Promise((resolve, reject) => { stream.once('drain', resolve); stream.once('error', reject); }); };
  try {
    let completed = 0;
    onProgress({ phase: 'recounting output shards', completed, total: manifest.shards.length, unit: 'shards' });
    for (const cellValue of manifest.shards) {
      const cell = String(cellValue).replace(/\.bin$/, '');
      const bytes = await fs.readFile(path.join(generation, 'shards', `${cell}.bin`));
      if (bytes.length > 256 * 1024 * 1024) throw new Error(`shard ${cell} exceeds 256 MiB update budget; increase shard precision`);
      const shard = readShard(bytes); shardRecords += shard.elements.length;
      for (const element of shard.elements) {
        const line = `${element.type}:${element.id}`;
        await write(element.tags?.amenity && amenities.includes(element.tags.amenity) ? mainStream : supportStream, line);
      }
      completed += 1;
      onProgress({ phase: 'recounting output shards', completed, total: manifest.shards.length, unit: 'shards' });
    }
  } finally {
    mainStream.end(); supportStream.end();
    await Promise.all([finished(mainStream), finished(supportStream)]);
  }
  try {
    onProgress({ phase: 'sorting manifest object counts', completed: 0, total: 2, unit: 'sorts' });
    await sortUniqueFile(mainRaw, mainOut);
    onProgress({ phase: 'sorting manifest object counts', completed: 1, total: 2, unit: 'sorts', detail: 'main amenity objects sorted' });
    await sortUniqueFile(supportRaw, supportOut);
    onProgress({ phase: 'sorting manifest object counts', completed: 2, total: 2, unit: 'sorts', detail: 'support objects sorted' });
    const mainUnique = await countLines(mainOut); const supportObjects = await countLines(supportOut);
    manifest.totalElements = mainUnique;
    manifest.counts = { ...(manifest.counts ?? {}), mainUnique, supportObjects, shardRecords, duplicatedRecords: shardRecords - mainUnique - supportObjects };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

async function resolveMany(store, source, requests, onProgress = () => {}, progressPhase = 'resolving objects from baseline PBF', workers = 1) {
  const resolved = new Map();
  let totalBytes = 0;
  const resolveBounded = async (part) => {
    try {
      return await resolveCurrentObjects(store, source, part, { maxRequests: REF_BATCH, maxCandidateBytes: 64 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, validateOverlays: true });
    } catch (error) {
      if (!/source candidate blocks require .* request a smaller lookup batch/.test(error.message) || part.length <= 1) throw error;
      const middle = Math.floor(part.length / 2);
      const first = await resolveBounded(part.slice(0, middle));
      const second = await resolveBounded(part.slice(middle));
      for (const [key, value] of second.objects) first.objects.set(key, value);
      return first;
    }
  };
  onProgress({ phase: progressPhase, completed: 0, total: requests.length, unit: 'objects' });
  for (let i = 0; i < requests.length; i += REF_BATCH * workers) {
    const parts = [];
    for (let j = i; j < Math.min(i + REF_BATCH * workers, requests.length); j += REF_BATCH) parts.push(requests.slice(j, j + REF_BATCH));
    const results = await settledWave(parts.map(resolveBounded));
    for (const result of results) {
      for (const [key, value] of result.objects) {
        if (!resolved.has(key)) {
          totalBytes += Buffer.byteLength(JSON.stringify(value));
          if (totalBytes > MAX_RESOLVED_BYTES) throw new Error(`resolved object cache exceeds ${MAX_RESOLVED_BYTES} bytes; reduce the update batch`);
          resolved.set(key, value);
        }
      }
    }
    onProgress({ phase: progressPhase, completed: Math.min(i + REF_BATCH * workers, requests.length), total: requests.length, unit: 'objects', detail: `${resolved.size.toLocaleString('en-US')} objects resolved with ${workers} workers` });
  }
  return resolved;
}

const shardElement = (raw) => ({
  type: raw.type, id: raw.id, version: raw.version ?? 0, timestamp: raw.timestamp ?? 0,
  changeset: raw.changeset ?? 0, lat: raw.type === 'node' ? raw.lat : 0, lon: raw.type === 'node' ? raw.lon : 0,
  bbox: raw.type === 'node' ? [raw.lat, raw.lon, raw.lat, raw.lon] : [0, 0, 0, 0],
  tags: raw.tags ?? {}, nodeIds: raw.nodeIds ?? [], memberCoords: new Map(), members: raw.members ?? []
});

function mergeCellElement(map, element) {
  const key = ID(element.type, element.id); const existing = map.get(key);
  if (!existing) { map.set(key, element); return; }
  for (const [id, point] of element.memberCoords) existing.memberCoords.set(id, point);
  if ((element.tags?.amenity && !existing.tags?.amenity) || element.version > existing.version) {
    const coords = existing.memberCoords; Object.assign(existing, element); existing.memberCoords = coords;
  }
}

async function affectedClosure(changes, reverseParents, onProgress = () => {}) {
  const seen = new Set(changes.map((o) => ID(o.type, o.id))); const queue = [...seen];
  let visited = 0;
  onProgress({ phase: 'finding affected objects and parent dependencies', completed: 0, total: null, unit: 'objects' });
  while (queue.length) {
    const current = queue.pop();
    for (const parent of await reverseParents.get(current)) {
      if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
      if (seen.size > MAX_AFFECTED) throw new Error(`update dependency closure exceeds ${MAX_AFFECTED} OSM objects; split the update batch`);
    }
    visited += 1;
    if (visited % 1000 === 0) onProgress({ phase: 'finding affected objects and parent dependencies', completed: visited, total: null, unit: 'objects', detail: `${seen.size.toLocaleString('en-US')} objects in dependency closure` });
  }
  onProgress({ phase: 'finding affected objects and parent dependencies', completed: visited, total: null, unit: 'objects', detail: `${seen.size.toLocaleString('en-US')} objects in dependency closure` });
  return seen;
}

async function buildMainGeometry(raw, store, source, elementCache, signal, onProgress) {
  const resolve = async (type, id) => {
    const key = ID(type, id); if (elementCache.has(key)) return elementCache.get(key);
    const found = await resolveMany(store, source, [{ type, id }], onProgress); const value = found.get(key) ?? null; elementCache.set(key, value); return value;
  };
  const requireObject = async (type, id, parent) => {
    const value = await resolve(type, id);
    if (!value) throw new Error(`missing update reference ${type}:${id} required by ${parent}`);
    return value;
  };
  const main = shardElement(raw); let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  const helpers = new Map(); const addPoint = (node) => {
    south = Math.min(south, node.lat); north = Math.max(north, node.lat); west = Math.min(west, node.lon); east = Math.max(east, node.lon);
  };
  const addWay = async (wayRaw, parent) => {
    const way = shardElement(wayRaw);
    const nodes = await resolveMany(store, source, way.nodeIds.map((id) => ({ type: 'node', id })), onProgress);
    for (const id of way.nodeIds) {
      checkAborted(signal);
      const node = nodes.get(ID('node', id)) ?? await requireObject('node', id, parent);
      elementCache.set(ID('node', id), node);
      way.memberCoords.set(id, { lat: node.lat, lon: node.lon }); addPoint(node);
    }
    helpers.set(ID('way', way.id), way);
    return way;
  };
  const visitRelation = async (relationRaw, depth, visiting) => {
    if (depth > 16) throw new Error(`relation recursion exceeds depth 16 at relation:${relationRaw.id}`);
    const key = ID('relation', relationRaw.id); if (visiting.has(key)) return;
    visiting.add(key); const relation = shardElement(relationRaw); helpers.set(key, relation);
    const directNodeMembers = relation.members.filter((member) => member.type === 'node');
    const directNodes = await resolveMany(store, source, directNodeMembers.map((member) => ({ type: 'node', id: member.ref })));
    for (const member of relation.members) {
      if (member.type === 'node') {
        checkAborted(signal);
        const node = directNodes.get(ID('node', member.ref)) ?? await requireObject('node', member.ref, `relation:${relation.id}`); addPoint(node);
        elementCache.set(ID('node', node.id), node);
        helpers.set(ID('node', node.id), shardElement(node));
      } else if (member.type === 'way') {
        await addWay(await requireObject('way', member.ref, `relation:${relation.id}`), `way:${member.ref}`);
      } else if (member.type === 'relation') {
        const child = await requireObject('relation', member.ref, `relation:${relation.id}`);
        await visitRelation(child, depth + 1, visiting);
      }
    }
    visiting.delete(key);
  };

  if (raw.type === 'node') addPoint(raw);
  else if (raw.type === 'way') await addWay(raw, `way:${raw.id}`);
  else await visitRelation(raw, 0, new Set());
  if (!Number.isFinite(south)) throw new Error(`cannot locate ${raw.type}:${raw.id} without member coordinates`);
  main.bbox = [south, west, north, east];
  if (raw.type === 'way') main.memberCoords = helpers.get(ID('way', raw.id)).memberCoords;
  return { main, helpers: [...helpers.values()], cells: raw.type === 'node'
    ? [pointToCell(raw.lat, raw.lon, Number(elementCache.precision))]
    : cellsIntersectingBbox(south, west, north, east, Number(elementCache.precision)) };
}

async function applyAcceptedChanges(generation, changes, store, source, indexes, amenities, precision, buildSequence, signal, workers, onProgress = () => {}) {
  checkAborted(signal);
  if (!changes.length) return [];
  const affected = await affectedClosure(changes, indexes.reverseParents, onProgress);
  const oldCells = new Set();
  let checkedObjects = 0;
  for (const key of affected) {
    for (const cell of await indexes.objectCells.get(key)) oldCells.add(cell.replace(/\.bin$/, ''));
    checkedObjects += 1;
    if (checkedObjects % 1000 === 0) onProgress({ phase: 'finding affected shards', completed: checkedObjects, total: affected.size, unit: 'objects', detail: `${oldCells.size.toLocaleString('en-US')} shards found` });
  }
  onProgress({ phase: 'finding affected shards', completed: checkedObjects, total: affected.size, unit: 'objects', detail: `${oldCells.size.toLocaleString('en-US')} shards found` });
  if (oldCells.size > MAX_CELLS) throw new Error(`update touches more than ${MAX_CELLS} old cells; split the update batch`);

  const oldMainIds = new Set();
  const oldSupportIds = new Set(); let oldRecordCount = 0;
  const readCell = async (cell) => {
    const file = path.join(generation, 'shards', `${cell}.bin`);
    const bytes = await fs.readFile(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!bytes) return [];
    if (bytes.length > 256 * 1024 * 1024) throw new Error(`shard ${cell} exceeds 256 MiB update budget; increase shard precision`);
    return readShard(bytes).elements;
  };
  let scannedOldCells = 0;
  onProgress({ phase: 'reading existing affected shards', completed: 0, total: oldCells.size, unit: 'shards' });
  for (const cell of oldCells) {
    const elements = await readCell(cell);
    oldRecordCount += elements.length;
    for (const element of elements) if (affected.has(ID(element.type, element.id))) {
      if (amenities.includes(element.tags.amenity)) oldMainIds.add(ID(element.type, element.id));
      else oldSupportIds.add(ID(element.type, element.id));
    }
    scannedOldCells += 1;
    onProgress({ phase: 'reading existing affected shards', completed: scannedOldCells, total: oldCells.size, unit: 'shards' });
  }
  const changedIds = changes.map((o) => ({ type: o.type, id: o.id }));
  onProgress({ phase: 'resolving changed objects against baseline PBF', completed: 0, total: changedIds.length, unit: 'objects' });
  const changedCurrent = await resolveMany(store, source, changedIds, onProgress, 'resolving changed objects against baseline PBF', workers);
  const mainIds = new Set(oldMainIds);
  for (const change of changes) {
    const raw = changedCurrent.get(ID(change.type, change.id));
    if (raw?.tags?.amenity && amenities.includes(raw.tags.amenity)) mainIds.add(ID(raw.type, raw.id));
  }
  const mainRequests = [...mainIds].map((key) => { const [type, id] = key.split(':'); return { type, id: Number(id) }; });
  const currentMains = await resolveMany(store, source, mainRequests, onProgress, 'resolving affected amenities against baseline PBF', workers);
  const newRows = new Map(); let buildBytes = 0;
  const estimatedBytes = (element) => Buffer.byteLength(JSON.stringify({ ...element, memberCoords: [...element.memberCoords] }));
  const addToCell = (cell, element) => {
    let rows = newRows.get(cell); if (!rows) { rows = new Map(); newRows.set(cell, rows); }
    const key = ID(element.type, element.id); const existing = rows.get(key);
    if (!existing) {
      const bytes = estimatedBytes(element);
      if (buildBytes + bytes > MAX_REBUILD_BYTES) throw new Error(`affected shard rebuild exceeds ${MAX_REBUILD_BYTES} estimated bytes; split the update batch`);
      buildBytes += bytes; rows.set(key, element); return;
    }
    const before = estimatedBytes(existing); mergeCellElement(rows, element);
    const after = estimatedBytes(existing); buildBytes += after - before;
    if (buildBytes > MAX_REBUILD_BYTES) throw new Error(`affected shard rebuild exceeds ${MAX_REBUILD_BYTES} estimated bytes; split the update batch`);
  };
  let geometryCompleted = 0;
  onProgress({ phase: 'rebuilding affected amenity geometry', completed: 0, total: mainIds.size, unit: 'amenities' });
  const mainKeys = [...mainIds].sort();
  for (let offset = 0; offset < mainKeys.length; offset += workers) {
    checkAborted(signal);
    const group = mainKeys.slice(offset, offset + workers);
    const locations = await settledWave(group.map(async (key) => {
      const raw = currentMains.get(key);
      if (!raw || !amenities.includes(raw.tags?.amenity)) return null;
      const cache = new Map([[key, raw]]);
      cache.precision = precision;
      return buildMainGeometry(raw, store, source, cache, signal, () => {});
    }));
    for (const located of locations) {
      if (located) for (const cell of located.cells) {
        addToCell(cell, located.main);
        for (const helper of located.helpers) addToCell(cell, helper);
      }
      geometryCompleted += 1;
      onProgress({ phase: 'rebuilding affected amenity geometry', completed: geometryCompleted, total: mainIds.size, unit: 'amenities', detail: `${workers} concurrent geometry tasks` });
    }
  }
  if (newRows.size + oldCells.size > MAX_CELLS) throw new Error(`update touches more than ${MAX_CELLS} total cells; split the update batch`);

  const touched = new Set([...oldCells, ...newRows.keys()]);
  for (const cell of newRows.keys()) if (!oldCells.has(cell)) oldRecordCount += (await readCell(cell)).length;
  const configHash = Buffer.from(JSON.parse(await fs.readFile(path.join(generation, 'manifest.json'), 'utf8')).configHash, 'hex');
  let newRecordCount = 0;
  let rebuiltCells = 0;
  onProgress({ phase: 'writing affected shards', completed: 0, total: touched.size, unit: 'shards' });
  for (const cell of touched) {
    const elements = new Map();
    for (const element of await readCell(cell)) if (!affected.has(ID(element.type, element.id))) elements.set(ID(element.type, element.id), element);
    for (const [key, element] of newRows.get(cell) ?? []) mergeCellElement(elements, element);
    // A deleted or moved parent may leave old support objects behind. Recompute
    // the cell's helper closure from its surviving main objects, retaining any
    // helper still shared by another main object in this same cell.
    const needed = new Set(); const queue = [];
    for (const element of elements.values()) if (element.tags?.amenity && amenities.includes(element.tags.amenity)) {
      const key = ID(element.type, element.id); needed.add(key); queue.push(element);
    }
    while (queue.length) {
      const parent = queue.pop();
      const references = parent.type === 'way'
        ? parent.nodeIds.map((id) => ({ type: 'node', ref: id }))
        : parent.type === 'relation' ? parent.members : [];
      for (const reference of references) {
        const key = ID(reference.type, reference.ref); const child = elements.get(key);
        if (child && !needed.has(key)) { needed.add(key); queue.push(child); }
      }
    }
    for (const key of elements.keys()) if (!needed.has(key)) elements.delete(key);
    const file = path.join(generation, 'shards', `${cell}.bin`);
    if (!elements.size) {
      await fs.rm(file, { force: true });
      rebuiltCells += 1;
      onProgress({ phase: 'writing affected shards', completed: rebuiltCells, total: touched.size, unit: 'shards' });
      continue;
    }
    newRecordCount += elements.size;
    const output = writeShard(cell, [...elements.values()], buildSequence, configHash);
    if (output.length > 256 * 1024 * 1024) throw new Error(`updated shard ${cell} exceeds 256 MiB; increase shard precision`);
    await atomicWrite(file, output);
    readShard(output);
    rebuiltCells += 1;
    onProgress({ phase: 'writing affected shards', completed: rebuiltCells, total: touched.size, unit: 'shards' });
  }

  // Append only new edges. Old edges remain as a safe over-approximation; this
  // can trigger extra work but never misses a newly introduced dependency.
  onProgress({ phase: 'updating dependency indexes', completed: 0, total: null, unit: 'steps' });
  const cellRows = []; const parentRows = [];
  for (const [cell, rows] of newRows) for (const element of rows.values()) {
    cellRows.push({ key: ID(element.type, element.id), value: cell });
    const parent = ID(element.type, element.id);
    if (element.type === 'way') for (const id of element.nodeIds) parentRows.push({ key: ID('node', id), value: parent });
    if (element.type === 'relation') for (const member of element.members) parentRows.push({ key: ID(member.type, member.ref), value: parent });
  }
  await appendPartitionedMultiIndex(indexes.dir + '/object-cells', indexes.partitions, cellRows);
  await appendPartitionedMultiIndex(indexes.dir + '/reverse-parents', indexes.partitions, parentRows);
  indexes.objectCells.close(); indexes.reverseParents.close();
  indexes.objectCells = openPartitionedMultiIndex(path.join(indexes.dir, 'object-cells'), indexes.partitions);
  indexes.reverseParents = openPartitionedMultiIndex(path.join(indexes.dir, 'reverse-parents'), indexes.partitions);
  const newMainIds = new Set();
  const newSupportIds = new Set();
  for (const rows of newRows.values()) for (const element of rows.values()) if (element.tags?.amenity && amenities.includes(element.tags.amenity)) newMainIds.add(ID(element.type, element.id));
  for (const rows of newRows.values()) for (const element of rows.values()) if (!(element.tags?.amenity && amenities.includes(element.tags.amenity))) newSupportIds.add(ID(element.type, element.id));
  return { cells: [...touched], oldMainCount: oldMainIds.size, newMainCount: newMainIds.size,
    oldSupportCount: oldSupportIds.size, newSupportCount: newSupportIds.size,
    oldRecordCount, newRecordCount };
}

/** Apply one fully downloaded namespace-local diff as an immutable generation. */
export async function applyDiffGeneration(pipelineDir, diffFile, {
  sequence, replication, dataTimestamp = null, amenities = ['toilets'], shardPrecision = 5, engine = null,
  maxBatchBytes = 8 * 1024 * 1024, beforePublish = null,
  sourcePbf: sourcePbfOverride = null, sourcePbfFingerprint = null, diffFiles = null,
  candidateGenerationDir = null, fromSequence = null, signal = null, onProgress = () => {}, updateWorkers = null
}) {
  checkAborted(signal);
  const workers = readUpdateWorkers(updateWorkers);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('valid target sequence is required');
  const inputs = diffFiles ?? [diffFile];
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('at least one replication diff file is required');
  let completedDiffs = 0;
  const reportProgress = (event) => {
    if (Number.isSafeInteger(event.batchCompletedDiffs)) completedDiffs = event.batchCompletedDiffs;
    onProgress({ ...event, batchCompletedDiffs: completedDiffs, batchTotalDiffs: inputs.length });
  };
  reportProgress({ phase: 'configuring update workers', completed: workers, total: workers, unit: 'workers', detail: `${workers} concurrent lookup and geometry tasks` });
  const overridePath = sourcePbfOverride ? path.resolve(sourcePbfOverride) : null;
  let actualOverrideFingerprint = sourcePbfFingerprint;
  if (sourcePbfOverride) {
    if (!actualOverrideFingerprint) {
      const hash = createHash('sha256');
      const stat = await fs.stat(overridePath);
      let readBytes = 0;
      reportProgress({ phase: 'hashing retained source PBF', completed: 0, total: stat.size, unit: 'bytes', detail: path.basename(overridePath) });
      for await (const chunk of createReadStream(overridePath)) {
        hash.update(chunk);
        readBytes += chunk.length;
        reportProgress({ phase: 'hashing retained source PBF', completed: readBytes, total: stat.size, unit: 'bytes', detail: path.basename(overridePath) });
      }
      actualOverrideFingerprint = hash.digest('hex');
    }
  }
  const coalesced = await coalesceDiffFiles(inputs, path.join(pipelineDir, 'work', 'update-diffs'), { signal, onProgress: reportProgress });
  const maxObjectTimestamp = coalesced.maxObjectTimestamp;
  try {
  const affectedCells = new Set();
  const mutateGeneration = async (generation, activeRoot) => {
    const activeState = JSON.parse(await fs.readFile(path.join(activeRoot, 'state.json'), 'utf8'));
    const activeManifest = JSON.parse(await fs.readFile(path.join(activeRoot, 'manifest.json'), 'utf8'));
    if (activeManifest.configHash !== buildConfigHash({ amenities, precision: shardPrecision }).toString('hex')) throw new Error('active generation config does not match updater config');
    if (!activeState.replication || activeState.replication.baseUrl !== replication.baseUrl || activeState.replication.kind !== replication.kind || activeState.replication.interval !== replication.interval) throw new Error('replication source descriptor does not match the active generation baseline');
    const activeSequence = activeState.replication.sequenceNumber;
    if (!Number.isSafeInteger(activeSequence)) throw new Error('active generation has no namespace-local replication sequence; refusing unknown baseline catch-up');
    if (sequence !== activeSequence + inputs.length) throw new Error(`diff sequence batch gap: expected ${activeSequence + inputs.length}, got ${sequence}`);
    if (fromSequence !== null && fromSequence !== activeSequence + 1) throw new Error(`diff batch starts at ${fromSequence}, but generation cursor requires ${activeSequence + 1}`);
    const sourcePbf = overridePath ?? activeState.sourcePbf;
    if (!sourcePbf || !(await fs.stat(sourcePbf).catch(() => null))) throw new Error('active generation has no retained source PBF for baseline lookups');
    if (overridePath && (!activeState.sourceFingerprint || actualOverrideFingerprint !== activeState.sourceFingerprint)) throw new Error('source PBF override fingerprint does not match the active generation');
    const cacheDir = path.join(pipelineDir, 'update-cache', `source-${activeState.sourceFingerprint ?? 'unknown'}`);
    let cachedIndex = null;
    try { cachedIndex = JSON.parse(await fs.readFile(path.join(cacheDir, 'index.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (cachedIndex && activeState.sourceFingerprint && cachedIndex.sourceFingerprint !== activeState.sourceFingerprint) {
      await fs.rm(cacheDir, { recursive: true, force: true });
      cachedIndex = null;
    }
    if (!cachedIndex) {
      reportProgress({ phase: 'building baseline PBF block index', completed: 0, total: null, unit: 'blocks', detail: path.basename(sourcePbf) });
      await buildSourceBlockIndex(sourcePbf, cacheDir, {
        sourceFingerprint: activeState.sourceFingerprint ?? undefined,
        onProgress: reportProgress
      });
    } else reportProgress({ phase: 'checking cached baseline PBF block index', completed: 1, total: 1, unit: 'indexes' });
    const source = await openSourceBlockIndex(cacheDir, { sourcePbf, expectedFingerprint: activeState.sourceFingerprint ?? actualOverrideFingerprint });
    if (activeState.sourceFingerprint && source.metadata.sourceFingerprint !== activeState.sourceFingerprint) {
      await source.close();
      throw new Error('retained source PBF fingerprint does not match the active generation');
    }
    const store = new DeltaObjectStore(generation);
    let indexes = null;
    const indexDir = path.join(generation, 'update-indexes');
    try {
      if (!(await fs.stat(path.join(indexDir, 'tracked-index.json')).catch(() => null))) {
        await buildTrackedIndexes(generation, indexDir, null, reportProgress);
      } else reportProgress({ phase: 'checking cached tracked-object indexes', completed: 1, total: 1, unit: 'indexes' });
      const tracked = JSON.parse(await fs.readFile(path.join(indexDir, 'tracked-index.json'), 'utf8'));
      indexes = { dir: indexDir, partitions: tracked.partitions,
        objectCells: openPartitionedMultiIndex(path.join(indexDir, 'object-cells'), tracked.partitions),
        reverseParents: openPartitionedMultiIndex(path.join(indexDir, 'reverse-parents'), tracked.partitions) };
      let changedCount = 0;
      const changedIds = new Map();
      const prepared = await prepareCoalescedImport(coalesced, indexes, amenities, {
        signal, onProgress: reportProgress, maxObjectBytes: maxBatchBytes, workers
      });
      const relevant = [];
      for (const item of prepared.relevant) {
        checkAborted(signal);
        if (item.version > ((await store.get(item.type, item.id))?.version ?? 0)) relevant.push(item);
      }
      const baselineVersions = new Map();
      reportProgress({ phase: 'checking relevant changes against baseline PBF', completed: 0, total: relevant.length, unit: 'objects' });
      for (let i = 0; i < relevant.length; i += REF_BATCH * workers) {
        checkAborted(signal);
        const parts = [];
        for (let j = i; j < Math.min(i + REF_BATCH * workers, relevant.length); j += REF_BATCH) parts.push(relevant.slice(j, j + REF_BATCH));
        const baselines = await settledWave(parts.map((part) => source.resolveObjects(part.map(({ type, id }) => ({ type, id })), {
          maxRequests: REF_BATCH, maxCandidateBytes: 64 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024
        })));
        for (const baseline of baselines) for (const object of baseline.objects) baselineVersions.set(ID(object.type, object.id), object.version);
        reportProgress({ phase: 'checking relevant changes against baseline PBF', completed: Math.min(i + REF_BATCH * workers, relevant.length), total: relevant.length, unit: 'objects', detail: `${baselineVersions.size.toLocaleString('en-US')} baseline objects resolved with ${workers} workers` });
      }
      for (const item of relevant) {
        if (item.version <= (baselineVersions.get(ID(item.type, item.id)) ?? 0)) continue;
        changedCount += 1;
        changedIds.set(ID(item.type, item.id), { type: item.type, id: item.id, version: item.version, action: item.action });
      }
      if (changedIds.size > MAX_AFFECTED) throw new Error(`diff changes exceed ${MAX_AFFECTED} tracked objects; use a smaller replication interval`);
      await importCoalescedPartitions(store, prepared.file, coalesced.uniqueCount, { workers, signal, onProgress: reportProgress });
      store.close();
      checkAborted(signal);
      if (changedIds.size) {
        const rebuilt = await applyAcceptedChanges(generation, [...changedIds.values()], store, source, indexes, amenities, shardPrecision, sequence, signal, workers, reportProgress);
        for (const cell of rebuilt.cells) affectedCells.add(cell);
      }
      reportProgress({ phase: 'preparing updated manifest', completed: 0, total: null, unit: 'steps', detail: `${affectedCells.size.toLocaleString('en-US')} affected shards` });
      const manifest = JSON.parse(await fs.readFile(path.join(generation, 'manifest.json'), 'utf8'));
      const shardNames = new Set(manifest.shards.map((cell) => cell.replace(/\.bin$/, '')));
      for (const cell of affectedCells) {
        const file = path.join(generation, 'shards', `${cell}.bin`);
        if (await fs.stat(file).catch(() => null)) shardNames.add(cell); else shardNames.delete(cell);
      }
      manifest.shards = [...shardNames].sort(); manifest.shardCount = manifest.shards.length;
      await recountManifest(generation, manifest, amenities, reportProgress);
      manifest.buildSequence = sequence;
      const namespaceSequence = { ...replication, sequenceNumber: sequence };
      const planetMinute = replication.kind === 'planet' && replication.interval === 'minute';
      const timestamp = dataTimestamp ?? (maxObjectTimestamp ? new Date(maxObjectTimestamp * 1000).toISOString() : activeState.dataTimestamp ?? null);
      const state = { ...activeState, lastSeq: planetMinute ? sequence : activeState.lastSeq, lastUpdate: new Date().toISOString(), dataTimestamp: timestamp, replication: namespaceSequence };
      await atomicWrite(path.join(generation, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      checkAborted(signal);
      await atomicWrite(path.join(generation, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
      indexes.objectCells.close(); indexes.reverseParents.close(); store.close(); await source.close();
      return { sequence, changedCount, cells: [...affectedCells] };
    } catch (error) { indexes?.objectCells?.close(); indexes?.reverseParents?.close(); store.close(); await source.close(); throw error; }
  };
  const validateGeneration = async (generation) => {
      checkAborted(signal);
      const manifest = JSON.parse(await fs.readFile(path.join(generation, 'manifest.json'), 'utf8'));
      const state = JSON.parse(await fs.readFile(path.join(generation, 'state.json'), 'utf8'));
      let completed = 0;
      reportProgress({ phase: 'validating output shards', completed, total: manifest.shards.length, unit: 'shards' });
      for (const cellValue of manifest.shards) {
        const cell = cellValue.replace(/\.bin$/, ''); const buffer = await fs.readFile(path.join(generation, 'shards', `${cell}.bin`));
        const shard = readShard(buffer); if (shard.header.configHash !== manifest.configHash) throw new Error(`shard ${cell} config hash mismatch during update validation`);
        completed += 1;
        reportProgress({ phase: 'validating output shards', completed, total: manifest.shards.length, unit: 'shards' });
      }
      if (state.replication?.sequenceNumber !== sequence || (state.replication.kind === 'planet' && state.replication.interval === 'minute' && state.lastSeq !== sequence)) throw new Error('generation cursor did not reach the target namespace sequence');
  };
  let result;
  if (candidateGenerationDir) {
    result = await mutateGeneration(candidateGenerationDir, candidateGenerationDir);
    await validateGeneration(candidateGenerationDir);
  } else ({ result } = await withGenerationTransaction(pipelineDir, mutateGeneration, {
    validate: validateGeneration,
    beforeActivate: beforePublish,
    afterActivate: async (_generation, value) => { if (engine && value?.cells?.length) engine.invalidateCells(value.cells); },
    onProgress: reportProgress
  }));
  return result;
  } finally {
    await coalesced.cleanup();
  }
}

/** Apply a contiguous batch to the active generation or an inactive candidate. */
export async function applyDiffBatchGeneration(pipelineDir, diffFiles, {
  fromSequence, toSequence, ...options
}) {
  if (!Array.isArray(diffFiles) || diffFiles.length === 0) throw new Error('diffFiles must contain at least one ordered diff');
  if (!Number.isSafeInteger(fromSequence) || !Number.isSafeInteger(toSequence) || toSequence - fromSequence + 1 !== diffFiles.length) {
    throw new Error('diff batch sequence range does not match its ordered file list');
  }
  return applyDiffGeneration(pipelineDir, diffFiles[0], {
    ...options, fromSequence, sequence: toSequence, diffFiles
  });
}
