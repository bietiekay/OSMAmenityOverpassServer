#!/usr/bin/env node
/**
 * OSMAmenityOverpassServer — extraction CLI
 *
 * Pipeline stages 0–4 (plan §19):
 *   Stage 0: split PBF blocks into self-contained chunks.
 *   Stage 1: stream native osmium XML through the amenity filter.
 *   Stage 2: resolve global member-way references across chunks.
 *   Stage 3: resolve member-node coordinates through a sorted streaming merge.
 *   Stage 4: assemble disk-backed lookups and publish immutable OAM shards.
 *
 * Fingerprinted work manifests and done-markers support abort and resume.
 * Outputs use temporary files and rename; activation uses the generation lock.
 *
 * Usage:
 *   node scripts/extract.mjs --planet-source <file.pbf> --data-dir <dir>
 *      [--stages 0] [--chunk-mb 1024] [--workers N]
 *      [--keep-chunks true|false] [--all-amenity-values true|false]
 *      [--verify] [--resume-mode trust|verify]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stage1 as runStage1Impl, stage2 as runStage2Impl, stage3 as runStage3Impl, validateStageManifest } from './extract/stages.mjs';
import { buildIndex } from './extract/assembly.mjs';
import { wasAborted } from './extract/process.mjs';
import { parseArgs, flagBool, flagInt, parseStages } from './extract/args.mjs';
import { createReadStream } from 'node:fs';
import { createProgress } from './extract/progress.mjs';

export async function sourceFingerprint(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
export function sourceMetadata(file, { allowBootstrap = true } = {}) {
  const res = spawnSync('osmium', ['fileinfo', '--json', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`osmium fileinfo failed: ${res.stderr}`);
  return sourceMetadataFromHeader(JSON.parse(res.stdout).header, { allowBootstrap });
}
export function sourceMetadataFromHeader(header, { allowBootstrap = true } = {}) {
  const options = header.option ?? {};
  // Bootstrap overrides are passed only to the initial extraction. Periodic
  // re-extractions must use metadata belonging to their own candidate PBF.
  const baseUrl = options.osmosis_replication_base_url ?? (allowBootstrap ? process.env.OSM_AMENITY_BOOTSTRAP_REPLICATION_BASE_URL : undefined);
  const sequenceNumber = Number(options.osmosis_replication_sequence_number ?? (allowBootstrap ? process.env.OSM_AMENITY_BOOTSTRAP_REPLICATION_SEQUENCE_NUMBER : undefined));
  const intervalFromUrl = (url) => /(?:^|\/)(minute|hour|day)(?:\/|$)/i.exec(url)?.[1]?.toLowerCase();
  const intervalFromTimestamp = (url) => /-updates(?:\/|$)/i.test(url) ? 'day' : undefined;
  return {
    timestamp: options.osmosis_replication_timestamp ?? options.timestamp ?? null,
    replication: baseUrl && Number.isSafeInteger(sequenceNumber) ? {
      baseUrl, sequenceNumber,
      kind: /planet/i.test(baseUrl) ? 'planet' : 'regional',
      ...(intervalFromUrl(baseUrl) || intervalFromTimestamp(baseUrl)
        ? { interval: intervalFromUrl(baseUrl) || intervalFromTimestamp(baseUrl) }
        : {})
    } : undefined
  };
}

const log = (...parts) => console.log(new Date().toISOString(), ...parts);
export function createRunConfig(argv = [], cwd = process.cwd(), cpuCount = os.cpus().length) {
  const args = parseArgs(argv);
  const dataDir = args['data-dir'] ? path.resolve(cwd, args['data-dir']) : path.resolve(cwd);
  const stages = parseStages(args.stages);
  const chunkMb = flagInt(args, 'chunk-mb', 1024);
  const shardPrecision = flagInt(args, 'shard-precision', 5);
  const ramMb = flagInt(args, 'ram-mb', 8192);
  const workerRamMb = flagInt(args, 'worker-ram-mb', 2048);
  const reserveMb = 512;
  const maxWorkers = Math.floor((ramMb - reserveMb) / workerRamMb);
  if (maxWorkers < 1) throw new Error(`--ram-mb must exceed ${reserveMb} MB and leave room for at least one --worker-ram-mb`);
  const workers = Math.min(flagInt(args, 'workers', Math.max(1, Math.min(cpuCount, maxWorkers))), maxWorkers, cpuCount);
  return { args, source: args.source ?? args['planet-source'], dataDir, stages, chunkMb, shardPrecision, ramMb, workerRamMb, workers,
    keepChunks: flagBool(args, 'keep-chunks', true), allAmenityValues: flagBool(args, 'all-amenity-values', true), verify: flagBool(args, 'verify', false),
    amenities: String(args.amenities ?? 'toilets').split(',').filter(Boolean) };
}

// ---------------------------------------------------------------------------
// PBF block scanning
//
// Standard OSM PBF framing: [u32be BlobHeader length][BlobHeader][Blob bytes].
// ---------------------------------------------------------------------------

const MAX_BLOB_HEADER = 64 * 1024;

export function readVarintFromBuffer(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('varint runs past end of buffer');
    const byte = buf[pos];
    pos += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

/**
 * Parse a BlobHeader in the new framing. Returns { type, datasize }:
 * type is the type string ("OSMHeader"/"OSMData"), datasize the number of
 * blob bytes that follow the header.
 */
