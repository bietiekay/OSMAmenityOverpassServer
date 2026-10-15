#!/usr/bin/env node
/**
 * OSMAmenityOverpassServer — extraction CLI
 *
 * 4-stage pipeline (plan §6):
 *   Stage 0: block-split the planet .pbf into self-contained chunk files (byte-copy, no decode)
 *   Stage 1: amenity extraction per chunk (osmium + Lua)            [Phase 1]
 *   Stage 2: merge member IDs + coordinate lookup (osmium + Lua)     [Phase 1]
 *   Stage 3: shard assembly into OAM1 binary shards (pure TS)        [Phase 1]
 *
 * Work units are tracked via done-markers in <work-dir>/state/stage<N>/cNNNN.done,
 * so every stage is abortable and resumable. Outputs are written atomically
 * (tmp + rename).
 *
 * Phase 0 status: Stage 0 fully implemented + verified. Stages 1-3 are stubs.
 *
 * Usage:
 *   node scripts/extract.mjs --planet-source <file.pbf> --data-dir <dir>
 *      [--stages 0] [--chunk-mb 1024] [--workers N]
 *      [--keep-chunks true|false] [--all-amenity-values true|false]
 *      [--verify]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

function flagBool(args, name, fallback) {
  if (!(name in args)) return fallback;
  if (args[name] === true) return true;
  const v = String(args[name]).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new Error(`Flag --${name} expects true/false, got: ${args[name]}`);
}

function flagInt(args, name, fallback) {
  if (!(name in args)) return fallback;
  const v = Number(args[name]);
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`--${name} must be a positive integer, got: ${args[name]}`);
  }
  return v;
}

function parseStages(raw) {
  if (raw === undefined) return [0];
  const m = String(raw).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`--stages must be like "0" or "0-3", got: ${raw}`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from < 0 || to > 3 || from > to) {
    throw new Error(`--stages must be within 0..3, got: ${raw}`);
  }
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const args = parseArgs(process.argv.slice(2));
const PLANET_SOURCE = args['planet-source'];
const DATA_DIR = args['data-dir'] ? path.resolve(args['data-dir']) : path.resolve('.');
const STAGES = parseStages(args.stages);
const CHUNK_MB = flagInt(args, 'chunk-mb', 1024);
const WORKERS = flagInt(args, 'workers', Math.max(1, Math.min(os.cpus().length, Math.floor(8192 / 2048))));
const KEEP_CHUNKS = flagBool(args, 'keep-chunks', true);
const ALL_AMENITY_VALUES = flagBool(args, 'all-amenity-values', true);
const VERIFY = flagBool(args, 'verify', false);

const WORK_DIR = path.join(DATA_DIR, 'work');
const CHUNKS_DIR = path.join(WORK_DIR, 'chunks');
const STATE_DIR = path.join(WORK_DIR, 'state');

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// ---------------------------------------------------------------------------
// PBF block scanning
//
// Two framings are supported:
//   new (osmium >= 1.14 / libosmium >= 2.18):
//     [u32be BlobHeader length][BlobHeader][datasize bytes of blob]
//     BlobHeader proto: field 1 = type string ("OSMHeader"/"OSMData"),
//                       field 3 = varint datasize (size of the following blob)
//   classic (OSM 2016+ planet files):
//     [varint BlobHeader length][BlobHeader][size bytes of blob]
//     BlobHeader proto: field 1 = varint blob size, field 2 = varint type
//                       (1 = OSMHeader, 2 = OSMData)
// Both frame the blob as self-contained bytes, so chunks are byte copies.
// ---------------------------------------------------------------------------

const MAX_BLOB_HEADER = 64 * 1024;

function readVarintFromBuffer(buf, offset) {
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
function parseBlobHeaderNew(headerBuf) {
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

/**
 * Parse a BlobHeader in the classic framing. Returns { type, datasize } with
 * type as name string, datasize = blob size (field 1); null if the header
 * does not have the classic shape.
 */
function parseBlobHeaderClassic(headerBuf) {
  let size = null;
  let type = null;
  let pos = 0;
  while (pos < headerBuf.length) {
    const [tag, next] = readVarintFromBuffer(headerBuf, pos);
    pos = next;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [value, after] = readVarintFromBuffer(headerBuf, pos);
      if (field === 1) size = value;
      if (field === 2) type = value;
      pos = after;
    } else if (wire === 2) {
      const [len, after] = readVarintFromBuffer(headerBuf, pos);
      pos = after + len;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`unsupported wire type ${wire} in classic BlobHeader`);
    }
  }
  if (type !== 1 && type !== 2) return null;
  return { type: type === 1 ? 'OSMHeader' : 'OSMData', datasize: size };
}

