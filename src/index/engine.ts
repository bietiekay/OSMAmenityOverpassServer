/**
 * Query engine (plan §8): shard resolution, LRU byte cache, value/bbox
 * filtering, dedupe and Overpass-compatible answer assembly.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ParsedAmenityQuery, OutClause } from '../query.js';
import type { BoundingBox } from './geohash.js';
import { bboxToCells } from './geohash.js';
import {
  readShard,
  verifyShard,
  buildConfigHash,
  type ShardElement
} from './shard.js';
import {
  renderJsonResponse,
  renderXmlResponse,
  contentEtag,
  type OverpassElement
} from '../output.js';
import type { AppLogger } from '../logger.js';

export interface EngineOptions {
  dataDir: string;
  shardPrecision: number;
  cacheMb: number;
  generator: string;
  /** Data-sequence timestamp (ISO 8601) for the osm3s block. */
  osmBaseTimestamp?: string | (() => string | undefined);
  /** Expected build config; omitted only for compatibility with direct callers. */
  amenities?: string[];
}

export interface QueryResult {
  payload: string;
  etag: string;
  contentType: string;
  elementCount: number;
}

interface CacheEntry {
  buffer: Buffer;
  bytes: number;
}

/** Bounded LRU byte cache for decoded shard buffers. */
export class ShardCache {
  private entries = new Map<string, CacheEntry>();
  private bytes = 0;

  public constructor(private readonly limitBytes: number) {
    if (limitBytes <= 0) {
      throw new Error('shard cache limit must be positive');
    }
  }

  public get = (key: string): Buffer | undefined => {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    // Refresh LRU position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.buffer;
  };

  public put = (key: string, buffer: Buffer): void => {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.bytes -= existing.bytes;
    }
    this.entries.set(key, { buffer, bytes: buffer.length });
    this.bytes += buffer.length;
    this.evict();
  };

  public drop = (key: string): void => {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.bytes -= entry.bytes;
    }
  };

  public dropAll = (): void => {
    this.entries.clear();
    this.bytes = 0;
  };

  public dropMatching = (matches: (key: string) => boolean): void => {
    for (const key of this.entries.keys()) if (matches(key)) this.drop(key);
  };

  public usageBytes = (): number => this.bytes;

  public evictionCandidates = (): number => this.entries.size;

  private evict = (): void => {
    while (this.bytes > this.limitBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value as string;
      const entry = this.entries.get(oldest);
      if (!entry) {
        break;
      }
      this.entries.delete(oldest);
      this.bytes -= entry.bytes;
    }
  };
}

const intersects = (a: [number, number, number, number], b: BoundingBox): boolean =>
  a[0] <= b.north && a[2] >= b.south && a[1] <= b.east && a[3] >= b.west;

const elementMatchesBbox = (element: ShardElement, bbox: BoundingBox): boolean => {
  if (element.type === 'node') {
    return (
      element.lat >= bbox.south && element.lat <= bbox.north &&
      element.lon >= bbox.west && element.lon <= bbox.east
    );
  }
  if (element.type === 'way' && element.memberCoords.size > 0) {
    return [...element.memberCoords.values()].some((point) =>
      point.lat >= bbox.south && point.lat <= bbox.north &&
      point.lon >= bbox.west && point.lon <= bbox.east
    );
  }
  // Relations carry only aggregate bounds in OAM1. Their precise member
  // geometry is unavailable here, so the bounds are the supported predicate.
  return intersects(element.bbox, bbox);
};

