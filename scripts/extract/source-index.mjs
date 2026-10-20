import fs from 'node:fs/promises';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseOsmElements } from './xml.mjs';
import { createPartitionedMultiIndex, openPartitionedMultiIndex, partitionCountForBytes } from './storage.mjs';
import { readShard } from '../../dist/index/shard.js';

const RANGE_SIZE = 32;
const TYPES = ['node', 'way', 'relation'];
const sourceIdentity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
async function hashFileHandle(handle, size) {
  const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new Error('source PBF ended while validating its fingerprint');
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  return hash.digest('hex');
}
async function validateSourceHandle(indexDir, sourcePath, handle, metadata, expectedFingerprint) {
  const stat = await handle.stat({ bigint: true }); const identity = sourceIdentity(stat);
  if (String(stat.size) !== String(metadata.sourceSize)) throw new Error('source PBF changed since block index was built');
  if (expectedFingerprint && metadata.sourceFingerprint !== expectedFingerprint) throw new Error('source block index fingerprint does not match active generation');
  const expected = expectedFingerprint ?? metadata.sourceFingerprint;
  const attestationPath = path.join(indexDir, 'source-attestation.json');
  let cached = null;
  try { cached = JSON.parse(await fs.readFile(attestationPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const identityMatches = (entry) => entry?.path === sourcePath && entry?.fingerprint === expected && Object.entries(identity).every(([key, value]) => entry[key] === value);
  let fingerprintVerified = identityMatches(cached);
  if (!fingerprintVerified && sourcePath === metadata.source && metadata.sourceIdentity && Object.entries(identity).every(([key, value]) => metadata.sourceIdentity[key] === value)) fingerprintVerified = true;
  if (!fingerprintVerified) {
    const before = sourceIdentity(stat);
    const fingerprint = await hashFileHandle(handle, Number(stat.size));
    const after = sourceIdentity(await handle.stat({ bigint: true }));
    if (Object.entries(before).some(([key, value]) => after[key] !== value)) throw new Error('source PBF changed while validating its fingerprint');
    if (fingerprint !== expected) throw new Error('source PBF fingerprint does not match active generation');
    fingerprintVerified = true;
  }
  if (!identityMatches(cached)) {
    const temporary = `${attestationPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ path: sourcePath, fingerprint: expected, ...identity })}\n`, { flag: 'wx' });
    await fs.rename(temporary, attestationPath);
  }
  return identity;
}
const readVarint = (b, state) => {
  let value = 0n, shift = 0n;
  while (state.i < b.length) {
    const c = b[state.i++]; value |= BigInt(c & 0x7f) << shift;
    if (!(c & 0x80)) return value;
    shift += 7n; if (shift > 70n) throw new Error('invalid protobuf varint');
  }
  throw new Error('truncated protobuf varint');
};
function* fields(b) {
  const s = { i: 0 };
  while (s.i < b.length) {
    const tag = Number(readVarint(b, s)); const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) yield { field, wire, value: readVarint(b, s) };
    else if (wire === 2) { const n = Number(readVarint(b, s)); if (n < 0 || s.i + n > b.length) throw new Error('truncated protobuf field'); yield { field, wire, value: b.subarray(s.i, s.i + n) }; s.i += n; }
    else if (wire === 1) { yield { field, wire, value: b.subarray(s.i, s.i + 8) }; s.i += 8; }
    else if (wire === 5) { yield { field, wire, value: b.subarray(s.i, s.i + 4) }; s.i += 4; }
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}
const zigzag = (n) => (n >> 1n) ^ (-(n & 1n));
function idFromObject(message, type) {
  for (const f of fields(message)) if (f.field === 1 && f.wire === 0) return type === 'node' ? zigzag(f.value) : f.value;
  return null;
}
function* packedVarints(b) { const s = { i: 0 }; while (s.i < b.length) yield readVarint(b, s); }

/** Return object ID ranges from one decompressed PrimitiveBlock payload. */
export function primitiveBlockRanges(data) {
  const range = Object.fromEntries(TYPES.map((t) => [t, { min: null, max: null }]));
  const add = (type, value) => {
    if (value === null) return;
    const r = range[type]; if (r.min === null || value < r.min) r.min = value; if (r.max === null || value > r.max) r.max = value;
  };
  for (const f of fields(data)) if (f.field === 2 && f.wire === 2) {
    for (const groupField of fields(f.value)) {
      if (groupField.field === 1 && groupField.wire === 2) add('node', idFromObject(groupField.value, 'node'));
      else if (groupField.field === 3 && groupField.wire === 2) add('way', idFromObject(groupField.value, 'way'));
      else if (groupField.field === 4 && groupField.wire === 2) add('relation', idFromObject(groupField.value, 'relation'));
      else if (groupField.field === 2 && groupField.wire === 2) {
        let last = 0n;
        for (const denseField of fields(groupField.value)) if (denseField.field === 1) {
          const values = denseField.wire === 2 ? packedVarints(denseField.value) : [denseField.value];
          for (const delta of values) { last += zigzag(delta); add('node', last); }
        }
      }
    }
  }
  return range;
}

function parseHeader(buffer) {
  let type = null, dataSize = null;
  for (const f of fields(buffer)) {
    if (f.field === 1 && f.wire === 2) type = f.value.toString('utf8');
    if (f.field === 3 && f.wire === 0) dataSize = Number(f.value);
  }
  if (!type || !Number.isSafeInteger(dataSize)) throw new Error('invalid PBF BlobHeader');
  return { type, dataSize };
}
function decodeBlob(blob) {
  let raw = null, rawSize = null, compressed = null;
  for (const f of fields(blob)) {
    if (f.field === 1 && f.wire === 2) raw = f.value;
    if (f.field === 2 && f.wire === 0) rawSize = Number(f.value);
    if (f.field === 3 && f.wire === 2) compressed = f.value;
  }
  if (raw) return raw;
  if (!compressed) throw new Error('unsupported PBF Blob compression (zlib or raw required)');
  const out = inflateSync(compressed, { maxOutputLength: rawSize || 64 * 1024 * 1024 });
  if (rawSize !== null && out.length !== rawSize) throw new Error('PBF Blob raw_size mismatch');
  return out;
}
async function readExact(handle, length, position) {
  const b = Buffer.alloc(length); const { bytesRead } = await handle.read(b, 0, length, position);
  if (bytesRead !== length) throw new Error(`truncated PBF at offset ${position}`);
  return b;
}
async function readBlock(handle, offset) {
  const prefix = await readExact(handle, 4, offset); const headerLen = prefix.readUInt32BE(0);
  if (headerLen < 1 || headerLen > 64 * 1024) throw new Error(`invalid PBF header length ${headerLen} at ${offset}`);
  const header = await readExact(handle, headerLen, offset + 4); const info = parseHeader(header);
  if (info.dataSize < 0 || info.dataSize > 32 * 1024 * 1024) throw new Error(`invalid PBF blob length ${info.dataSize} at ${offset}`);
  const blob = await readExact(handle, info.dataSize, offset + 4 + headerLen);
  return { offset, prefix, header, blob, type: info.type, headerLen, blobLen: info.dataSize, next: offset + 4 + headerLen + info.dataSize };
}

const typePath = (root, type) => path.join(root, `${type}.ranges`);
const packRange = (r) => {
  const b = Buffer.alloc(RANGE_SIZE);
  b.writeBigInt64LE(r.min, 0); b.writeBigInt64LE(r.max, 8); b.writeBigInt64LE(BigInt(r.offset), 16);
  b.writeUInt32LE(r.headerLen, 24); b.writeUInt32LE(r.blobLen, 28); return b;
};
const unpackRange = (b) => ({ min: b.readBigInt64LE(0), max: b.readBigInt64LE(8), offset: Number(b.readBigInt64LE(16)), headerLen: b.readUInt32LE(24), blobLen: b.readUInt32LE(28) });

/** Build one compact per-type range index by sequentially decoding PBF blobs. */
export async function buildSourceBlockIndex(sourcePbf, indexDir, { sourceFingerprint = null, onProgress = () => {} } = {}) {
  await fs.rm(indexDir, { recursive: true, force: true }); await fs.mkdir(indexDir, { recursive: true });
  const input = await open(sourcePbf, 'r');
  const outputs = Object.fromEntries(await Promise.all(TYPES.map(async (t) => [t, await open(typePath(indexDir, t), 'w')])));
  const ranges = Object.fromEntries(TYPES.map((t) => [t, { prevMax: null, monotone: true, blocks: 0 }]));
  const hash = createHash('sha256'); let offset = 0, headerBlock = null, blocks = 0;
  try {
    const stat = await input.stat();
    onProgress({ phase: 'building baseline PBF block index', completed: 0, total: stat.size, unit: 'bytes', detail: path.basename(sourcePbf) });
    const statIdentity = sourceIdentity(await input.stat({ bigint: true }));
    while (offset < stat.size) {
      const block = await readBlock(input, offset); blocks++;
      hash.update(block.prefix); hash.update(block.header); hash.update(block.blob);
      if (block.type === 'OSMHeader') { headerBlock = { offset, length: block.next - offset }; }
      if (block.type === 'OSMData') {
        const found = primitiveBlockRanges(decodeBlob(block.blob));
        for (const type of TYPES) {
          const r = found[type]; if (r.min === null) continue;
          const state = ranges[type]; if (state.prevMax !== null && r.min <= state.prevMax) state.monotone = false;
          state.prevMax = r.max; state.blocks++;
          const row = packRange({ min: r.min, max: r.max, offset, headerLen: block.headerLen, blobLen: block.blobLen });
          await outputs[type].write(row);
        }
      }
      offset = block.next;
      onProgress({ phase: 'building baseline PBF block index', completed: offset, total: stat.size, unit: 'bytes', detail: `${blocks.toLocaleString('en-US')} PBF blocks scanned` });
    }
    if (!headerBlock) throw new Error('PBF has no OSMHeader block');
    const finalIdentity = sourceIdentity(await input.stat({ bigint: true }));
    if (Object.entries(statIdentity).some(([key, value]) => finalIdentity[key] !== value)) throw new Error('source PBF changed while building its block index');
    const computedFingerprint = hash.digest('hex');
    if (sourceFingerprint && sourceFingerprint !== computedFingerprint) throw new Error('source PBF fingerprint does not match the supplied source fingerprint');
    const metadata = { format: 1, source: path.resolve(sourcePbf), sourceFingerprint: computedFingerprint, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs, sourceIdentity: statIdentity, headerBlock, ranges: Object.fromEntries(TYPES.map((t) => [t, { monotone: ranges[t].monotone, blocks: ranges[t].blocks }])), blockCount: blocks };
    await fs.writeFile(path.join(indexDir, 'index.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  } finally { await input.close(); await Promise.all(Object.values(outputs).map((h) => h.close())); }
}

export async function openSourceBlockIndex(indexDir, { sourcePbf = null, expectedFingerprint = null } = {}) {
  const metadata = JSON.parse(await fs.readFile(path.join(indexDir, 'index.json'), 'utf8'));
  const sourcePath = sourcePbf ? path.resolve(sourcePbf) : metadata.source;
  const source = await open(sourcePath, 'r');
  try { await validateSourceHandle(indexDir, sourcePath, source, metadata, expectedFingerprint); }
  catch (error) { await source.close(); throw error; }
  const files = Object.fromEntries(await Promise.all(TYPES.map(async (t) => [t, await open(typePath(indexDir, t), 'r')])));
  const rangeCount = Object.fromEntries(TYPES.map((t) => [t, files[t].stat().then((s) => Math.floor(s.size / RANGE_SIZE))]));
  const find = async (type, id) => {
    const target = BigInt(id); const n = await rangeCount[type]; let lo = 0, hi = n - 1, found = [];
    // Build-time ordering check lets lookups use a bounded binary search.
    if (!metadata.ranges[type].monotone) throw new Error(`PBF ${type} block IDs are not monotone; cannot use bounded range lookup`);
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1; const row = unpackRange(await readExact(files[type], RANGE_SIZE, mid * RANGE_SIZE));
      if (target < row.min) hi = mid - 1;
      else if (target > row.max) lo = mid + 1;
      else { found.push(row); break; }
    }
    return found;
  };
  return {
    metadata,
    async resolveBlockOffsets(requests) {
      const selected = new Map();
      for (const request of requests) for (const r of await find(request.type, request.id)) selected.set(r.offset, r);
      return [...selected.values()].sort((a, b) => a.offset - b.offset);
    },
    async writeSubset(requests, destination) {
      const ranges = await this.resolveBlockOffsets(requests);
      const out = await open(destination, 'w');
      try {
        const { offset, length } = metadata.headerBlock;
        let pos = offset; const end = offset + length;
        while (pos < end) { const b = await readBlock(source, pos); const raw = await readExact(source, b.next - pos, pos); await out.write(raw); pos = b.next; }
        for (const r of ranges) {
          const length = 4 + r.headerLen + r.blobLen;
          await out.write(await readExact(source, length, r.offset));
        }
      } finally { await out.close(); }
      return ranges.length;
    },
    async resolveObjects(requests, { tempDir = path.join(indexDir, 'tmp'), maxRequests = 100000, maxCandidateBytes = 64 * 1024 * 1024, maxOutputBytes = 16 * 1024 * 1024 } = {}) {
      if (requests.length > maxRequests) throw new Error(`source lookup batch exceeds ${maxRequests} objects`);
      const unique = new Map(requests.map((r) => [`${r.type}:${r.id}`, r]));
      const batchDir = path.join(tempDir, `resolve-${randomUUID()}`); await fs.mkdir(batchDir, { recursive: true });
      const subset = path.join(batchDir, 'candidate-blocks.pbf');
      const objects = [];
      try {
        const inRanges = [];
        for (const r of unique.values()) if ((await find(r.type, r.id)).length) inRanges.push(r);
        const candidateRows = await this.resolveBlockOffsets(inRanges);
        const candidateBytes = candidateRows.reduce((sum, r) => sum + 4 + r.headerLen + r.blobLen, 0);
        if (candidateBytes > maxCandidateBytes) throw new Error(`source candidate blocks require ${candidateBytes} bytes; request a smaller lookup batch (limit ${maxCandidateBytes})`);
        const blockCount = await this.writeSubset(inRanges, subset);
        if (blockCount === 0) return { objects, missing: [...unique.values()] };
        // Avoid osmium getid's ID-index allocation, which scales with the largest
        // numeric OSM ID. Stream candidate blocks through cat and keep only exact
        // typed IDs from this bounded request.
        const wanted = new Set(inRanges.map((r) => `${r.type}:${r.id}`));
        let stderr = '';
        let child;
        const closed = new Promise((resolve, reject) => {
          child = spawn('osmium', ['cat', subset, '-f', 'osm'], { stdio: ['ignore', 'pipe', 'pipe'] });
          child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk.toString().slice(0, 65536 - stderr.length); });
          child.once('error', reject);
          child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`osmium cat candidate blocks failed (${code}): ${stderr}`)));
        });
        let outputBytes = 0;
        try {
          for await (const element of parseOsmElements(child.stdout)) {
            const key = `${element.type}:${element.id}`;
            if (!wanted.delete(key)) continue;
            outputBytes += Buffer.byteLength(JSON.stringify(element));
            if (outputBytes > maxOutputBytes) throw new Error(`source lookup result exceeds ${maxOutputBytes} bytes; request a smaller lookup batch`);
            objects.push(element);
          }
        } catch (error) { child.kill('SIGTERM'); await closed.catch(() => {}); throw error; }
        await closed;
        const found = new Set(objects.map((o) => `${o.type}:${o.id}`));
        return { objects, missing: [...unique.values()].filter((r) => !found.has(`${r.type}:${r.id}`)) };
      } finally { await fs.rm(batchDir, { recursive: true, force: true }); }
    },
    async close() { await Promise.all([source.close(), ...Object.values(files).map((f) => f.close())]); }
  };
}