function readBytesAt(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  const read = fs.readSync(fd, buf, 0, length, offset);
  if (read < length) throw new Error(`truncated read at offset ${offset} (got ${read} of ${length})`);
  return buf;
}

/**
 * Detect the PBF framing of the first block: 'new' or 'classic'.
 */
function detectFormat(fd) {
  const head4 = readBytesAt(fd, 0, 4);
  const newLen = head4.readUInt32BE(0);
  if (newLen > 0 && newLen <= MAX_BLOB_HEADER) {
    const parsed = parseBlobHeaderNew(readBytesAt(fd, 4, newLen));
    if (parsed.type === 'OSMHeader' && parsed.datasize > 0) return 'new';
  }
  const win = readBytesAt(fd, 0, 16);
  const [headerLen, afterVarint] = readVarintFromBuffer(win, 0);
  if (headerLen <= 0 || headerLen > MAX_BLOB_HEADER) {
    throw new Error('unrecognised PBF framing (neither osmium >= 1.14 nor classic layout)');
  }
  const parsed = parseBlobHeaderClassic(readBytesAt(fd, afterVarint, headerLen));
  if (!parsed || parsed.type !== 'OSMHeader' || !(parsed.datasize > 0)) {
    throw new Error('unrecognised PBF framing (neither osmium >= 1.14 nor classic layout)');
  }
  return 'classic';
}

/**
 * Scan a PBF file and list every block: { index, offset, length, type }.
 * Only header bytes are read per block; blob payloads are never touched, so
 * this works for arbitrarily large files and any blob compression. The file
 * must be consumed exactly, and block types must be OSMHeader followed by
 * OSMData only.
 */