const toOverpassElement = (
  element: ShardElement,
  clause: OutClause,
  includeMeta: boolean,
  related: ShardElement[] = []
): OverpassElement | null => {
  const out: OverpassElement = { type: element.type, id: element.id };
  if (clause.form === 'tags') {
    out.tags = { ...element.tags };
  } else {
    if (element.type === 'node') {
      out.lat = element.lat;
      out.lon = element.lon;
    }
    if (element.type === 'way') {
      out.nodes = [...element.nodeIds];
      if (clause.form === 'geom') {
        out.geometry = element.nodeIds
          .map((nodeId) => {
            const coords = element.memberCoords.get(nodeId);
            return coords ? { lat: coords.lat, lon: coords.lon } : null;
          });
      }
    }
    if (element.type === 'relation') {
      out.members = element.members.map((member) => {
        const mapped: NonNullable<OverpassElement['members']>[number] = {
          type: (member.type === 'way' || member.type === 'relation' ? member.type : 'node') as
            | 'node' | 'way' | 'relation',
          ref: member.ref,
          role: member.role
        };
        const way = clause.form === 'geom' && member.type === 'way'
          ? related.find((candidate) => candidate.type === 'way' && candidate.id === member.ref)
          : undefined;
        const node = clause.form === 'geom' && member.type === 'node'
          ? related.find((candidate) => candidate.type === 'node' && candidate.id === member.ref)
          : undefined;
        if (node) {
          mapped.lat = node.lat;
          mapped.lon = node.lon;
        }
        if (way) mapped.geometry = way.nodeIds.map((nodeId) => {
          const point = way.memberCoords.get(nodeId);
          return point ? { ...point, ref: nodeId } : null;
        }).filter((point): point is { lat: number; lon: number; ref: number } => point !== null);
        return mapped;
      });
    }
    if (clause.form === 'default' || clause.form === 'body' || clause.form === 'geom') {
      out.tags = { ...element.tags };
    }
  }
  if (includeMeta && clause.meta && element.version > 0 && element.timestamp > 0) {
    out.meta = {
      version: element.version,
      timestamp: new Date(element.timestamp * 1000).toISOString().replace('.000Z', 'Z'),
      ...(element.changeset > 0 ? { changeset: element.changeset } : {})
    };
  }
  return out;
};

export class AmenityEngine {
  private readonly cache: ShardCache;
  private readonly options: EngineOptions;
  private readonly logger: AppLogger;
  private expectedConfigHash: string | null = null;
  public cacheHits = 0;
  public cacheMisses = 0;

  public constructor(options: EngineOptions, logger: AppLogger) {
    this.options = options;
    this.logger = logger;
    this.cache = new ShardCache(options.cacheMb * 1024 * 1024);
    if (options.amenities) {
      this.expectedConfigHash = buildConfigHash({ amenities: options.amenities, precision: options.shardPrecision }).toString('hex');
    }
  }

  public configureAmenities = (amenities: string[]): void => {
    this.expectedConfigHash = buildConfigHash({ amenities, precision: this.options.shardPrecision }).toString('hex');
    this.cache.dropAll();
  };

  /** Number of shard files currently on disk (cheap enough for /api/status). */
  public async countShards(): Promise<number> {
    try {
      const names = await fs.readdir(path.join(this.options.dataDir, 'shards'));
      return names.filter((name) => name.endsWith('.bin')).length;
    } catch {
      return 0;
    }
  }

  public async countElements(): Promise<number> {
    try {
      const manifestRaw = await fs.readFile(
        path.join(this.options.dataDir, 'manifest.json'), 'utf8'
      );
      const manifest = JSON.parse(manifestRaw) as {
        totalElements?: number;
        counts?: { shardRecords?: number; mainUnique?: number; supportObjects?: number };
      };
      return Number(manifest.totalElements ?? manifest.counts?.shardRecords ??
        ((manifest.counts?.mainUnique ?? 0) + (manifest.counts?.supportObjects ?? 0)));
    } catch {
      return 0;
    }
  }

  /** Drop cached buffers for the affected shard cells (post-update invalidation). */
  public invalidateCells = (cells: string[]): void => {
    const affected = new Set(cells);
    this.cache.dropMatching((key) => affected.has(key.slice(key.lastIndexOf(':') + 1)));
  };

