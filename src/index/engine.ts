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
  // Coarse element-bbox prefilter (plan §8: exact member-coordinate precision
  // is a Phase-2 refinement; the stored element bbox is already tight).
  return intersects(element.bbox, bbox);
};

const toOverpassElement = (
  element: ShardElement,
  clause: OutClause,
  includeMeta: boolean
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
            return coords ? [coords.lat, coords.lon] as [number, number] : undefined;
          })
          .filter((pair): pair is [number, number] => pair !== undefined);
      }
    }
    if (element.type === 'relation') {
      out.members = element.members.map((member) => ({
        type: (member.type === 'way' || member.type === 'relation' ? member.type : 'node') as
          | 'node'
          | 'way'
          | 'relation',
        ref: member.ref,
        role: member.role
      }));
    }
    if (clause.form === 'default' || clause.form === 'body' || clause.form === 'geom') {
      out.tags = { ...element.tags };
    }
  }
  if (includeMeta && clause.meta) {
    out.meta = {
      version: element.version,
      timestamp: new Date(element.timestamp * 1000).toISOString().replace('.000Z', 'Z'),
      changeset: element.changeset
    };
  }
  return out;
};

export class AmenityEngine {
  private readonly cache: ShardCache;
  private readonly options: EngineOptions;
  private readonly logger: AppLogger;
  private cachedCells = new Set<string>();
  public cacheHits = 0;
  public cacheMisses = 0;

  public constructor(options: EngineOptions, logger: AppLogger) {
    this.options = options;
    this.logger = logger;
    this.cache = new ShardCache(options.cacheMb * 1024 * 1024);
  }

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
      const manifest = JSON.parse(manifestRaw) as { totalElements?: number };
      return Number(manifest.totalElements ?? 0);
    } catch {
      return 0;
    }
  }

  /** Drop cached buffers for the affected shard cells (post-update invalidation). */
  public invalidateCells = (cells: string[]): void => {
    for (const cell of cells) {
      this.cache.drop(cell);
      this.cachedCells.delete(cell);
    }
  };

  public async query(query: ParsedAmenityQuery): Promise<QueryResult> {
    const cells = bboxToCells(query.bbox, this.options.shardPrecision);
    if (cells.length === 0) {
      return this.emptyResult(query.output);
    }

    const seen = new Set<number>();
    const mainElements: OverpassElement[] = [];
    const memberNodes = new Map<number, { lat: number; lon: number }>();
    const memberWays = new Map<number, OverpassElement>();
    const memberRelations = new Map<number, OverpassElement>();
    const mainClause: OutClause =
      query.clauses[0] ?? { form: 'default', meta: false, quiet: false };

    for (const cell of cells) {
      const buffer = await this.loadShard(cell);
      if (!buffer) {
        continue;
      }
      let shard;
      try {
        shard = readShard(buffer);
      } catch (error) {
        this.logger.error({ cell, err: String(error) }, 'shard read failed');
        continue;
      }
      for (const element of shard.elements) {
        if (seen.has(element.id)) {
          continue;
        }
        if ((element.tags.amenity ?? '') !== query.amenity) {
          continue;
        }
        if (!elementMatchesBbox(element, query.bbox)) {
          continue;
        }
        seen.add(element.id);
        const overpass = toOverpassElement(element, mainClause, true);
        if (overpass) {
          mainElements.push(overpass);
        }
        if (query.includeMembers) {
          if (element.type === 'way') {
            for (const nodeId of element.nodeIds) {
              const coords = element.memberCoords.get(nodeId);
              if (coords && !memberNodes.has(nodeId)) {
                memberNodes.set(nodeId, coords);
              }
            }
          } else if (element.type === 'relation') {
            for (const member of element.members) {
              if (member.type === 'way') {
                const way = shard.elements.find((e) => e.type === 'way' && e.id === member.ref);
                if (way && !memberWays.has(way.id)) {
                  const skeleton = toOverpassElement(
                    way, { form: 'skel', meta: false, quiet: false }, false
                  );
                  if (skeleton) {
                    memberWays.set(way.id, skeleton);
                  }
                }
              } else if (member.type === 'node') {
                const node = shard.elements.find((e) => e.type === 'node' && e.id === member.ref);
                if (node && !memberNodes.has(node.id)) {
                  memberNodes.set(node.id, { lat: node.lat, lon: node.lon });
                }
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
      for (const [nodeId, coords] of memberNodes) {
        if (seen.has(nodeId)) {
          continue; // already returned as a main element
        }
        elements.push({
          type: 'node', id: nodeId, lat: coords.lat, lon: coords.lon
        });
      }
      for (const way of memberWays.values()) {
        elements.push(way);
      }
      for (const relation of memberRelations.values()) {
        elements.push(relation);
      }
    }

    elements.sort((a, b) => a.id - b.id);

    if (query.output === 'json') {
      const base = this.options.osmBaseTimestamp;
      const stamp = typeof base === 'function' ? base() : base;
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
      includeMeta: mainClause.meta
    });
    return {
      payload,
      etag: contentEtag(payload),
      contentType: 'text/xml',
      elementCount: elements.length
    };
  }

  private async emptyResult(output: 'json' | 'xml'): Promise<QueryResult> {
    const base = this.options.osmBaseTimestamp;
    const stamp = typeof base === 'function' ? base() : base;
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
      includeMeta: false
    });
    return { payload, etag: contentEtag(payload), contentType: 'text/xml', elementCount: 0 };
  }

  private async loadShard(cell: string): Promise<Buffer | undefined> {
    const cached = this.cache.get(cell);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    this.cacheMisses += 1;
    const file = path.join(this.options.dataDir, 'shards', `${cell}.bin`);
    try {
      const buffer = await fs.readFile(file);
      if (!verifyShard(buffer)) {
        this.logger.error({ cell }, 'shard verification failed');
        return undefined;
      }
      this.cache.put(cell, buffer);
      return buffer;
    } catch {
      return undefined;
    }
  }
}