export function parseBlobHeaderNew(headerBuf) {
  let type = null;
  let datasize = null;
  let pos = 0;
  while (pos < headerBuf.length) {
    const [tag, next] = readVarintFromBuffer(headerBuf, pos);
    pos = next;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [value, after] = readVarintFromBuffer(headerBuf, pos);
      if (field === 3) datasize = value;
      pos = after;
    } else if (wire === 2) {
      const [len, after] = readVarintFromBuffer(headerBuf, pos);
      if (field === 1) type = headerBuf.toString('utf8', after, after + len);
      pos = after + len;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`unsupported wire type ${wire} in PBF BlobHeader`);
    }
  }
  return { type, datasize };
}

function readBytesAt(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  const read = fs.readSync(fd, buf, 0, length, offset);
  if (read < length) throw new Error(`truncated read at offset ${offset} (got ${read} of ${length})`);
  return buf;
}
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Validate and detect standard OSM PBF framing.
 */
export function detectFormat(fd) {
  const head4 = readBytesAt(fd, 0, 4);
  const newLen = head4.readUInt32BE(0);
  if (newLen > 0 && newLen <= MAX_BLOB_HEADER) {
    const parsed = parseBlobHeaderNew(readBytesAt(fd, 4, newLen));
    if (parsed.type === 'OSMHeader' && parsed.datasize > 0) return 'new';
  }
  throw new Error('unrecognised OSM PBF framing (expected 4-byte big-endian BlobHeader length)');
}

/**
 * Scan a PBF file and list every block: { index, offset, length, type }.
 * Only header bytes are read per block; blob payloads are never touched, so
 * this works for arbitrarily large files and any blob compression. The file
 * must be consumed exactly, and block types must be OSMHeader followed by
 * OSMData only.
 */