  public async query(query: ParsedAmenityQuery): Promise<QueryResult> {
    // Pin a symlinked generation once per request so a publish cannot mix shards.
    const dataRoot = await fs.realpath(this.options.dataDir);
    const generation = await this.readGeneration(dataRoot);
    const stamp = generation.timestamp ?? this.configuredTimestamp();
    const cells = bboxToCells(query.bbox, this.options.shardPrecision);
    if (cells.length === 0) {
      return this.emptyResult(query.output, stamp);
    }

    const seen = new Set<string>();
    const mainElements: OverpassElement[] = [];
    const memberNodes = new Map<number, ShardElement>();
    const memberWays = new Map<number, ShardElement>();
    const memberRelations = new Map<number, ShardElement>();
    const mainClause: OutClause =
      query.clauses[0] ?? { form: 'default', meta: false, quiet: false };

    for (const cell of cells) {
      const buffer = await this.loadShard(cell, dataRoot, generation.declaredShards);
      if (!buffer) {
        continue;
      }
      let shard;
      try {
        shard = readShard(buffer);
      } catch (error) {
        throw new Error(`shard ${cell} is corrupt: ${String(error)}`);
      }
      if ((this.expectedConfigHash && shard.header.configHash !== this.expectedConfigHash) ||
        (generation.configHash && shard.header.configHash !== generation.configHash)) {
        throw new Error(`shard ${cell} config hash mismatch`);
      }
      for (const element of shard.elements) {
        const identity = `${element.type}:${element.id}`;
        if (seen.has(identity)) {
          continue;
        }
        if (!query.types.includes(element.type)) continue;
        if ((element.tags.amenity ?? '') !== query.amenity) {
          continue;
        }
        if (!elementMatchesBbox(element, query.bbox)) {
          continue;
        }
        seen.add(identity);
        const overpass = toOverpassElement(element, mainClause, true, shard.elements);
        if (overpass) {
          mainElements.push(overpass);
        }
        if (query.includeMembers) {
          if (element.type === 'way') {
            for (const nodeId of element.nodeIds) {
              const coords = element.memberCoords.get(nodeId);
              if (coords && !memberNodes.has(nodeId)) {
                memberNodes.set(nodeId, this.syntheticNode(nodeId, coords));
              }
            }
          } else if (element.type === 'relation') {
            for (const member of element.members) {
              if (member.type === 'way') {
                const way = shard.elements.find((e) => e.type === 'way' && e.id === member.ref);
                if (way && !memberWays.has(way.id)) {
                  memberWays.set(way.id, way);
                  for (const nodeId of way.nodeIds) {
                    const coords = way.memberCoords.get(nodeId);
                    if (coords && !memberNodes.has(nodeId)) memberNodes.set(nodeId, this.syntheticNode(nodeId, coords));
                  }
                }
              } else if (member.type === 'node') {
                const node = shard.elements.find((e) => e.type === 'node' && e.id === member.ref);
                if (node) {
                  memberNodes.set(node.id, node);
                }
              } else if (member.type === 'relation') {
                const relation = shard.elements.find((e) => e.type === 'relation' && e.id === member.ref);
                if (relation && !memberRelations.has(relation.id)) memberRelations.set(relation.id, relation);
              }
            }
          }
        }
      }
    }

    const memberClause: OutClause | null = query.includeMembers
      ? (query.clauses[1] ?? { form: 'skel', meta: false, quiet: true })
      : null;

    const elements: OverpassElement[] = [...mainElements];
    if (memberClause) {
      for (const [nodeId, node] of memberNodes) {
        if (seen.has(`node:${nodeId}`)) {
          continue; // already returned as a main element
        }
        const converted = toOverpassElement(node, memberClause, true);
        if (converted) elements.push(converted);
      }
      for (const way of memberWays.values()) {
        if (!seen.has(`way:${way.id}`)) {
          const converted = toOverpassElement(way, memberClause, true);
          if (converted) elements.push(converted);
        }
      }
      for (const relation of memberRelations.values()) {
        if (!seen.has(`relation:${relation.id}`)) {
          const converted = toOverpassElement(relation, memberClause, true);
          if (converted) elements.push(converted);
        }
      }
    }

    elements.sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);

    if (query.output === 'json') {
      const payload = JSON.stringify(
        renderJsonResponse(elements, {
          generator: this.options.generator,
          osmBaseTimestamp: stamp,
          includeMeta: true
        })
      );
      return {
        payload,
        etag: contentEtag(payload),
        contentType: 'application/json',
        elementCount: elements.length
      };
    }

