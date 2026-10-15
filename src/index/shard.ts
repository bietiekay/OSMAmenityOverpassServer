import { createHash } from 'node:crypto';

/**
 * OAM1 shard binary format (plan §5): custom, pure-TS (DataView), no native deps.
 *
 * Layout (little-endian):
 *   header (fixed, 78 bytes)
 *     u32   magic "OAM1" (bytes 4F 41 4D 31)
 *     u16   format version (1 legacy reader, 2 current writer)
 *     [16]  geohash (UTF-8, zero padded)
 *     u32   element count
 *     u64   dataOffset        (start of string pool)
 *     u64   idIndexOffset     (sorted id -> offset pairs)
 *     u64   nodeRefIndexOffset
 *     u64   buildSequence     (minute sequence of the build, 0 = unknown)
 *     [16]  configHash        (first 16 bytes of SHA-256 over the config)
 *     u32   crc32             (current v2: header excluding checksum + payload;
 *                              v1 and early v2 payload-only checksums read compatibly)
 *   data section (offsets relative to dataOffset)
 *     string pool: u16 count, then count x (u16 len + bytes)
 *     element records, in file order
 *       u8    type            (1 node, 2 way, 3 relation)
 *       u64   id
 *       u32   version
 *       u32   timestamp       (unix seconds)
 *       u64   changeset
 *       i32   lat             (x1e-7; 0 for way/relation)
 *       i32   lon
 *       i32   bbox s,w,n,e    (x1e-7; node bbox = own point)
 *       u16   tagCount        then tagCount x (u16 keyIdx, u16 valueIdx)
 *       way:      u16 nodeCount, then nodeCount x (u64 nodeId, i32 lat, i32 lon)
 *       relation: u16 memberCount, then memberCount x (u8 mtype, u64 ref, u16 roleIdx)
 *   id index v2: u32 count, count x (u8 type, u64 id, u32 offset), sorted by type then id
 *   id index v1: u32 count, count x (u64 id, u32 offset); read-only compatibility
 *   node-ref index: u32 count, count x (u64 nodeId, u16 refCount, refCount x u32 offset)
 *
 * Coordinates are fixed-point i32 (1e-7 degree); lat/lon fit (<= 1.8e9).
 */

export interface MemberRef {
  type: string;
  ref: number;
  role: string;
}

export interface ShardElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  version: number;
  timestamp: number;
  changeset: number;
  lat: number;
  lon: number;
  bbox: [number, number, number, number];
  tags: Record<string, string>;
  /** Way member node ids (empty for node/relation). */
  nodeIds: number[];
  /** Inline member-node coordinates for ways (member-node id -> coords). */
  memberCoords: Map<number, { lat: number; lon: number }>;
  /** Relation members (empty for node/way). */
  members: MemberRef[];
}

export interface ShardHeaderInfo {
  geohash: string;
  formatVersion: number;
  elementCount: number;
  buildSequence: number;
  configHash: string;
}

export const MAGIC = 'OAM1';
const FORMAT_VERSION = 2;
const TYPE_CODE: Record<string, number> = { node: 1, way: 2, relation: 3 };
const CODE_TYPE: Record<number, 'node' | 'way' | 'relation'> = { 1: 'node', 2: 'way', 3: 'relation' };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