function scanBlocks(filePath) {
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
      } else {
        const win = Buffer.allocUnsafe(16);
        const winRead = fs.readSync(fd, win, 0, 16, offset);
        if (winRead === 0) throw new Error(`truncated at offset ${offset}`);
        const [headerLen, afterVarint] = readVarintFromBuffer(win.subarray(0, winRead), 0);
        if (headerLen === 0) break;
        if (headerLen > MAX_BLOB_HEADER) throw new Error(`BlobHeader too large at offset ${offset}`);
        const parsed = parseBlobHeaderClassic(readBytesAt(fd, offset + afterVarint, headerLen));
        if (!parsed || !(parsed.datasize > 0)) throw new Error(`bad BlobHeader at offset ${offset}`);
        blocks.push({ index: blocks.length, offset, length: afterVarint + headerLen + parsed.datasize, type: parsed.type });
        offset += afterVarint + headerLen + parsed.datasize;
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

function doneMarker(stage, unit) {
  return path.join(STATE_DIR, `stage${stage}`, `${unit}.done`);
}

function isDone(stage, unit) {
  return fs.existsSync(doneMarker(stage, unit));
}

function markDone(stage, unit, payload) {
  const file = doneMarker(stage, unit);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
}

function runStage0({ planetSource }) {
  log(`stage 0: scanning ${planetSource} ...`);
  const { blocks, fileSize } = scanBlocks(planetSource);
  const dataBlocks = blocks.slice(1);
  const targetBytes = CHUNK_MB * 1024 * 1024;
  log(`found ${blocks.length} blocks (${(fileSize / 1e9).toFixed(2)} GB), ` +
    `${dataBlocks.length} data blocks, target chunk size ${CHUNK_MB} MB`);

  // Group data blocks into chunks of roughly CHUNK_MB compressed bytes.
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

  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  log(`writing ${groups.length} chunks -> ${CHUNKS_DIR}`);

  const fdSource = fs.openSync(planetSource, 'r');
  const manifest = {
    planetSource,
    planetSizeBytes: fileSize,
    blockCount: blocks.length,
    chunkTargetMb: CHUNK_MB,
    createdAt: new Date().toISOString(),
    chunks: []
  };

  let interrupted = false;
  const onSignal = (signal) => {
    interrupted = true;
    log(`received ${signal}, finishing current chunk then stopping (resume with the same command)`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    for (let i = 0; i < groups.length; i += 1) {
      const id = chunkId(i);
      if (isDone(0, id)) {
        manifest.chunks.push({ id, skip: true });
        continue;
      }
      const group = groups[i];
      const outPath = path.join(CHUNKS_DIR, `${id}.pbf`);
      const tmpPath = `${outPath}.tmp-${process.pid}`;
      const fdOut = fs.openSync(tmpPath, 'w');
      try {
        for (const block of [blocks[0], ...group]) {
          const buf = Buffer.allocUnsafe(block.length);
          fs.readSync(fdSource, buf, 0, block.length, block.offset);
          fs.writeSync(fdOut, buf);
        }
      } finally {
        fs.closeSync(fdOut);
      }
      fs.renameSync(tmpPath, outPath);
      markDone(0, id, {
        id,
        blocks: [0, ...group.map((b) => b.index)],
        bytes: fs.statSync(outPath).size,
        createdAt: new Date().toISOString()
      });
      manifest.chunks.push({
        id,
        file: `${id}.pbf`,
        blocks: [0, ...group.map((b) => b.index)],
        bytes: fs.statSync(outPath).size
      });
      if ((i + 1) % 5 === 0 || i === groups.length - 1) {
        log(`  chunk ${id + 1}/${groups.length} done`);
      }
      if (interrupted) break;
    }
  } finally {
    fs.closeSync(fdSource);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const tmpManifest = path.join(WORK_DIR, 'manifest.json.tmp');
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmpManifest, path.join(WORK_DIR, 'manifest.json'));

  if (interrupted) {
    log(`stage 0 stopped after signal; resume with the same command (done chunks are skipped).`);
    return { complete: false };
  }

  if (!KEEP_CHUNKS) {
    log('--keep-chunks=false set, but chunks are kept until stage 2 finishes (they are still needed for re-extract).');
  }
  log('stage 0 complete');
  return { complete: true };
}

// ---------------------------------------------------------------------------
// Verification (osmium)
// ---------------------------------------------------------------------------

function osmiumNumObjects(file) {
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  // osmium show prints ANSI colours; strip them, then count object lines.
  const awkProg =
    '{ gsub(/\\033\\[[0-9;]*m/, "") } /^node / { n++ } /^way / { w++ } /^relation / { r++ } END { printf "%d %d %d", n+0, w+0, r+0 }';
  const res = spawnSync('sh', ['-c', `osmium show ${quoted} | awk '${awkProg}'`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`osmium show failed on ${file}: ${res.stderr || res.stdout}`);
  }
  const [nodes, ways, relations] = res.stdout.trim().split(/\s+/).map(Number);
  return { nodes, ways, relations };
}

function runVerify({ planetSource }) {
  log('verifying with osmium show ...');
  const planet = osmiumNumObjects(planetSource);
  log(`planet: ${planet.nodes} nodes, ${planet.ways} ways, ${planet.relations} relations`);

  const chunkFiles = fs.readdirSync(CHUNKS_DIR).filter((f) => /^c\d{4}\.pbf$/.test(f)).sort();
  let total = { nodes: 0, ways: 0, relations: 0 };
  let totalBytes = 0;
  for (const file of chunkFiles) {
    const counts = osmiumNumObjects(path.join(CHUNKS_DIR, file));
    total.nodes += counts.nodes;
    total.ways += counts.ways;
    total.relations += counts.relations;
    totalBytes += fs.statSync(path.join(CHUNKS_DIR, file)).size;
  }
  log(`chunks: ${total.nodes} nodes, ${total.ways} ways, ${total.relations} relations`);
  log(`chunk total size: ${(totalBytes / 1e9).toFixed(2)} GB (${(totalBytes / 1e6).toFixed(0)} MB)`);

  const ok =
    total.nodes === planet.nodes &&
    total.ways === planet.ways &&
    total.relations === planet.relations;
  if (ok) {
    log('VERIFY OK: chunk object counts match the planet file');
  } else {
    log('VERIFY FAILED: counts differ from planet file');
    process.exitCode = 1;
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Stages 1-3 (Phase 1)
// ---------------------------------------------------------------------------

function runStage1() {
  throw new Error('Stage 1 (amenity extraction, osmium+Lua) is implemented in Phase 1');
}

function runStage2() {
  throw new Error('Stage 2 (member ID merge + coordinate lookup) is implemented in Phase 1');
}

function runStage3() {
  throw new Error('Stage 3 (shard assembly) is implemented in Phase 1');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`data dir: ${DATA_DIR}`);
  log(`stages: ${STAGES.join(',')} | chunk-mb: ${CHUNK_MB} | workers: ${WORKERS} | ` +
    `keep-chunks: ${KEEP_CHUNKS} | all-amenity-values: ${ALL_AMENITY_VALUES}`);

  for (const stage of STAGES) {
    if (stage === 0) {
      if (!PLANET_SOURCE) throw new Error('--planet-source <file.pbf> is required for stage 0');
      if (!fs.existsSync(PLANET_SOURCE)) throw new Error(`planet source not found: ${PLANET_SOURCE}`);
      runStage0({ planetSource: PLANET_SOURCE });
    } else if (stage === 1) runStage1();
    else if (stage === 2) runStage2();
    else if (stage === 3) runStage3();
  }

  if (STAGES.includes(0) && VERIFY) {
    if (!PLANET_SOURCE) throw new Error('--verify requires --planet-source');
    runVerify({ planetSource: PLANET_SOURCE });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