    const payload = renderXmlResponse(elements, {
      generator: this.options.generator,
      osmBaseTimestamp: stamp,
      includeMeta: mainClause.meta
    });
    return {
      payload,
      etag: contentEtag(payload),
      contentType: 'text/xml',
      elementCount: elements.length
    };
  }

  private configuredTimestamp(): string | undefined {
    const base = this.options.osmBaseTimestamp;
    return typeof base === 'function' ? base() : base;
  }

  private syntheticNode(id: number, coords: { lat: number; lon: number }): ShardElement {
    return {
      type: 'node', id, version: 0, timestamp: 0, changeset: 0,
      lat: coords.lat, lon: coords.lon,
      bbox: [coords.lat, coords.lon, coords.lat, coords.lon],
      tags: {}, nodeIds: [], memberCoords: new Map(), members: []
    };
  }

  private async readGeneration(dataRoot: string): Promise<{ timestamp?: string; configHash?: string; declaredShards?: Set<string> }> {
    const read = async (name: string): Promise<unknown | null> => {
      try { return JSON.parse(await fs.readFile(path.join(dataRoot, name), 'utf8')) as unknown; }
      catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return null;
        throw new Error(`generation metadata ${name} is unreadable: ${String(error)}`);
      }
    };
    const [stateRaw, manifestRaw] = await Promise.all([read('state.json'), read('manifest.json')]);
    if (stateRaw === null && manifestRaw === null) {
      throw new Error('index generation is not ready: manifest.json and state.json are missing');
    }
    if (stateRaw === null || manifestRaw === null) throw new Error('generation state and manifest must both be present');
    if (typeof stateRaw !== 'object' || Array.isArray(stateRaw) ||
      typeof manifestRaw !== 'object' || Array.isArray(manifestRaw)) {
      throw new Error('generation state and manifest must contain JSON objects');
    }
    const state = stateRaw as { dataTimestamp?: unknown };
    const manifest = manifestRaw as { configHash?: unknown; shards?: unknown };
    if (!Array.isArray(manifest.shards) ||
      manifest.shards.some((name) => typeof name !== 'string' || name.length === 0)) {
      throw new Error('generation manifest must declare its shard inventory');
    }
    if (this.expectedConfigHash && manifest.configHash !== this.expectedConfigHash) {
      throw new Error('generation manifest config hash mismatch');
    }
    const declaredShards = new Set(manifest.shards.map((name) => (name as string).replace(/\.bin$/, '')));
    return {
      timestamp: typeof state.dataTimestamp === 'string' ? state.dataTimestamp : undefined,
      configHash: typeof manifest.configHash === 'string' ? manifest.configHash : undefined,
      declaredShards
    };
  }

  private async emptyResult(output: 'json' | 'xml', stamp?: string): Promise<QueryResult> {
    if (output === 'json') {
      const payload = JSON.stringify(
        renderJsonResponse([], {
          generator: this.options.generator,
          osmBaseTimestamp: stamp,
          includeMeta: true
        })
      );
      return { payload, etag: contentEtag(payload), contentType: 'application/json', elementCount: 0 };
    }
    const payload = renderXmlResponse([], {
      generator: this.options.generator,
      osmBaseTimestamp: stamp,
      includeMeta: false
    });
    return { payload, etag: contentEtag(payload), contentType: 'text/xml', elementCount: 0 };
  }

  private async loadShard(cell: string, dataRoot: string, declaredShards?: Set<string>): Promise<Buffer | undefined> {
    // A manifest is the authoritative snapshot inventory. Ignore stale files
    // left behind by an older generation, even when the file is CRC-valid.
    if (declaredShards && !declaredShards.has(cell)) return undefined;
    const cacheKey = `${dataRoot}:${cell}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    this.cacheMisses += 1;
    const file = path.join(dataRoot, 'shards', `${cell}.bin`);
    try {
      const buffer = await fs.readFile(file);
      if (!verifyShard(buffer)) {
        throw new Error(`shard verification failed: ${cell}`);
      }
      this.cache.put(cacheKey, buffer);
      return buffer;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        if (declaredShards?.has(cell)) throw new Error(`declared shard is missing: ${cell}`);
        return undefined;
      }
      throw error;
    }
  }
}