/** Build reverse edges and object-to-cell locations only for records in shards. */
export async function buildTrackedIndexes(dataDir, indexDir, partitions = null, onProgress = () => {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(dataDir, 'manifest.json'), 'utf8'));
  const shardNames = Array.isArray(manifest.shards) ? manifest.shards : (await fs.readdir(path.join(dataDir, 'shards'))).filter((n) => n.endsWith('.bin')).map((n) => n.slice(0, -4)).sort();
  let shardBytes = 0;
  for (const cell of shardNames) shardBytes += (await fs.stat(path.join(dataDir, 'shards', `${cell.replace(/\.bin$/, '')}.bin`))).size;
  // The two edge indexes can be several times larger than shard bytes. Size
  // routing up front so no large bucket is ever materialized without a bound.
  partitions ??= partitionCountForBytes(shardBytes * 8, 2 * 1024 * 1024);
  const cellRows = async function* () {
    let completed = 0;
    onProgress({ phase: 'building object-to-cell index', completed, total: shardNames.length, unit: 'shards' });
    for (const cell of shardNames) {
      const shard = readShard(await fs.readFile(path.join(dataDir, 'shards', `${cell.replace(/\.bin$/, '')}.bin`)));
      for (const element of shard.elements) yield { key: `${element.type}:${element.id}`, value: cell };
      completed += 1;
      onProgress({ phase: 'building object-to-cell index', completed, total: shardNames.length, unit: 'shards' });
    }
  };
  const parentRows = async function* () {
    let completed = 0;
    onProgress({ phase: 'building reverse-parent index', completed, total: shardNames.length, unit: 'shards' });
    for (const cell of shardNames) {
      const shard = readShard(await fs.readFile(path.join(dataDir, 'shards', `${cell.replace(/\.bin$/, '')}.bin`)));
      for (const element of shard.elements) {
        const parent = `${element.type}:${element.id}`;
        if (element.type === 'way') for (const id of element.nodeIds) yield { key: `node:${id}`, value: parent };
        else if (element.type === 'relation') for (const m of element.members) if (m.type === 'node' || m.type === 'way' || m.type === 'relation') yield { key: `${m.type}:${m.ref}`, value: parent };
      }
      completed += 1;
      onProgress({ phase: 'building reverse-parent index', completed, total: shardNames.length, unit: 'shards' });
    }
  };
  await createPartitionedMultiIndex(indexDir, 'object-cells', cellRows(), { partitions });
  await createPartitionedMultiIndex(indexDir, 'reverse-parents', parentRows(), { partitions });
  await fs.writeFile(path.join(indexDir, 'tracked-index.json'), `${JSON.stringify({ format: 1, generation: manifest.generation, shardCount: shardNames.length, partitions })}\n`);
  return { shardCount: shardNames.length, partitions };
}

export async function openTrackedIndexes(indexDir) {
  const metadata = JSON.parse(await fs.readFile(path.join(indexDir, 'tracked-index.json'), 'utf8'));
  return {
    metadata,
    cells: openPartitionedMultiIndex(path.join(indexDir, 'object-cells'), metadata.partitions),
    parents: openPartitionedMultiIndex(path.join(indexDir, 'reverse-parents'), metadata.partitions),
    close() { this.cells.close(); this.parents.close(); }
  };
}
