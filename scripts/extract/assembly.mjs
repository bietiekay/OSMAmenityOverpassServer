import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createPartitionedLookup, readLines, countUniqueRecords, partitionCountForBytes } from './storage.mjs';
import { pointToCell, cellsIntersectingBbox } from '../../dist/index/geohash.js';
import { buildConfigHash, writeShard, readShard } from '../../dist/index/shard.js';
import { withGenerationLock, activateGeneration } from '../update/generation.mjs';

const filesIn = async (dir, re) => {
  try { return (await fs.readdir(dir)).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};
const mkElement = (o) => ({
  type: o.type, id: o.id, version: o.version || 0, timestamp: o.timestamp || 0,
  changeset: o.changeset || 0, lat: o.lat || 0, lon: o.lon || 0,
  bbox: o.type === 'node' ? [o.lat, o.lon, o.lat, o.lon] : [0, 0, 0, 0],
  tags: o.tags || {}, nodeIds: o.nodeIds || [], memberCoords: new Map(), members: o.members || []
});
const keyOf = (o) => `${o.type}:${o.id}`;

/** Build a complete immutable index generation, then atomically switch data/. */
export async function buildIndex(options) {
  const { pipelineDir, source, amenities = ['toilets'], shardPrecision = 5, ramMB = 8192 } = options;
  const publish = options.publish !== false;
  if (!pipelineDir) throw new Error('buildIndex requires pipelineDir');
  const work = path.join(pipelineDir, 'work');
  const expectedChunkIds = options.expectedChunkIds;
  const selectFiles = async (dir, prefix, pattern) => {
    if (expectedChunkIds) {
      const files = expectedChunkIds.map((id) => path.join(dir, `${prefix}_${id}.lines`));
      for (const file of files) await fs.access(file).catch(() => { throw new Error(`Stage 4 missing expected input ${file}`); });
      return files.sort();
    }
    return filesIn(dir, pattern);
  };
  const input = {
    amenities: await selectFiles(path.join(work, 'stage1'), 'amen', /^amen_c\d+\.lines$/),
    ways: await selectFiles(path.join(work, 'stage2'), 'ways', /^ways_c\d+\.lines$/),
    nodes: await selectFiles(path.join(work, 'stage3'), 'nodes', /^nodes_c\d+\.lines$/)
  };
  if (!input.amenities.length) throw new Error('Stage 4 requires amen_c*.lines inputs');
  const { decodeElement } = await import('./lines.mjs');
  const sourcePbf = source ? path.resolve(source) : null;
  const fingerprint = await indexFingerprint(input, { source: sourcePbf, sourceFingerprint: options.sourceFingerprint ?? null, amenities, shardPrecision });
  const configHash = buildConfigHash({ amenities, precision: shardPrecision });
  // Identical, fully validated active generations are safe to reuse. Never
  // resume by writing into an active generation; an incomplete match is rebuilt
  // into a unique staging directory below.
  let activeManifest = null; let activeState = null; let activeRoot = null;
  try {
    activeRoot = await fs.realpath(path.join(pipelineDir, 'data'));
    activeManifest = JSON.parse(await fs.readFile(path.join(activeRoot, 'manifest.json'), 'utf8'));
    activeState = JSON.parse(await fs.readFile(path.join(activeRoot, 'state.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (activeRoot && (!activeManifest || !activeState)) throw new Error('active generation metadata is incomplete; refusing to replace it');
  if (publish && activeManifest && activeState) {
    if (activeManifest.buildFingerprint === fingerprint && activeManifest.configHash === configHash.toString('hex')) {
      for (const cell of activeManifest.shards) {
        const bytes = await fs.readFile(path.join(activeRoot, 'shards', `${cell}.bin`));
        if (readShard(bytes).header.configHash !== configHash.toString('hex')) throw new Error(`invalid active shard ${cell}`);
      }
      return activeManifest;
    }
  }
  const tempRoot = path.join(pipelineDir, 'work', `stage4-${randomUUID()}`);
  await fs.mkdir(tempRoot, { recursive: true });
  // Generations are immutable once published. A content fingerprint is useful
  // provenance, but cannot itself be the mutable staging directory name: a
  // retry of the same input may otherwise overwrite the generation serving
  // live queries. Keep every build isolated, including identical rebuilds.
  const generationId = `build-${fingerprint}-${randomUUID()}`;
  const generations = path.join(pipelineDir, 'data-generations');
  const generation = path.join(generations, generationId);
  await fs.mkdir(path.join(generation, 'shards'), { recursive: true });
  const nodeRecords = async function* () {
    for await (const line of readLines(input.nodes)) {
      const o = decodeElement(line);
      if (o.type === 'node') yield { key: o.id, value: o };
    }
  };
  const lookupBudget = Math.max(32, Math.min(512, Math.floor(ramMB * 0.1))) * 1024 * 1024;
  const nodeBytes = await totalFileBytes(input.nodes);
  const nodes = await createPartitionedLookup(generation, 'objects/nodes', nodeRecords(), { partitions: partitionCountForBytes(nodeBytes * 2), maxCacheBytes: lookupBudget, maxPartitionBytes: 4 * 1024 * 1024 });
  const wayRecords = async function* () {
    for await (const line of readLines(input.ways)) {
      const o = decodeElement(line);
      if (o.type === 'way') yield { key: o.id, value: o };
    }
  };
  const wayBytes = await totalFileBytes(input.ways);
  const ways = await createPartitionedLookup(generation, 'objects/ways', wayRecords(), { partitions: partitionCountForBytes(wayBytes * 2), maxCacheBytes: lookupBudget, maxPartitionBytes: 4 * 1024 * 1024 });
  const spoolDir = path.join(tempRoot, 'cells');
  await fs.mkdir(spoolDir, { recursive: true });
  const open = new Map();
  const writeCell = async (cell, element, kind = 'main') => {
    const file = path.join(spoolDir, `${cell}.jsonl`);
    let h = open.get(file);
    if (!h) {
      if (open.size >= 64) { const [old, oh] = open.entries().next().value; await oh.close(); open.delete(old); }
      h = await fs.open(file, 'a'); open.set(file, h);
    }
    await h.write(`${JSON.stringify({ kind, element: { ...element, memberCoords: [...element.memberCoords] } })}\n`);
  };
  let missingCount = 0;
  let firstMissing = null;
  const noteMissing = (description) => { missingCount++; firstMissing ??= description; };
  for await (const line of readLines(input.amenities)) {
    const o = decodeElement(line);
    if (o.type === 'node') {
      if (o.tags.amenity && amenities.includes(o.tags.amenity)) {
        await writeCell(pointToCell(o.lat, o.lon, shardPrecision), mkElement(o));
      }
    } else if (o.type === 'way' && o.tags.amenity && amenities.includes(o.tags.amenity)) {
      const el = mkElement(o);
      let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
      for (const id of o.nodeIds) {
        const coord = await nodes.get(id);
        if (!coord) { noteMissing(`node:${id} referenced by way:${o.id}`); continue; }
        el.memberCoords.set(id, coord);
        south = Math.min(south, coord.lat); north = Math.max(north, coord.lat);
        west = Math.min(west, coord.lon); east = Math.max(east, coord.lon);
      }
      if (!Number.isFinite(south)) continue;
      el.bbox = [south, west, north, east];
      for (const cell of cellsIntersectingBbox(south, west, north, east, shardPrecision)) await writeCell(cell, el);
    } else if (o.type === 'relation' && o.tags.amenity && amenities.includes(o.tags.amenity)) {
      const el = mkElement(o);
      let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
      const supportWays = [];
      for (const m of o.members) {
        if (m.type === 'node') {
          const c = await nodes.get(m.ref);
          if (!c) { noteMissing(`node:${m.ref} referenced by relation:${o.id}`); continue; }
          south = Math.min(south, c.lat); north = Math.max(north, c.lat); west = Math.min(west, c.lon); east = Math.max(east, c.lon);
        } else if (m.type === 'way') supportWays.push(m.ref);
      }
      for (const ref of supportWays) {
        // Way records are read from the stage2 files below, in a bounded scan.
        const found = await ways.get(ref);
        if (!found) { noteMissing(`way:${ref} referenced by relation:${o.id}`); continue; }
        const helper = mkElement(found);
        for (const id of found.nodeIds) {
          const c = await nodes.get(id);
          if (!c) { noteMissing(`node:${id} referenced by way:${ref}`); continue; }
          helper.memberCoords.set(id, { lat: c.lat, lon: c.lon });
          south = Math.min(south, c.lat); north = Math.max(north, c.lat); west = Math.min(west, c.lon); east = Math.max(east, c.lon);
        }
        el._supportWays ??= [];
        el._supportWays.push(helper);
      }
      if (!Number.isFinite(south)) continue;
      el.bbox = [south, west, north, east];
      for (const cell of cellsIntersectingBbox(south, west, north, east, shardPrecision)) {
        await writeCell(cell, el);
        for (const way of el._supportWays || []) await writeCell(cell, way, 'support');
        for (const m of o.members) if (m.type === 'node') {
          const node = await nodes.get(m.ref); if (node) await writeCell(cell, mkElement(node), 'support');
        }
      }
    }
  }
  await Promise.all([...open.values()].map((h) => h.close()));
  await nodes.close();
  if (missingCount) throw new Error(`Stage 4 missing references (${missingCount}); first: ${firstMissing}`);

  let shardCount = 0, totalShardRecords = 0;
  const uniqueRows = await fs.open(path.join(tempRoot, 'unique-records.jsonl'), 'w');
  const shardBudget = Math.min(256, Math.max(32, Math.floor(ramMB * 0.2))) * 1024 * 1024;
  const cells = await fs.readdir(spoolDir);
  for (const name of cells) {
    const cell = name.slice(0, -'.jsonl'.length);
    const dedup = new Map(); const mainSeen = new Set(); let cellBytes = 0;
    const rl = (await import('node:readline')).createInterface({ input: (await import('node:fs')).createReadStream(path.join(spoolDir, name)), crlfDelay: Infinity });
    for await (const line of rl) {
      const row = JSON.parse(line); const o = row.element;
      o.memberCoords = new Map(o.memberCoords || []);
      const k = keyOf(o); const existing = dedup.get(k);
      if (row.kind === 'main') mainSeen.add(k);
      if (!existing) {
        cellBytes += Buffer.byteLength(line) * 3;
        if (cellBytes > shardBudget) throw new Error(`Stage 4 cell ${cell} exceeds the ${Math.floor(shardBudget / 1024 / 1024)} MiB assembly budget; increase shard precision to create smaller cells`);
        dedup.set(k, o);
      }
      else {
        for (const [id, c] of o.memberCoords) existing.memberCoords.set(id, c);
        if (o.version > existing.version || row.kind === 'main') Object.assign(existing, o, { memberCoords: existing.memberCoords });
      }
    }
    const elements = [...dedup.values()];
    const approxBytes = Buffer.byteLength(JSON.stringify(elements, (_k, v) => v instanceof Map ? [...v] : v));
    if (approxBytes > shardBudget) throw new Error(`Stage 4 cell ${cell} exceeds the ${Math.floor(shardBudget / 1024 / 1024)} MiB writer budget (${approxBytes} bytes); increase shard precision to create smaller cells`);
    totalShardRecords += elements.length;
    for (const element of elements) {
      const key = keyOf(element);
      await uniqueRows.write(`${JSON.stringify({ key, main: mainSeen.has(key) })}\n`);
    }
    const bytes = writeShard(cell, elements, 0, configHash);
    const target = path.join(generation, 'shards', `${cell}.bin`);
    await fs.writeFile(`${target}.tmp`, bytes); await fs.rename(`${target}.tmp`, target);
    readShard(await fs.readFile(target));
    await fs.writeFile(`${target}.done`, `${JSON.stringify({ fingerprint, sha256: createHash('sha256').update(bytes).digest('hex') })}\n`);
    shardCount++;
  }
  await uniqueRows.close();
  const uniqueCounts = await countUniqueRecords(tempRoot, (async function* () {
    const lines = (await import('node:readline')).createInterface({ input: (await import('node:fs')).createReadStream(path.join(tempRoot, 'unique-records.jsonl')), crlfDelay: Infinity });
    for await (const line of lines) yield JSON.parse(line);
  })());
  const duplicatedRecords = totalShardRecords - uniqueCounts.mainUnique - uniqueCounts.supportUnique;
  const manifest = { format: 'OAM1', generation: generationId, buildFingerprint: fingerprint, source: sourcePbf, sourcePbf, sourceFingerprint: options.sourceFingerprint ?? null, sourceTimestamp: normalizeTimestamp(options.sourceTimestamp), amenities, shardPrecision, configHash: configHash.toString('hex'), buildSequence: 0, shardCount, shards: cells.map((name) => name.slice(0, -'.jsonl'.length)).sort(), totalElements: uniqueCounts.mainUnique, counts: { mainUnique: uniqueCounts.mainUnique, supportObjects: uniqueCounts.supportUnique, duplicatedRecords, shardRecords: totalShardRecords } };
  const replication = options.replication || null;
  const lastSeq = replication?.kind === 'planet' && replication?.interval === 'minute' && Number.isSafeInteger(replication.sequenceNumber)
    ? replication.sequenceNumber : 0;
  await fs.writeFile(path.join(generation, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(generation, 'state.json'), `${JSON.stringify({ lastSeq, lastUpdate: null, dataTimestamp: manifest.sourceTimestamp, sourcePbf, sourceFingerprint: manifest.sourceFingerprint, replication }, null, 2)}\n`);
  if (!publish) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    return { manifest, generationDir: generation };
  }
  await fs.mkdir(generations, { recursive: true });
  await withGenerationLock(pipelineDir, async () => {
    const activeRootAtCommit = await fs.realpath(path.join(pipelineDir, 'data')).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const activeStateAtCommit = activeRootAtCommit
      ? JSON.parse(await fs.readFile(path.join(activeRootAtCommit, 'state.json'), 'utf8')) : null;
    const activeManifestAtCommit = activeRootAtCommit
      ? JSON.parse(await fs.readFile(path.join(activeRootAtCommit, 'manifest.json'), 'utf8')) : null;
    if (activeRootAtCommit && (!activeStateAtCommit || !activeManifestAtCommit)) throw new Error('active generation metadata is incomplete; refusing stage activation');
    if (activeStateAtCommit) {
      const activeReplication = activeStateAtCommit.replication;
      const candidateReplication = replication;
      if (activeReplication?.sequenceNumber != null) {
        if (!candidateReplication || activeReplication.baseUrl !== candidateReplication.baseUrl || activeReplication.kind !== candidateReplication.kind || activeReplication.interval !== candidateReplication.interval) {
          throw new Error('active generation has replication state; candidate stage snapshot has a different or missing source descriptor');
        }
        if (!Number.isSafeInteger(candidateReplication.sequenceNumber) || candidateReplication.sequenceNumber < activeReplication.sequenceNumber) {
          throw new Error(`candidate stage sequence ${candidateReplication.sequenceNumber} is older than active sequence ${activeReplication.sequenceNumber}`);
        }
      }
      const activeTimestamp = normalizeTimestamp(activeStateAtCommit.dataTimestamp);
      const candidateTimestamp = manifest.sourceTimestamp;
      if (activeTimestamp && candidateTimestamp && Date.parse(candidateTimestamp) < Date.parse(activeTimestamp)) {
        throw new Error(`candidate source timestamp ${candidateTimestamp} is older than active data timestamp ${activeTimestamp}`);
      }
      if (activeStateAtCommit.lastSeq > 0 && (!candidateReplication || candidateReplication.kind !== 'planet' || candidateReplication.interval !== 'minute' || candidateReplication.sequenceNumber < activeStateAtCommit.lastSeq)) {
        throw new Error('active generation has applied updates; candidate stage snapshot has not caught up');
      }
    }
    await activateGeneration(pipelineDir, generation, { lockHeld: true });
  });
  await fs.rm(tempRoot, { recursive: true, force: true });
  return manifest;
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function indexFingerprint(inputs, options) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(options));
  for (const file of [...inputs.amenities, ...inputs.ways, ...inputs.nodes]) {
    hash.update(`${path.basename(file)}:`);
    await new Promise((resolve, reject) => {
      const stream = createReadStream(file);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('error', reject); stream.once('end', resolve);
    });
    hash.update('\0');
  }
  return hash.digest('hex');
}
async function totalFileBytes(files) {
  let total = 0;
  for (const file of files) total += (await fs.stat(file)).size;
  return total;
}