export function scanBlocks(filePath, onProgress) {
  const fd = fs.openSync(filePath, 'r');
  const stat = fs.fstatSync(fd);
  const mode = detectFormat(fd);
  const blocks = [];
  let offset = 0;
  try {
    while (offset < stat.size) {
      if (mode === 'new') {
        const headerLen = readBytesAt(fd, offset, 4).readUInt32BE(0);
        if (headerLen === 0) break; // EOF marker
        if (headerLen > MAX_BLOB_HEADER) throw new Error(`BlobHeader too large at offset ${offset}`);
        const parsed = parseBlobHeaderNew(readBytesAt(fd, offset + 4, headerLen));
        if (!parsed.type || !(parsed.datasize > 0)) {
          throw new Error(`bad BlobHeader at offset ${offset}`);
        }
        blocks.push({ index: blocks.length, offset, length: 4 + headerLen + parsed.datasize, type: parsed.type });
        offset += 4 + headerLen + parsed.datasize;
        onProgress?.(offset, stat.size);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  if (blocks.length === 0) throw new Error('PBF file contains no blocks');
  if (blocks[0].type !== 'OSMHeader') throw new Error('first PBF block is not OSMHeader');
  for (const block of blocks.slice(1)) {
    if (block.type !== 'OSMData') throw new Error(`unexpected block type ${block.type} at offset ${block.offset}`);
  }
  if (offset !== stat.size) {
    throw new Error(`PBF blocks do not consume the file exactly (${offset} of ${stat.size} bytes)`);
  }
  return { blocks, fileSize: stat.size };
}

// ---------------------------------------------------------------------------
// Stage 0 — block split (byte-copy)
// ---------------------------------------------------------------------------

function chunkId(n) {
  return `c${String(n).padStart(4, '0')}`;
}

function doneMarker(dataDir, stage, unit) {
  return path.join(dataDir, 'work/state', `stage${stage}`, `${unit}.done`);
}

function markDone(dataDir, stage, unit, payload) {
  const file = doneMarker(dataDir, stage, unit);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
}

export async function runStage0({ planetSource, fingerprint, metadata = {}, dataDir = process.cwd(), chunkMb = 1024, keepChunks = true, resumeMode = 'verify', logger = log }) {
  const WORK_DIR = path.join(dataDir, 'work');
  const CHUNKS_DIR = path.join(WORK_DIR, 'chunks');
  const STATE_DIR = path.join(WORK_DIR, 'state');
  logger(`stage 0: scanning ${planetSource} ...`);
  const scanProgress = createProgress('stage 0 scan', fs.statSync(planetSource).size, logger);
  const { blocks, fileSize } = scanBlocks(planetSource, (bytes, total) => scanProgress(bytes, bytes >= total));
  scanProgress(fileSize, true);
  const dataBlocks = blocks.slice(1);
  const targetBytes = chunkMb * 1024 * 1024;
  logger(`found ${blocks.length} blocks (${(fileSize / 1e9).toFixed(2)} GB), ` +
    `${dataBlocks.length} data blocks, target chunk size ${chunkMb} MB`);

  const previousPath = path.join(WORK_DIR, 'manifest.json');
  let previous;
  try { previous = JSON.parse(fs.readFileSync(previousPath, 'utf8')); } catch {}

  // Group data blocks into chunks of roughly chunkMb compressed bytes.
  const groups = [];
  let current = [];
  let currentBytes = blocks[0].length; // header block travels with every chunk
  for (const block of dataBlocks) {
    if (current.length > 0 && currentBytes + block.length > targetBytes) {
      groups.push(current);
      current = [];
      currentBytes = blocks[0].length;
    }
    current.push(block);
    currentBytes += block.length;
    if (block.length >= targetBytes) {
      // A single block already exceeds the target; do not mix it with others.
      groups.push(current);
      current = [];
      currentBytes = blocks[0].length;
    }
  }
  if (current.length > 0) groups.push(current);

  let legacyUpgrade = false;
  if (previous && !previous.sourceFingerprint && previous.planetSizeBytes === fileSize && previous.chunks?.length === groups.length) {
    legacyUpgrade = true;
    for (let i = 0; i < groups.length; i += 1) {
      const id = chunkId(i); const markerPath = doneMarker(dataDir, 0, id); const outPath = path.join(CHUNKS_DIR, `${id}.pbf`);
      let marker;
      try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { legacyUpgrade = false; break; }
      const bytes = blocks[0].length + groups[i].reduce((sum, b) => sum + b.length, 0);
      const expectedBlocks = [0, ...groups[i].map((b) => b.index)];
      if (marker.fingerprint !== fingerprint || marker.bytes !== bytes || JSON.stringify(marker.blocks) !== JSON.stringify(expectedBlocks) || !fs.existsSync(outPath) || fs.statSync(outPath).size !== bytes || marker.sha256 !== await hashFile(outPath)) { legacyUpgrade = false; break; }
    }
    if (legacyUpgrade) logger('stage 0: upgrading validated legacy chunk manifest; preserving reusable stage 1 outputs');
  }
  if (!legacyUpgrade && (!previous || previous.sourceFingerprint !== fingerprint || previous.chunkTargetMb !== chunkMb || previous.complete !== true)) {
    logger('stage 0: source, chunk target, or work manifest changed; clearing downstream stage data');
    for (const n of [1, 2, 3]) {
      fs.rmSync(path.join(WORK_DIR, `stage${n}`), { recursive: true, force: true });
      fs.rmSync(path.join(STATE_DIR, `stage${n}`), { recursive: true, force: true });
    }
  }

  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, 'stage0'), { recursive: true });
  logger(`writing ${groups.length} chunks -> ${CHUNKS_DIR}`);
  const chunkProgress = createProgress('stage 0 chunks', groups.length, logger);

  const fdSource = await fs.promises.open(planetSource, 'r');
  const manifest = {
    planetSource: path.resolve(planetSource),
    sourceFingerprint: fingerprint,
    sourceTimestamp: metadata.timestamp,
    replication: metadata.replication ?? null,
    planetSizeBytes: fileSize,
    planetSourceModifiedMs: fs.statSync(planetSource).mtimeMs,
    blockCount: blocks.length,
    chunkTargetMb: chunkMb,
    complete: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
    chunks: []
  };

  let interrupted = wasAborted();
  const onSignal = (signal) => {
    interrupted = true;
    logger(`received ${signal}, finishing current chunk then stopping (resume with the same command)`);
  };
  if (interrupted) logger('stop requested while scanning; finishing at most the current chunk before saving resume progress');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    for (let i = 0; i < groups.length; i += 1) {
      const id = chunkId(i);
      const outPath = path.join(CHUNKS_DIR, `${id}.pbf`);
      const marker = doneMarker(dataDir, 0, id);
      let markerData;
      try { markerData = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch {}
      const expectedLength = blocks[0].length + groups[i].reduce((sum, b) => sum + b.length, 0);
      const expectedBlocks = [0, ...groups[i].map((b) => b.index)];
      const markerMatches = markerData?.fingerprint === fingerprint && JSON.stringify(markerData.blocks) === JSON.stringify(expectedBlocks) && markerData.bytes === expectedLength && fs.existsSync(outPath) && fs.statSync(outPath).size === expectedLength;
      if (markerMatches && (resumeMode === 'trust' || markerData.sha256 === await hashFile(outPath))) {
        manifest.chunks.push({ id, file: `${id}.pbf`, blocks: markerData.blocks, bytes: expectedLength, sha256: markerData.sha256 });
        chunkProgress(i + 1);
        if (interrupted) break;
        continue;
      }
      const group = groups[i];
      const tmpPath = `${outPath}.tmp-${process.pid}`;
      const fdOut = await fs.promises.open(tmpPath, 'w');
      const outputHash = createHash('sha256');
      try {
        for (const block of [blocks[0], ...group]) {
          const buf = Buffer.allocUnsafe(block.length);
          const { bytesRead } = await fdSource.read(buf, 0, block.length, block.offset);
          if (bytesRead !== block.length) throw new Error(`truncated source block at ${block.offset}`);
          outputHash.update(buf);
          let written = 0;
          while (written < buf.length) written += (await fdOut.write(buf, written, buf.length - written)).bytesWritten;
        }
      } finally {
        await fdOut.close();
      }
      fs.renameSync(tmpPath, outPath);
      const chunkHash = outputHash.digest('hex');
      markDone(dataDir, 0, id, {
        id,
        fingerprint,
        blocks: expectedBlocks,
        bytes: fs.statSync(outPath).size,
        sha256: chunkHash,
        createdAt: new Date().toISOString()
      });
      manifest.chunks.push({
        id,
        file: `${id}.pbf`,
        blocks: expectedBlocks,
        bytes: fs.statSync(outPath).size,
        sha256: chunkHash
      });
      chunkProgress(i + 1, i === groups.length - 1);
      if (interrupted) break;
    }
  } finally {
    await fdSource.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const tmpManifest = path.join(WORK_DIR, 'manifest.json.tmp');
  manifest.complete = !interrupted && manifest.chunks.length === groups.length;
  if (manifest.complete) manifest.completedAt = new Date().toISOString();
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmpManifest, path.join(WORK_DIR, 'manifest.json'));

  if (interrupted) {
    logger(`stage 0 stopped after signal; resume with the same command (done chunks are skipped).`);
    return { complete: false };
  }

  const keep = new Set(groups.map((_, i) => `${chunkId(i)}.pbf`));
  for (const name of fs.readdirSync(CHUNKS_DIR)) {
    if (/^c\d{4}\.pbf$/.test(name) && !keep.has(name)) fs.rmSync(path.join(CHUNKS_DIR, name));
  }
  for (const name of fs.readdirSync(path.join(STATE_DIR, 'stage0'))) {
    if (/^c\d{4}\.done$/.test(name) && !keep.has(name.replace('.done', '.pbf'))) fs.rmSync(path.join(STATE_DIR, 'stage0', name));
  }

  if (!keepChunks) {
    logger('--keep-chunks=false set, but chunks are kept until stage 2 finishes (they are still needed for re-extract).');
  }
  logger('stage 0 complete');
  return { complete: true };
}

// ---------------------------------------------------------------------------
// Verification (osmium)
// ---------------------------------------------------------------------------

export function osmiumNumObjects(file) {
  const res = spawnSync('osmium', ['fileinfo', '-e', '--json', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status === 0) {
    let info;
    try { info = JSON.parse(res.stdout); } catch (error) { throw new Error(`invalid osmium fileinfo JSON for ${file}: ${error.message}`); }
    const count = info.data?.count;
    if (!count || !['nodes', 'ways', 'relations'].every((key) => Number.isSafeInteger(count[key]))) throw new Error(`osmium fileinfo omitted object counts for ${file}`);
    return { nodes: count.nodes, ways: count.ways, relations: count.relations };
  }
  // Osmium 1.14's JSON formatter tries to serialize an undefined bbox and
  // fails on valid way/relation-only extracts. Its plain extended report does
  // not compute a geometry bbox, so safely fall back only for that known bug.
  if (!/Geometry error: Invalid location/.test(res.stderr || '')) throw new Error(`osmium fileinfo failed on ${file}: ${res.stderr || res.stdout}`);
  const fallback = spawnSync('osmium', ['fileinfo', '-e', '--no-crc', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (fallback.error) throw fallback.error;
  if (fallback.status !== 0) throw new Error(`osmium fileinfo fallback failed on ${file}: ${fallback.stderr || fallback.stdout}`);
  const count = {};
  for (const [key, label] of [['nodes', 'nodes'], ['ways', 'ways'], ['relations', 'relations']]) {
    const match = new RegExp(`Number of ${label}:\\s+(\\d+)`).exec(fallback.stdout);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`osmium fileinfo fallback omitted ${key} count for ${file}`);
    count[key] = Number(match[1]);
  }
  return count;
}

export function runVerify({ planetSource, chunksDir = path.resolve('work/chunks'), logger = log, countObjects = osmiumNumObjects }) {
  logger('verifying with osmium fileinfo ...');
  const planet = countObjects(planetSource);
  logger(`planet: ${planet.nodes} nodes, ${planet.ways} ways, ${planet.relations} relations`);

  const chunkFiles = fs.readdirSync(chunksDir).filter((f) => /^c\d{4}\.pbf$/.test(f)).sort();
  let total = { nodes: 0, ways: 0, relations: 0 };
  let totalBytes = 0;
  for (const file of chunkFiles) {
    const counts = countObjects(path.join(chunksDir, file));
    total.nodes += counts.nodes;
    total.ways += counts.ways;
    total.relations += counts.relations;
    totalBytes += fs.statSync(path.join(chunksDir, file)).size;
  }
  logger(`chunks: ${total.nodes} nodes, ${total.ways} ways, ${total.relations} relations`);
  logger(`chunk total size: ${(totalBytes / 1e9).toFixed(2)} GB (${(totalBytes / 1e6).toFixed(0)} MB)`);

  const ok =
    total.nodes === planet.nodes &&
    total.ways === planet.ways &&
    total.relations === planet.relations;
  if (ok) {
    logger('VERIFY OK: chunk object counts match the planet file');
  } else {
    logger('VERIFY FAILED: counts differ from planet file');
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Stages 1-3 (Phase 1)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2), deps = {}) {
  const config = createRunConfig(argv, deps.cwd ?? process.cwd(), deps.cpuCount ?? os.cpus().length);
  const { source, dataDir: DATA_DIR, stages: STAGES, chunkMb: CHUNK_MB, shardPrecision: SHARD_PRECISION, ramMb: RAM_MB,
    workerRamMb: WORKER_RAM_MB, workers: WORKERS, keepChunks: KEEP_CHUNKS, allAmenityValues: ALL_AMENITY_VALUES, verify: VERIFY, amenities } = config;
  const logger = deps.logger ?? log;
  const stage0 = deps.runStage0 ?? runStage0;
  const stage1 = deps.stage1 ?? runStage1Impl;
  const stage2 = deps.stage2 ?? runStage2Impl;
  const stage3 = deps.stage3 ?? runStage3Impl;
  const assemble = deps.buildIndex ?? buildIndex;
  const fingerprintFile = deps.sourceFingerprint ?? sourceFingerprint;
  const readSourceMetadata = deps.sourceMetadata ?? sourceMetadata;
  const aborted = deps.wasAborted ?? wasAborted;
  logger(`data dir: ${DATA_DIR}`);
  logger(`stages: ${STAGES.join(',')} | chunk-mb: ${CHUNK_MB} | workers: ${WORKERS} (RAM ${RAM_MB} MB, worker ${WORKER_RAM_MB} MB) | ` +
    `keep-chunks: ${KEEP_CHUNKS} | all-amenity-values: ${ALL_AMENITY_VALUES}`);

  if (source && !fs.existsSync(source)) throw new Error(`source not found: ${source}`);
  const WORK_DIR = path.join(DATA_DIR, 'work');
  const resumeMode = String(config.args['resume-mode'] ?? 'verify').toLowerCase();
  if (!['trust', 'verify'].includes(resumeMode)) throw new Error('--resume-mode must be trust or verify');
  const stageOpts = { root: DATA_DIR, workers: WORKERS, workerRamMb: WORKER_RAM_MB, keepChunks: KEEP_CHUNKS || VERIFY, allAmenities: ALL_AMENITY_VALUES, amenities, resumeMode };
  let priorManifest = null;
  try { priorManifest = JSON.parse(fs.readFileSync(path.join(WORK_DIR, 'manifest.json'), 'utf8')); } catch {}
  if (!source && STAGES.includes(0)) throw new Error('--source <file.pbf> is required for stage 0');
  if (source) {
    const sourceSize = fs.statSync(source).size;
    const trustSavedStage0 = resumeMode === 'trust' &&
      typeof priorManifest?.sourceFingerprint === 'string' && priorManifest.sourceFingerprint.length > 0 && Array.isArray(priorManifest.chunks) &&
      priorManifest.planetSource === path.resolve(source) && priorManifest.planetSizeBytes === sourceSize && priorManifest.chunkTargetMb === CHUNK_MB &&
      (priorManifest.planetSourceModifiedMs === undefined || priorManifest.planetSourceModifiedMs === fs.statSync(source).mtimeMs);
    if (trustSavedStage0) {
      logger(`trusting ${priorManifest.complete === true ? 'completed' : 'partial'} stage 0 manifest from ${priorManifest.completedAt ?? priorManifest.createdAt ?? 'unknown date'}; source fingerprint and completed chunk contents will not be re-read`);
      stageOpts.sourceFingerprint = priorManifest.sourceFingerprint;
      stageOpts.sourceMetadata = { timestamp: priorManifest.sourceTimestamp ?? null, replication: priorManifest.replication ?? null };
    } else {
      if (resumeMode === 'trust') throw new Error('Cannot trust stage 0: the saved manifest is missing or does not match the source path, size, modification time, or chunk size. Choose verify mode and rerun stage 0.');
      const fingerprintProgress = createProgress('source fingerprint', sourceSize, logger);
      let fingerprintBytes = 0;
      const fingerprintWithProgress = async (file) => {
        const h = createHash('sha256');
        for await (const chunk of createReadStream(file)) { h.update(chunk); fingerprintBytes += chunk.length; fingerprintProgress(fingerprintBytes, fingerprintBytes >= sourceSize); }
        fingerprintProgress(sourceSize, true);
        return h.digest('hex');
      };
      stageOpts.sourceFingerprint = deps.sourceFingerprint ? await fingerprintFile(source) : await fingerprintWithProgress(source);
      stageOpts.sourceMetadata = readSourceMetadata(source);
    }
    stageOpts.source = path.resolve(source);
  } else {
    if (!priorManifest?.sourceFingerprint || !Array.isArray(priorManifest.chunks)) throw new Error('source omitted and no work/manifest.json provenance is available');
    stageOpts.sourceFingerprint = priorManifest.sourceFingerprint;
    stageOpts.sourceMetadata = { timestamp: priorManifest.sourceTimestamp ?? null, replication: priorManifest.replication ?? null };
    stageOpts.source = priorManifest.planetSource;
  }
  if (aborted()) return;
  for (const stage of STAGES) {
    if (stage > 0) logger(`stage ${stage}: starting`);
    if (stage === 0) {
      if (!source) throw new Error('--source <file.pbf> is required for stage 0');
      if (!fs.existsSync(source)) throw new Error(`source not found: ${source}`);
      const result = await stage0({ planetSource: source, fingerprint: stageOpts.sourceFingerprint, metadata: stageOpts.sourceMetadata, dataDir: DATA_DIR, chunkMb: CHUNK_MB, keepChunks: KEEP_CHUNKS || VERIFY, resumeMode, logger });
      if (!result.complete) return;
    } else if (stage === 1) await stage1(stageOpts);
    else if (stage === 2) await stage2(stageOpts);
    else if (stage === 3) await stage3(stageOpts);
    else if (stage === 4) {
      const current = JSON.parse(fs.readFileSync(path.join(WORK_DIR, 'manifest.json'), 'utf8'));
      if (current.complete !== true) throw new Error('Stage 0 work manifest is incomplete; resume stage 0 first');
      if (current.sourceFingerprint !== stageOpts.sourceFingerprint) throw new Error('work manifest source differs from requested source; run stage 0 first');
      const chunkIds = current.chunks?.map((c) => c.id);
      if (!Array.isArray(chunkIds) || !chunkIds.length) throw new Error('work manifest has no expected chunks');
      for (const n of [1, 2, 3]) await validateStageManifest(DATA_DIR, n, stageOpts.sourceFingerprint, chunkIds, { verifyIntegrity: resumeMode === 'verify' });
      const s1 = JSON.parse(fs.readFileSync(path.join(WORK_DIR, 'stage1/manifest.json'), 'utf8'));
      if (!s1.config?.allAmenities && stageOpts.amenities.some((value) => !(s1.config.amenities || []).includes(value))) throw new Error('Stage 4 amenity values were not retained by Stage 1; rerun stage 1 with those values or --all-amenity-values true');
      await assemble({ pipelineDir: DATA_DIR, source: stageOpts.source, expectedChunkIds: chunkIds, amenities: stageOpts.amenities, shardPrecision: SHARD_PRECISION, ramMB: RAM_MB, sourceTimestamp: stageOpts.sourceMetadata.timestamp, sourceFingerprint: stageOpts.sourceFingerprint, replication: stageOpts.sourceMetadata.replication, resumeMode, logger });
    }
    if (aborted()) return;
  }

  if (VERIFY) {
    if (!source) throw new Error('--verify requires --source');
    if (!runVerify({ planetSource: source, chunksDir: path.join(WORK_DIR, 'chunks'), logger, countObjects: deps.countObjects ?? osmiumNumObjects })) process.exitCode = 1;
  }
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  try { await main(argv, deps); return 0; }
  catch (error) { (deps.onError ?? console.error)(error); return 1; }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().then((status) => { if (status !== 0) process.exitCode = status; });
}