const crc32Parts = (parts: Buffer[]): number => {
  let crc = 0xffffffff;
  for (const data of parts) {
    for (let i = 0; i < data.length; i += 1) {
      crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};
export const crc32 = (data: Buffer): number => crc32Parts([data]);
const shardCrc = (data: Buffer, version: number): number => version === 1
  ? crc32(data.subarray(78))
  : crc32Parts([data.subarray(0, 74), data.subarray(78)]);

const FIXED_POINT = 10 ** 7;
const MISSING_COORD = -0x80000000;
const fromFixed = (value: number): number => value / FIXED_POINT;

const assertUInt = (value: number, bits: number, label: string): void => {
  const max = bits === 64 ? Number.MAX_SAFE_INTEGER : 2 ** bits - 1;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} must be an unsigned ${bits}-bit safe integer`);
  }
};

const checkedFixed = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  const fixed = Math.round(value * FIXED_POINT);
  if (!Number.isSafeInteger(fixed) || fixed < -0x7fffffff || fixed > 0x7fffffff) {
    throw new Error(`${label} is outside the OAM coordinate range`);
  }
  return fixed;
};

const encodeGeohash = (geohash: string): Buffer => {
  const out = Buffer.alloc(16);
  Buffer.from(geohash, 'utf8').subarray(0, 16).copy(out);
  return out;
};

export const decodeGeohash = (bytes: Buffer): string =>
  bytes.toString('utf8').replace(/\0+$/g, '');

interface Chunk {
  buffer: Buffer;
  length: number;
}

class ByteSink {
  private chunks: Chunk[] = [];
  private size = 0;

  public write = (buffer: Buffer): void => {
    this.chunks.push({ buffer, length: buffer.length });
    this.size += buffer.length;
  };

  public view = (): Buffer => {
    const out = Buffer.alloc(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      chunk.buffer.copy(out, offset, 0, chunk.length);
      offset += chunk.length;
    }
    return out;
  };
}

const writeU16 = (sink: ByteSink, value: number): void => {
  assertUInt(value, 16, 'u16 value');
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value);
  sink.write(buffer);
};

const writeU32 = (sink: ByteSink, value: number): void => {
  assertUInt(value, 32, 'u32 value');
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value);
  sink.write(buffer);
};

const writeU64 = (sink: ByteSink, value: number): void => {
  assertUInt(value, 64, 'u64 value');
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64LE(BigInt(value));
  sink.write(buffer);
};

const writeI32 = (sink: ByteSink, value: number): void => {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error('i32 value is out of range');
  }
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32LE(value);
  sink.write(buffer);
};

/** Build a complete shard file (header + data + indexes) as a single Buffer. */
export const writeShard = (
  geohash: string,
  elements: ShardElement[],
  buildSequence: number,
  configHash: Buffer
): Buffer => {
  if (configHash.length !== 16) {
    throw new Error('configHash must be exactly 16 bytes');
  }
  if (Buffer.byteLength(geohash, 'utf8') > 16) throw new Error('geohash exceeds 16 UTF-8 bytes');
  assertUInt(buildSequence, 64, 'buildSequence');
  assertUInt(elements.length, 32, 'element count');

  // String pool (keys, values, roles) in first-use order.
  const pool: string[] = [];
  const poolIndex = new Map<string, number>();
  const intern = (value: string): number => {
    if (typeof value !== 'string') throw new Error('shard strings must be strings');
    if (Buffer.byteLength(value, 'utf8') > 0xffff) throw new Error('string exceeds u16 UTF-8 length');
    const existing = poolIndex.get(value);
    if (existing !== undefined) {
      return existing;
    }
    poolIndex.set(value, pool.length);
    pool.push(value);
    if (pool.length > 0xffff) throw new Error('string pool exceeds u16 entry count');
    return pool.length - 1;
  };

  // Pre-intern everything so record sizes are deterministic.
  const identities = new Set<string>();
  for (const element of elements) {
    if (TYPE_CODE[element.type] === undefined) throw new Error(`unsupported element type: ${element.type}`);
    assertUInt(element.id, 64, 'element id');
    if (element.id === 0) throw new Error('element id must be positive');
    assertUInt(element.version, 32, 'element version');
    assertUInt(element.timestamp, 32, 'element timestamp');
    assertUInt(element.changeset, 64, 'element changeset');
    checkedFixed(element.lat, 'element latitude');
    checkedFixed(element.lon, 'element longitude');
    element.bbox.forEach((value) => checkedFixed(value, 'element bbox coordinate'));
    const identity = `${element.type}:${element.id}`;
    if (identities.has(identity)) throw new Error(`duplicate element identity: ${identity}`);
    identities.add(identity);
    if (Object.keys(element.tags).length > 0xffff) throw new Error('tag count exceeds u16');
    if (element.nodeIds.length > 0xffff) throw new Error('way node count exceeds u16');
    if (element.members.length > 0xffff) throw new Error('relation member count exceeds u16');
    for (const [key, value] of Object.entries(element.tags)) {
      intern(key);
      intern(value);
    }
    for (const member of element.members) {
      if (TYPE_CODE[member.type] === undefined) throw new Error(`unsupported relation member type: ${member.type}`);
      assertUInt(member.ref, 64, 'relation member ref');
      if (member.ref === 0) throw new Error('relation member ref must be positive');
      intern(member.role);
    }
    for (const nodeId of element.nodeIds) {
      assertUInt(nodeId, 64, 'way node id');
      if (nodeId === 0) throw new Error('way node id must be positive');
      const point = element.memberCoords.get(nodeId);
      if (point) {
        checkedFixed(point.lat, 'way node latitude');
        checkedFixed(point.lon, 'way node longitude');
      }
    }
  }

  // Compute record byte sizes.
  const recordSize = (element: ShardElement): number => {
    let size = 1 + 8 + 4 + 4 + 8 + 4 + 4 + 4 + 4 + 4 + 4 + 2;
    size += 2 * 2 * Object.keys(element.tags).length;
    if (element.type === 'way') {
      size += 2 + 16 * element.nodeIds.length;
    } else if (element.type === 'relation') {
      size += 2 + 11 * element.members.length;
    }
    return size;
  };

  const poolBytes = 2 + pool.reduce((sum, value) => sum + 2 + Buffer.byteLength(value, 'utf8'), 0);
  const dataStart = 78;
  const recordStart = dataStart + poolBytes;
  const elementKey = (type: string, id: number): string => `${type}:${id}`;
  const offsets = new Map<string, number>();
  let cursor = recordStart;
  for (const element of elements) {
    offsets.set(elementKey(element.type, element.id), cursor);
    cursor += recordSize(element);
  }
  const dataEnd = cursor;

  const idIndexStart = dataEnd;
  const idIndexBytes = 4 + 13 * elements.length;
  const nodeRefIndexStart = idIndexStart + idIndexBytes;

  const nodeRefs = new Map<number, number[]>();
  for (const element of elements) {
    if (element.type === 'way') {
      for (const nodeId of element.nodeIds) {
        const list = nodeRefs.get(nodeId) ?? [];
        list.push(offsets.get(elementKey(element.type, element.id)) as number);
        nodeRefs.set(nodeId, list);
      }
    } else if (element.type === 'relation') {
      for (const member of element.members) {
        if (member.type === 'node') {
          const list = nodeRefs.get(member.ref) ?? [];
          list.push(offsets.get(elementKey(element.type, element.id)) as number);
          nodeRefs.set(member.ref, list);
        }
      }
    }
  }
  const nodeRefEntries = [...nodeRefs.entries()].sort(([a], [b]) => a - b);
  const nodeRefIndexBytes = 4 + nodeRefEntries.reduce(
    (sum, [, refs]) => sum + 8 + 2 + 4 * refs.length, 0
  );
  for (const [, refs] of nodeRefEntries) {
    if (refs.length > 0xffff) throw new Error('node reference count exceeds u16');
  }
  if (nodeRefEntries.length > 0xffffffff) throw new Error('node-ref entry count exceeds u32');
  if (elements.some((element) => (offsets.get(elementKey(element.type, element.id)) as number) - dataStart > 0xffffffff)) {
    throw new Error('record offset exceeds u32 index range');
  }
  const totalLength = nodeRefIndexStart + nodeRefIndexBytes;
  if (!Number.isSafeInteger(totalLength) || totalLength > 0xffffffff) throw new Error('shard exceeds u32 offset range');

  const sink = new ByteSink();
  // Header.
  sink.write(Buffer.from(MAGIC, 'ascii'));
  writeU16(sink, FORMAT_VERSION);
  sink.write(encodeGeohash(geohash));
  writeU32(sink, elements.length);
  writeU64(sink, dataStart);
  writeU64(sink, idIndexStart);
  writeU64(sink, nodeRefIndexStart);
  writeU64(sink, buildSequence);
  sink.write(configHash);
  writeU32(sink, 0); // crc placeholder

  // String pool.
  writeU16(sink, pool.length);
  for (const value of pool) {
    const bytes = Buffer.from(value, 'utf8');
    writeU16(sink, bytes.length);
    sink.write(bytes);
  }

  // Element records.
  for (const element of elements) {
    sink.write(Buffer.from([TYPE_CODE[element.type]]));
    writeU64(sink, element.id);
    writeU32(sink, element.version);
    writeU32(sink, element.timestamp);
    writeU64(sink, element.changeset);
    writeI32(sink, checkedFixed(element.lat, 'element latitude'));
    writeI32(sink, checkedFixed(element.lon, 'element longitude'));
    writeI32(sink, checkedFixed(element.bbox[0], 'element bbox'));
    writeI32(sink, checkedFixed(element.bbox[1], 'element bbox'));
    writeI32(sink, checkedFixed(element.bbox[2], 'element bbox'));
    writeI32(sink, checkedFixed(element.bbox[3], 'element bbox'));
    const keys = Object.keys(element.tags);
    writeU16(sink, keys.length);
    for (const key of keys) {
      writeU16(sink, poolIndex.get(key) as number);
      writeU16(sink, poolIndex.get(element.tags[key]) as number);
    }
    if (element.type === 'way') {
      writeU16(sink, element.nodeIds.length);
      for (const nodeId of element.nodeIds) {
        const coords = element.memberCoords.get(nodeId);
        writeU64(sink, nodeId);
        writeI32(sink, coords ? checkedFixed(coords.lat, 'way node latitude') : MISSING_COORD);
        writeI32(sink, coords ? checkedFixed(coords.lon, 'way node longitude') : MISSING_COORD);
      }
    } else if (element.type === 'relation') {
      writeU16(sink, element.members.length);
      for (const member of element.members) {
        sink.write(Buffer.from([TYPE_CODE[member.type]]));
        writeU64(sink, member.ref);
        writeU16(sink, poolIndex.get(member.role) ?? 0);
      }
    }
  }

  // ID index (sorted by id).
  const sorted = [...elements].sort((a, b) => TYPE_CODE[a.type] - TYPE_CODE[b.type] || a.id - b.id);
  writeU32(sink, sorted.length);
  for (const element of sorted) {
    sink.write(Buffer.from([TYPE_CODE[element.type]]));
    writeU64(sink, element.id);
    writeU32(sink, (offsets.get(elementKey(element.type, element.id)) as number) - dataStart);
  }

  // Node-ref index.
  writeU32(sink, nodeRefEntries.length);
  for (const [nodeId, refs] of nodeRefEntries) {
    writeU64(sink, nodeId);
    writeU16(sink, refs.length);
    for (const offset of refs) {
      writeU32(sink, offset - dataStart);
    }
  }

  const body = sink.view();
  if (body.length !== totalLength) {
    throw new Error(`internal layout mismatch: ${body.length} != ${totalLength}`);
  }
  const checksum = shardCrc(body, FORMAT_VERSION);
  body.writeUInt32LE(checksum, 74);
  return body;
};

class Reader {
  private view: DataView;
  private buffer: Buffer;
  private limit: number;
  pos = 0;

  public constructor(buffer: Buffer, limit = buffer.length) {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.limit = limit;
  }

  private ensure = (count: number): void => {
    if (!Number.isSafeInteger(count) || count < 0 || this.pos < 0 || this.pos + count > this.limit) {
      throw new Error('corrupt shard: read exceeds section boundary');
    }
  }

  public u8 = (): number => {
    this.ensure(1);
    const value = this.view.getUint8(this.pos);
    this.pos += 1;
    return value;
  };

  public u16 = (): number => {
    this.ensure(2);
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  };

  public u32 = (): number => {
    this.ensure(4);
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  };

  public u64 = (): number => {
    this.ensure(8);
    const raw = this.view.getBigUint64(this.pos, true);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error('corrupt shard: u64 value exceeds safe integer range');
    this.pos += 8;
    return value;
  };

  public i32 = (): number => {
    this.ensure(4);
    const value = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return value;
  };

  public bytes = (count: number): Buffer => {
    this.ensure(count);
    const out = this.buffer.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  };

  public at = (position: number, limit = this.buffer.length): Reader => {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(limit) || position < 0 || limit < position || limit > this.buffer.length) {
      throw new Error('corrupt shard: invalid section bounds');
    }
    const reader = new Reader(this.buffer, limit);
    reader.pos = position;
    return reader;
  }
}

export interface ShardFile {
  header: ShardHeaderInfo;
  elements: ShardElement[];
}

/** Parse a shard buffer; validates magic, version, CRC and layout. */
export const readShard = (buffer: Buffer): ShardFile => {
  if (buffer.length < 78) {
    throw new Error('shard buffer too small');
  }
  const magic = buffer.subarray(0, 4).toString('ascii');
  if (magic !== MAGIC) {
    throw new Error(`bad shard magic: ${magic}`);
  }
  const reader = new Reader(buffer);
  reader.pos = 4;
  const formatVersion = reader.u16();
  if (formatVersion !== 1 && formatVersion !== FORMAT_VERSION) {
    throw new Error(`unsupported shard format version: ${formatVersion}`);
  }
  const geohash = decodeGeohash(reader.bytes(16));
  const elementCount = reader.u32();
  const dataOffset = reader.u64();
  const idIndexOffset = reader.u64();
  const nodeRefIndexOffset = reader.u64();
  const buildSequence = reader.u64();
  const configHash = reader.bytes(16).toString('hex');
  const expectedCrc = reader.u32();

  if (dataOffset !== 78 || idIndexOffset <= dataOffset || nodeRefIndexOffset <= idIndexOffset
    || nodeRefIndexOffset > buffer.length) {
    throw new Error('corrupt shard header offsets');
  }
  const actualCrc = shardCrc(buffer, formatVersion);
  // Early v2 artifacts used the original payload-only checksum. Continue to
  // read them, while all current writes protect header and payload together.
  const legacyV2Crc = formatVersion === 2 && crc32(buffer.subarray(78)) === expectedCrc;
  if (actualCrc !== expectedCrc && !legacyV2Crc) {
    throw new Error(`shard CRC mismatch: ${actualCrc.toString(16)} != ${expectedCrc.toString(16)}`);
  }

  // String pool.
  const poolReader = reader.at(dataOffset, idIndexOffset);
  const poolCount = poolReader.u16();
  const pool: string[] = [];
  for (let i = 0; i < poolCount; i += 1) {
    const length = poolReader.u16();
    pool.push(poolReader.bytes(length).toString('utf8'));
  }
  const recordReader = reader.at(poolReader.pos, idIndexOffset);

  const elements: ShardElement[] = [];
  const recordOffsets = new Map<number, ShardElement>();
  const elementOffsets = new Map<string, number>();
  const expectedNodeRefs = new Map<number, number[]>();
  for (let i = 0; i < elementCount; i += 1) {
    const recordOffset = recordReader.pos - dataOffset;
    const typeCode = recordReader.u8();
    const type = CODE_TYPE[typeCode];
    if (!type) {
      throw new Error(`bad element type code: ${typeCode}`);
    }
    const id = recordReader.u64();
    if (id === 0) throw new Error('corrupt shard: element id must be positive');
    const version = recordReader.u32();
    const timestamp = recordReader.u32();
    const changeset = recordReader.u64();
    const lat = fromFixed(recordReader.i32());
    const lon = fromFixed(recordReader.i32());
    const bbox: [number, number, number, number] = [
      fromFixed(recordReader.i32()),
      fromFixed(recordReader.i32()),
      fromFixed(recordReader.i32()),
      fromFixed(recordReader.i32())
    ];
    const tagCount = recordReader.u16();
    const tags: Record<string, string> = {};
    for (let t = 0; t < tagCount; t += 1) {
      const key = pool[recordReader.u16()];
      const value = pool[recordReader.u16()];
      if (key === undefined || value === undefined) {
        throw new Error('shard tag index out of pool range');
      }
      tags[key] = value;
    }

    const element: ShardElement = {
      type, id, version, timestamp, changeset, lat, lon, bbox,
      tags, nodeIds: [], memberCoords: new Map(), members: []
    };

    if (type === 'way') {
      const nodeCount = recordReader.u16();
      for (let n = 0; n < nodeCount; n += 1) {
        const nodeId = recordReader.u64();
        if (nodeId === 0) throw new Error('corrupt shard: way node id must be positive');
        const rawLat = recordReader.i32();
        const rawLon = recordReader.i32();
        const nodeLat = fromFixed(rawLat);
        const nodeLon = fromFixed(rawLon);
        element.nodeIds.push(nodeId);
        const missing = formatVersion === 1
          ? rawLat === 0 && rawLon === 0
          : rawLat === MISSING_COORD && rawLon === MISSING_COORD;
        if ((rawLat === MISSING_COORD) !== (rawLon === MISSING_COORD)) {
          throw new Error('corrupt way coordinate sentinel');
        }
        if (!missing) {
          element.memberCoords.set(nodeId, { lat: nodeLat, lon: nodeLon });
        }
        const refs = expectedNodeRefs.get(nodeId) ?? [];
        refs.push(recordOffset);
        expectedNodeRefs.set(nodeId, refs);
      }
    } else if (type === 'relation') {
      const memberCount = recordReader.u16();
      for (let m = 0; m < memberCount; m += 1) {
        const memberTypeCode = recordReader.u8();
        const memberType = CODE_TYPE[memberTypeCode];
        if (!memberType) throw new Error(`corrupt shard: bad relation member type code ${memberTypeCode}`);
        const ref = recordReader.u64();
        if (ref === 0) throw new Error('corrupt shard: relation member ref must be positive');
        const role = pool[recordReader.u16()];
        if (role === undefined) throw new Error('corrupt shard: relation role index out of pool range');
        element.members.push({ type: memberType, ref, role });
        if (memberType === 'node') {
          const refs = expectedNodeRefs.get(ref) ?? [];
          refs.push(recordOffset);
          expectedNodeRefs.set(ref, refs);
        }
      }
    }

    const identity = `${type}:${id}`;
    if (elementOffsets.has(identity)) throw new Error(`corrupt shard: duplicate element identity ${identity}`);
    recordOffsets.set(recordOffset, element);
    elementOffsets.set(identity, recordOffset);
    elements.push(element);
  }

  if (recordReader.pos !== idIndexOffset) throw new Error('corrupt shard: record section does not end at id index');

  const idReader = reader.at(idIndexOffset, nodeRefIndexOffset);
  const idCount = idReader.u32();
  if (idCount !== elementCount) throw new Error('corrupt shard: id index count does not match header');
  const indexedOffsets = new Set<number>();
  let previousType = 0;
  let previousId = 0;
  for (let i = 0; i < idCount; i += 1) {
    let type: 'node' | 'way' | 'relation';
    let id: number;
    if (formatVersion === 2) {
      const typeCode = idReader.u8();
      const decoded = CODE_TYPE[typeCode];
      if (!decoded) throw new Error(`corrupt shard: bad id index type code ${typeCode}`);
      type = decoded;
      id = idReader.u64();
      const typeRank = TYPE_CODE[type];
      if (typeRank < previousType || typeRank === previousType && id <= previousId) {
        throw new Error('corrupt shard: id index is not strictly sorted');
      }
      previousType = typeRank;
      previousId = id;
    } else {
      id = idReader.u64();
      if (i > 0 && id <= previousId) throw new Error('corrupt shard: v1 id index is not strictly sorted');
      previousId = id;
      type = 'node'; // Resolved from the indexed record below; v1 has no type field.
    }
    const offset = idReader.u32();
    const element = recordOffsets.get(offset);
    if (!element || element.id !== id || formatVersion === 2 && element.type !== type) {
      throw new Error('corrupt shard: id index entry does not match an element record');
    }
    if (indexedOffsets.has(offset)) throw new Error('corrupt shard: duplicate id index offset');
    indexedOffsets.add(offset);
  }
  if (idReader.pos !== nodeRefIndexOffset || indexedOffsets.size !== elementCount) {
    throw new Error('corrupt shard: id index section has invalid length');
  }

  const nodeRefReader = reader.at(nodeRefIndexOffset);
  const nodeRefCount = nodeRefReader.u32();
  if (nodeRefCount !== expectedNodeRefs.size) throw new Error('corrupt shard: node-ref index count mismatch');
  let previousNodeId = 0;
  for (let i = 0; i < nodeRefCount; i += 1) {
    const nodeId = nodeRefReader.u64();
    if (i > 0 && nodeId <= previousNodeId) throw new Error('corrupt shard: node-ref index is not strictly sorted');
    previousNodeId = nodeId;
    const refCount = nodeRefReader.u16();
    if (refCount === 0) throw new Error('corrupt shard: empty node-ref entry');
    const actualOffsets: number[] = [];
    for (let r = 0; r < refCount; r += 1) {
      const offset = nodeRefReader.u32();
      const element = recordOffsets.get(offset);
      if (!element || element.type === 'node') throw new Error('corrupt shard: node-ref offset is not a way/relation record');
      actualOffsets.push(offset);
    }
    const expectedOffsets = expectedNodeRefs.get(nodeId);
    const sortedActual = actualOffsets.sort((a, b) => a - b);
    const sortedExpected = expectedOffsets?.slice().sort((a, b) => a - b);
    if (!sortedExpected || sortedActual.length !== sortedExpected.length ||
      sortedActual.some((offset, index) => offset !== sortedExpected[index])) {
      throw new Error('corrupt shard: node-ref entries do not match element records');
    }
  }
  if (nodeRefReader.pos !== buffer.length) throw new Error('corrupt shard: trailing or truncated node-ref index');

  return {
    header: { geohash, formatVersion, elementCount, buildSequence, configHash },
    elements
  };
};

/** True when the buffer passes magic + CRC validation. */
export const verifyShard = (buffer: Buffer): boolean => {
  try {
    readShard(buffer);
    return true;
  } catch {
    return false;
  }
};

/** Build the config hash used in shard headers (first 16 bytes of SHA-256). */
export const buildConfigHash = (parts: Record<string, unknown>): Buffer => {
  const keys = Object.keys(parts).sort();
  const canonical = JSON.stringify(
    Object.fromEntries(keys.map((k) => [k, parts[k]]))
  );
  return Buffer.from(createHash('sha256').update(canonical).digest('hex').slice(0, 32), 'hex');
};
