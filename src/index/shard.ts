import { createHash } from 'node:crypto';

/**
 * OAM1 shard binary format (plan §5): custom, pure-TS (DataView), no native deps.
 *
 * Layout (little-endian):
 *   header (fixed, 78 bytes)
 *     u32   magic "OAM1" (bytes 4F 41 4D 31)
 *     u16   format version (1)
 *     [16]  geohash (UTF-8, zero padded)
 *     u32   element count
 *     u64   dataOffset        (start of string pool)
 *     u64   idIndexOffset     (sorted id -> offset pairs)
 *     u64   nodeRefIndexOffset
 *     u64   buildSequence     (minute sequence of the build, 0 = unknown)
 *     [16]  configHash        (first 16 bytes of SHA-256 over the config)
 *     u32   crc32             (over bytes dataOffset..end)
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
 *   id index:    u32 count, count x (u64 id, u32 offset)
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
const FORMAT_VERSION = 1;
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

export const crc32 = (data: Buffer): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const FIXED_POINT = 10 ** 7;
const toFixed = (value: number): number => Math.round(value * FIXED_POINT);
const fromFixed = (value: number): number => value / FIXED_POINT;

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
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value >>> 0);
  sink.write(buffer);
};

const writeU32 = (sink: ByteSink, value: number): void => {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0);
  sink.write(buffer);
};

const writeU64 = (sink: ByteSink, value: number): void => {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64LE(BigInt(value));
  sink.write(buffer);
};

const writeI32 = (sink: ByteSink, value: number): void => {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32LE(value | 0);
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

  // String pool (keys, values, roles) in first-use order.
  const pool: string[] = [];
  const poolIndex = new Map<string, number>();
  const intern = (value: string): number => {
    const existing = poolIndex.get(value);
    if (existing !== undefined) {
      return existing;
    }
    poolIndex.set(value, pool.length);
    pool.push(value);
    return pool.length - 1;
  };

  // Pre-intern everything so record sizes are deterministic.
  for (const element of elements) {
    for (const [key, value] of Object.entries(element.tags)) {
      intern(key);
      intern(value);
    }
    for (const member of element.members) {
      intern(member.role);
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
  const offsets = new Map<number, number>();
  let cursor = recordStart;
  for (const element of elements) {
    offsets.set(element.id, cursor);
    cursor += recordSize(element);
  }
  const dataEnd = cursor;

  const idIndexStart = dataEnd;
  const idIndexBytes = 4 + 12 * elements.length;
  const nodeRefIndexStart = idIndexStart + idIndexBytes;

  const nodeRefs = new Map<number, number[]>();
  for (const element of elements) {
    if (element.type === 'way') {
      for (const nodeId of element.nodeIds) {
        const list = nodeRefs.get(nodeId) ?? [];
        list.push(offsets.get(element.id) as number);
        nodeRefs.set(nodeId, list);
      }
    } else if (element.type === 'relation') {
      for (const member of element.members) {
        if (member.type === 'node') {
          const list = nodeRefs.get(member.ref) ?? [];
          list.push(offsets.get(element.id) as number);
          nodeRefs.set(member.ref, list);
        }
      }
    }
  }
  const nodeRefEntries = [...nodeRefs.entries()].sort(([a], [b]) => a - b);
  const nodeRefIndexBytes = 4 + nodeRefEntries.reduce(
    (sum, [, refs]) => sum + 8 + 2 + 4 * refs.length, 0
  );
  const totalLength = nodeRefIndexStart + nodeRefIndexBytes;

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
    writeI32(sink, toFixed(element.lat));
    writeI32(sink, toFixed(element.lon));
    writeI32(sink, toFixed(element.bbox[0]));
    writeI32(sink, toFixed(element.bbox[1]));
    writeI32(sink, toFixed(element.bbox[2]));
    writeI32(sink, toFixed(element.bbox[3]));
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
        writeI32(sink, coords ? toFixed(coords.lat) : 0);
        writeI32(sink, coords ? toFixed(coords.lon) : 0);
      }
    } else if (element.type === 'relation') {
      writeU16(sink, element.members.length);
      for (const member of element.members) {
        sink.write(Buffer.from([TYPE_CODE[member.type] ?? 1]));
        writeU64(sink, member.ref);
        writeU16(sink, poolIndex.get(member.role) ?? 0);
      }
    }
  }

  // ID index (sorted by id).
  const sorted = [...elements].sort((a, b) => a.id - b.id);
  writeU32(sink, sorted.length);
  for (const element of sorted) {
    writeU64(sink, element.id);
    writeU32(sink, (offsets.get(element.id) as number) - dataStart);
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
  const checksum = crc32(body.subarray(dataStart));
  body.writeUInt32LE(checksum, 74);
  return body;
};

class Reader {
  private view: DataView;
  private buffer: Buffer;
  pos = 0;

  public constructor(buffer: Buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  public u8 = (): number => {
    const value = this.view.getUint8(this.pos);
    this.pos += 1;
    return value;
  };

  public u16 = (): number => {
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  };

  public u32 = (): number => {
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  };

  public u64 = (): number => {
    const value = Number(this.view.getBigUint64(this.pos, true));
    this.pos += 8;
    return value;
  };

  public i32 = (): number => {
    const value = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return value;
  };

  public bytes = (count: number): Buffer => {
    const out = this.buffer.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  };

  public at = (position: number): Reader => {
    const reader = new Reader(this.buffer);
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
  if (formatVersion !== FORMAT_VERSION) {
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

  if (dataOffset < 78 || idIndexOffset <= dataOffset || nodeRefIndexOffset <= idIndexOffset
    || nodeRefIndexOffset > buffer.length) {
    throw new Error('corrupt shard header offsets');
  }
  const actualCrc = crc32(buffer.subarray(dataOffset));
  if (actualCrc !== expectedCrc) {
    throw new Error(`shard CRC mismatch: ${actualCrc.toString(16)} != ${expectedCrc.toString(16)}`);
  }

  // String pool.
  const poolReader = reader.at(dataOffset);
  const poolCount = poolReader.u16();
  const pool: string[] = [];
  for (let i = 0; i < poolCount; i += 1) {
    const length = poolReader.u16();
    pool.push(poolReader.bytes(length).toString('utf8'));
  }
  reader.pos = poolReader.pos;

  const elements: ShardElement[] = [];
  for (let i = 0; i < elementCount; i += 1) {
    const typeCode = reader.u8();
    const type = CODE_TYPE[typeCode];
    if (!type) {
      throw new Error(`bad element type code: ${typeCode}`);
    }
    const id = reader.u64();
    const version = reader.u32();
    const timestamp = reader.u32();
    const changeset = reader.u64();
    const lat = fromFixed(reader.i32());
    const lon = fromFixed(reader.i32());
    const bbox: [number, number, number, number] = [
      fromFixed(reader.i32()),
      fromFixed(reader.i32()),
      fromFixed(reader.i32()),
      fromFixed(reader.i32())
    ];
    const tagCount = reader.u16();
    const tags: Record<string, string> = {};
    for (let t = 0; t < tagCount; t += 1) {
      const key = pool[reader.u16()];
      const value = pool[reader.u16()];
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
      const nodeCount = reader.u16();
      for (let n = 0; n < nodeCount; n += 1) {
        const nodeId = reader.u64();
        const nodeLat = fromFixed(reader.i32());
        const nodeLon = fromFixed(reader.i32());
        element.nodeIds.push(nodeId);
        if (nodeLat !== 0 || nodeLon !== 0) {
          element.memberCoords.set(nodeId, { lat: nodeLat, lon: nodeLon });
        }
      }
    } else if (type === 'relation') {
      const memberCount = reader.u16();
      for (let m = 0; m < memberCount; m += 1) {
        const memberTypeCode = reader.u8();
        const memberType = CODE_TYPE[memberTypeCode] ?? 'node';
        const ref = reader.u64();
        const role = pool[reader.u16()] ?? '';
        element.members.push({ type: memberType, ref, role });
      }
    }

    elements.push(element);
  }

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
