import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createPartitionedLookup, openPartitionedLookup, readLines, countUniqueRecords, partitionCountForBytes } from './storage.mjs';
import { pointToCell, cellsIntersectingBbox } from '../../dist/index/geohash.js';
import { buildConfigHash, writeShard, readShard } from '../../dist/index/shard.js';
import { withGenerationLock, activateGeneration } from '../update/generation.mjs';
import { createProgress } from './progress.mjs';

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
  const fingerprint = await indexFingerprint(input, { source: sourcePbf, sourceFingerprint: options.sourceFingerprint ?? null, amenities, shardPrecision, resumeMode: options.resumeMode, logger: options.logger });
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
  const trustResume = options.resumeMode === 'trust';
  const tempRoot = path.join(pipelineDir, 'work', trustResume ? `stage4-${fingerprint}` : `stage4-${randomUUID()}`);
  await fs.mkdir(tempRoot, { recursive: true });
  // Generations are immutable once published. A content fingerprint is useful
  // provenance, but cannot itself be the mutable staging directory name: a
  // retry of the same input may otherwise overwrite the generation serving
  // live queries. Keep every build isolated, including identical rebuilds.
  const runStatePath = path.join(tempRoot, 'stage4-state.json');
  let runState = null;
  if (trustResume) runState = await fs.readFile(runStatePath, 'utf8').then(JSON.parse, () => null);
  const generationId = runState?.generationId ?? `build-${fingerprint}-${randomUUID()}`;
  if (trustResume && !runState) await fs.writeFile(runStatePath, `${JSON.stringify({ fingerprint, generationId })}\n`);
  const generations = path.join(pipelineDir, 'data-generations');
  const generation = path.join(generations, generationId);
  await fs.mkdir(path.join(generation, 'shards'), { recursive: true });
  const nodeRecords = async function* () {
    const total = await totalFileBytes(input.nodes); let completed = 0;
    const progress = createProgress('stage 4 node lookup', total, options.logger ?? console.log);
    for await (const line of readLines(input.nodes)) {
      completed += Buffer.byteLength(line) + 1; progress(completed, completed >= total);
      const o = decodeElement(line);
      if (o.type === 'node') yield { key: o.id, value: o };
    }
    progress(total, true);
  };
  const lookupBudget = Math.max(32, Math.min(512, Math.floor(ramMB * 0.1))) * 1024 * 1024;
  const nodeBytes = await totalFileBytes(input.nodes);
  const nodeLookupDir = path.join(generation, 'objects/nodes');
  const nodes = trustResume && await fs.access(path.join(nodeLookupDir, 'lookup.json')).then(() => true, () => false)
    ? await openPartitionedLookup(nodeLookupDir, { maxCacheBytes: lookupBudget, maxPartitionBytes: 4 * 1024 * 1024 })
    : await createPartitionedLookup(generation, 'objects/nodes', nodeRecords(), { partitions: partitionCountForBytes(nodeBytes * 2), maxCacheBytes: lookupBudget, maxPartitionBytes: 4 * 1024 * 1024 });
  const wayRecords = async function* () {
    const total = await totalFileBytes(input.ways); let completed = 0;
    const progress = createProgress('stage 4 way lookup', total, options.logger ?? console.log);
    for await (const line of readLines(input.ways)) {
      completed += Buffer.byteLength(line) + 1; progress(completed, completed >= total);
      const o = decodeElement(line);
      if (o.type === 'way') yield { key: o.id, value: o };
    }
    progress(total, true);
  };
  const wayBytes = await totalFileBytes(input.ways);
  const wayLookupDir = path.join(generation, 'objects/ways');
  const ways = trustResume && await fs.access(path.join(wayLookupDir, 'lookup.json')).then(() => true, () => false)
    ? await openPartitionedLookup(wayLookupDir, { maxCacheBytes: lookupBudget, maxPartitionBytes: 4 * 1024 * 1024 })
    : await createPartitionedLookup(generation, 'objects/ways', wayRecords(), { partitions: partitionCountForBytes(wayBytes * 2), maxCacheBytes: lookupBudget, maxPartitionBytes: 4 * 1024 * 1024 });
  const spoolDir = path.join(tempRoot, 'cells');
  await fs.mkdir(spoolDir, { recursive: true });
  const spoolStateDir = path.join(tempRoot, 'spool-state');
  await fs.mkdir(spoolStateDir, { recursive: true });
  let activeSpoolDir; let open = new Map();
  const writeCell = async (cell, element, kind = 'main') => {
    const file = path.join(activeSpoolDir, `${cell}.jsonl`);
    let h = open.get(file);
    if (!h) {
      if (open.size >= 64) { const [old, oh] = open.entries().next().value; await oh.close(); open.delete(old); }
      h = await fs.open(file, 'a'); open.set(file, h);
    }
    await h.write(`${JSON.stringify({ kind, element: { ...element, memberCoords: [...element.memberCoords] } })}\n`);
  };
  let missingCount = 0;
  let firstMissing = null;
  const mappingProgress = createProgress('stage 4 amenity chunks', input.amenities.length, options.logger ?? console.log);
  for (let fileIndex = 0; fileIndex < input.amenities.length; fileIndex += 1) {
    const inputFile = input.amenities[fileIndex];
    const chunkId = /amen_(c\d+)/.exec(path.basename(inputFile))?.[1];
    if (!chunkId) throw new Error(`Stage 4 cannot determine chunk ID from ${inputFile}`);
    const chunkSpoolDir = path.join(spoolDir, chunkId);
    const spoolMarker = path.join(spoolStateDir, `${chunkId}.json`);
    const inputStat = await fs.stat(inputFile);
    const spoolFingerprint = createHash('sha256').update(JSON.stringify({ sourceFingerprint: options.sourceFingerprint ?? null, chunkId, inputSize: inputStat.size, inputMtime: inputStat.mtimeMs, amenities, shardPrecision })).digest('hex');
    let priorSpool = null;
    if (trustResume) priorSpool = await fs.readFile(spoolMarker, 'utf8').then(JSON.parse, () => null);
    const spoolReusable = trustResume && priorSpool?.fingerprint === spoolFingerprint && Array.isArray(priorSpool.files) &&
      await Promise.all(priorSpool.files.map(async (item) => fs.stat(path.join(chunkSpoolDir, item.name)).then((stat) => stat.size === item.size, () => false))).then((checks) => checks.every(Boolean));
    if (spoolReusable) {
      missingCount += priorSpool.missingCount ?? 0;
      firstMissing ??= priorSpool.firstMissing ?? null;
      mappingProgress(fileIndex + 1, fileIndex + 1 === input.amenities.length);
      continue;
    }

    await fs.rm(chunkSpoolDir, { recursive: true, force: true });
    await fs.mkdir(chunkSpoolDir, { recursive: true });
    activeSpoolDir = chunkSpoolDir;
    open = new Map();
    let chunkMissingCount = 0; let chunkFirstMissing = null;
    const noteMissing = (description) => { chunkMissingCount++; chunkFirstMissing ??= description; };
    for await (const line of readLines([inputFile])) {
      const o = decodeElement(line);
      if (o.type === 'node') {
        if (o.tags.amenity && amenities.includes(o.tags.amenity)) await writeCell(pointToCell(o.lat, o.lon, shardPrecision), mkElement(o));
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
    await Promise.all([...open.values()].map((handle) => handle.close()));
    const spoolFiles = await fs.readdir(chunkSpoolDir);
    const fileRecords = await Promise.all(spoolFiles.map(async (name) => ({ name, size: (await fs.stat(path.join(chunkSpoolDir, name))).size })));
    const spoolState = { fingerprint: spoolFingerprint, files: fileRecords, missingCount: chunkMissingCount, firstMissing: chunkFirstMissing, completedAt: new Date().toISOString() };
    const spoolTemp = `${spoolMarker}.tmp-${process.pid}`;
    await fs.writeFile(spoolTemp, `${JSON.stringify(spoolState)}\n`); await fs.rename(spoolTemp, spoolMarker);
    missingCount += chunkMissingCount;
    firstMissing ??= chunkFirstMissing;
    mappingProgress(fileIndex + 1, fileIndex + 1 === input.amenities.length);
  }
  await nodes.close();
  if (missingCount) throw new Error(`Stage 4 missing references (${missingCount}); first: ${firstMissing}`);

  let shardCount = 0, totalShardRecords = 0;
  const shardBudget = Math.min(256, Math.max(32, Math.floor(ramMB * 0.2))) * 1024 * 1024;
  const spoolChunks = (await fs.readdir(spoolDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const cellNames = new Set();
  for (const chunk of spoolChunks) for (const name of await fs.readdir(path.join(spoolDir, chunk))) if (name.endsWith('.jsonl')) cellNames.add(name.slice(0, -'.jsonl'.length));
  const cells = [...cellNames].sort();
  const uniqueRecordsDir = path.join(tempRoot, 'unique-records-by-cell');
  const shardStateDir = path.join(tempRoot, 'shard-state');
  await fs.mkdir(uniqueRecordsDir, { recursive: true });
  await fs.mkdir(shardStateDir, { recursive: true });
  const shardProgress = createProgress('stage 4 shards', cells.length, options.logger ?? console.log);
  for (const cell of cells) {
    const uniqueFile = path.join(uniqueRecordsDir, `${cell}.jsonl`);
    const shardStateFile = path.join(shardStateDir, `${cell}.json`);
    const target = path.join(generation, 'shards', `${cell}.bin`);
    let priorShard = null;
    if (trustResume) priorShard = await fs.readFile(shardStateFile, 'utf8').then(JSON.parse, () => null);
    const doneMarker = await fs.readFile(`${target}.done`, 'utf8').then(JSON.parse, () => null);
    const shardReusable = trustResume && priorShard?.fingerprint === fingerprint &&
      doneMarker?.fingerprint === fingerprint &&
      await fs.stat(target).then((stat) => stat.size === priorShard.shardBytes, () => false) &&
      await fs.stat(uniqueFile).then((stat) => stat.size === priorShard.uniqueBytes, () => false);
    if (shardReusable) {
      totalShardRecords += priorShard.records;
      shardCount++;
      shardProgress(shardCount, shardCount === cells.length);
      continue;
    }
    const dedup = new Map(); const mainSeen = new Set(); let cellBytes = 0;
    for (const chunk of spoolChunks) {
      const spoolFile = path.join(spoolDir, chunk, `${cell}.jsonl`);
      if (!(await fs.stat(spoolFile).then(() => true, () => false))) continue;
      const rl = (await import('node:readline')).createInterface({ input: (await import('node:fs')).createReadStream(spoolFile), crlfDelay: Infinity });
      for await (const line of rl) {
        const row = JSON.parse(line); const o = row.element;
        o.memberCoords = new Map(o.memberCoords || []);
        const k = keyOf(o); const existing = dedup.get(k);
        if (row.kind === 'main') mainSeen.add(k);
        if (!existing) {
          cellBytes += Buffer.byteLength(line) * 3;
          if (cellBytes > shardBudget) throw new Error(`Stage 4 cell ${cell} exceeds the ${Math.floor(shardBudget / 1024 / 1024)} MiB assembly budget; increase shard precision to create smaller cells`);
          dedup.set(k, o);
        } else {
          for (const [id, c] of o.memberCoords) existing.memberCoords.set(id, c);
          if (o.version > existing.version || row.kind === 'main') Object.assign(existing, o, { memberCoords: existing.memberCoords });
        }
      }
    }
    const elements = [...dedup.values()];
    const approxBytes = Buffer.byteLength(JSON.stringify(elements, (_k, v) => v instanceof Map ? [...v] : v));
    if (approxBytes > shardBudget) throw new Error(`Stage 4 cell ${cell} exceeds the ${Math.floor(shardBudget / 1024 / 1024)} MiB writer budget (${approxBytes} bytes); increase shard precision to create smaller cells`);
    totalShardRecords += elements.length;
    const uniqueTemp = `${uniqueFile}.tmp-${process.pid}`;
    const uniqueRows = await fs.open(uniqueTemp, 'w');
    try { for (const element of elements) { const key = keyOf(element); await uniqueRows.write(`${JSON.stringify({ key, main: mainSeen.has(key) })}\n`); } }
    finally { await uniqueRows.close(); }
    await fs.rename(uniqueTemp, uniqueFile);
    const bytes = writeShard(cell, elements, 0, configHash);
    await fs.writeFile(`${target}.tmp`, bytes); await fs.rename(`${target}.tmp`, target);
    readShard(await fs.readFile(target));
    await fs.writeFile(`${target}.done`, `${JSON.stringify({ fingerprint, sha256: createHash('sha256').update(bytes).digest('hex') })}\n`);
    const [shardStat, uniqueStat] = await Promise.all([fs.stat(target), fs.stat(uniqueFile)]);
    const stateTemp = `${shardStateFile}.tmp-${process.pid}`;
    await fs.writeFile(stateTemp, `${JSON.stringify({ fingerprint, records: elements.length, shardBytes: shardStat.size, uniqueBytes: uniqueStat.size, completedAt: new Date().toISOString() })}\n`);
    await fs.rename(stateTemp, shardStateFile);
    shardCount++;
    shardProgress(shardCount, shardCount === cells.length);
  }
  const countsFile = path.join(tempRoot, 'unique-counts.json');
  let uniqueCounts = trustResume ? await fs.readFile(countsFile, 'utf8').then(JSON.parse, () => null) : null;
  if (uniqueCounts?.fingerprint !== fingerprint) {
    uniqueCounts = await countUniqueRecords(tempRoot, (async function* () {
      for (const cell of cells) {
        const lines = (await import('node:readline')).createInterface({ input: (await import('node:fs')).createReadStream(path.join(uniqueRecordsDir, `${cell}.jsonl`)), crlfDelay: Infinity });
        for await (const line of lines) yield JSON.parse(line);
      }
    })());
    uniqueCounts.fingerprint = fingerprint;
    await fs.writeFile(countsFile, `${JSON.stringify(uniqueCounts)}\n`);
  }
  const duplicatedRecords = totalShardRecords - uniqueCounts.mainUnique - uniqueCounts.supportUnique;
  const manifest = { format: 'OAM1', generation: generationId, buildFingerprint: fingerprint, source: sourcePbf, sourceFingerprint: options.sourceFingerprint ?? null, sourceTimestamp: normalizeTimestamp(options.sourceTimestamp), amenities, shardPrecision, configHash: configHash.toString('hex'), buildSequence: 0, completedAt: new Date().toISOString(), shardCount, shards: cells, totalElements: uniqueCounts.mainUnique, counts: { mainUnique: uniqueCounts.mainUnique, supportObjects: uniqueCounts.supportUnique, duplicatedRecords, shardRecords: totalShardRecords } };
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
  const { logger: _logger, resumeMode: _resumeMode, ...fingerprintOptions } = options;
  hash.update(JSON.stringify(fingerprintOptions));
  const inputFiles = [...inputs.amenities, ...inputs.ways, ...inputs.nodes];
  const total = await totalFileBytes(inputFiles); let completed = 0;
  const progress = createProgress('stage 4 input fingerprint', total, options.logger ?? console.log);
  for (const file of inputFiles) {
    hash.update(`${path.basename(file)}:`);
    if (options.resumeMode === 'trust') {
      const stat = await fs.stat(file);
      hash.update(`${stat.size}:${stat.mtimeMs}:trusted`);
      completed += stat.size;
      progress(completed, completed >= total);
      hash.update('\0');
      continue;
    }
    await new Promise((resolve, reject) => {
      const stream = createReadStream(file);
      stream.on('data', (chunk) => { hash.update(chunk); completed += chunk.length; progress(completed, completed >= total); });
      stream.once('error', reject); stream.once('end', resolve);
    });
    hash.update('\0');
  }
  progress(total, true);
  return hash.digest('hex');
}
async function totalFileBytes(files) {
  let total = 0;
  for (const file of files) total += (await fs.stat(file)).size;
  return total;
}
