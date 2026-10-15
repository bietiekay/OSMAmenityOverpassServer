/**
 * Overpass-compatible server (plan §10, §17 + Round-3.1 diagnostic addendum).
 *
 * Endpoints:
 *   POST/GET /api/interpreter    in-scope amenity+BBox queries from the index;
 *                                out-of-scope -> HTTP 501 {"error":"out of scope"}
 *   GET      /api/status         conformant Overpass status block
 *                                (version, osm_osm_change, time_used,
 *                                memory_used, output_format) + localEngine
 *                                extension for external monitoring
 *   GET      /api/timestamp      data-sequence timestamp (ISO 8601)
 *   POST     /api/kill_my_queries  200 no-op (no local query queue)
 *   HEAD     on base URL         2xx (upstream recovery probe, plan §17)
 *
 * osm_osm_change is populated only for a persisted planet/minute cursor.
 * Regional daily sequences are exposed separately as localEngine metadata.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';

import type { ServerConfig } from './config.js';
import type { AmenityEngine } from './index/engine.js';
import type { Stats } from './stats.js';
import type { AppLogger } from './logger.js';
import { parseAmenityQuery } from './query.js';

export interface DataState {
  /** Last applied minute sequence (canonical cursor, Round 3.1). */
  lastSeq: number | null;
  /** ISO 8601 timestamp of the last applied update. */
  lastUpdate: string | null;
  /** Data-sequence timestamp for /api/timestamp and the osm3s block. */
  dataTimestamp: string | null;
  replication: {
    baseUrl: string | null;
    kind: 'regional' | 'planet' | null;
    interval: 'minute' | 'day' | null;
    sequenceNumber: number | null;
    originalMinuteSeq: number | null;
  } | null;
}

export const readDataState = async (dataDir: string): Promise<DataState> => {
  const fallback: DataState = { lastSeq: null, lastUpdate: null, dataTimestamp: null, replication: null };
  try {
    const raw = await fs.readFile(path.join(dataDir, 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      lastSeq?: number;
      lastUpdate?: string;
      dataTimestamp?: string;
      replication?: {
        baseUrl?: unknown;
        kind?: unknown;
        interval?: unknown;
        sequenceNumber?: unknown;
        originalMinuteSeq?: unknown;
      };
    };
    const lastSeqRaw = parsed.lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isInteger(lastSeqRaw) ? lastSeqRaw : null;
    return {
      lastSeq,
      lastUpdate: typeof parsed.lastUpdate === 'string' ? parsed.lastUpdate : null,
      dataTimestamp:
        typeof parsed.dataTimestamp === 'string' ? parsed.dataTimestamp : null,
      replication: parsed.replication ? {
        baseUrl: typeof parsed.replication.baseUrl === 'string' ? parsed.replication.baseUrl : null,
        kind: parsed.replication.kind === 'regional' || parsed.replication.kind === 'planet'
          ? parsed.replication.kind : null,
        interval: parsed.replication.interval === 'minute' || parsed.replication.interval === 'day'
          ? parsed.replication.interval : null,
        sequenceNumber: typeof parsed.replication.sequenceNumber === 'number' &&
          Number.isSafeInteger(parsed.replication.sequenceNumber) ? parsed.replication.sequenceNumber : null,
        originalMinuteSeq: typeof parsed.replication.originalMinuteSeq === 'number' &&
          Number.isSafeInteger(parsed.replication.originalMinuteSeq) ? parsed.replication.originalMinuteSeq : null
      } : null
    };
  } catch {
    return fallback;
  }
};

export interface ServerDeps {
  config: ServerConfig;
  engine: AmenityEngine;
  stats: Stats;
  logger: AppLogger;
  serverVersion: string;
}

export const buildServer = (deps: ServerDeps): Promise<FastifyInstance> => {
  const { config, engine, stats, logger, serverVersion } = deps;
  const app = Fastify({ logger: false });
  engine.configureAmenities(config.amenities);

  void app.register(formbody);

  const dataState = (): Promise<DataState> => readDataState(config.dataDir);

  const handleInterpreter = async (
    request: FastifyRequest<{ Body: { data?: string; [key: string]: unknown } }>,
    reply: FastifyReply
  ): Promise<unknown> => {
    if (request.method === 'HEAD') return reply.code(200).send();
    const body = request.body;
    const queryValue = request.query as Record<string, unknown> | undefined;
    const data = typeof body === 'string' ? body : typeof body?.data === 'string'
      ? body.data : typeof queryValue?.data === 'string' ? queryValue.data : null;
    if (typeof data !== 'string' || data.trim().length === 0) {
      return reply.code(400).type('application/json').send({ error: 'missing query in form field "data"' });
    }

    const parsed = parseAmenityQuery(data);
    if (!parsed || !config.amenities.includes(parsed.amenity)) {
      return reply.code(501).type('application/json').send({ error: 'out of scope' });
    }

    const startedAt = process.hrtime.bigint();
    try {
      const result = await engine.query(parsed);
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      stats.recordQuery(latencyMs);
      return reply
        .code(200)
        .header('content-type', result.contentType)
        .header('etag', result.etag)
        .send(result.payload);
    } catch (error) {
      stats.recordError();
      logger.error({ err: String(error) }, 'interpreter query failed');
      return reply.code(500).type('application/json').send({ error: 'internal error' });
    }
  };

  app.post('/api/interpreter', handleInterpreter);
  app.get('/api/interpreter', handleInterpreter);

  app.get('/api/status', async (_request, reply) => {
    const state = await dataState();
    const shardCount = await engine.countShards();
    const elementCount = await engine.countElements();

    // Only a known planet/minute cursor is comparable to global Overpass
    // osm_osm_change; regional daily cursors are exposed in localEngine below.
    const conformant = {
      version: serverVersion,
      osm_osm_change: state.replication?.kind === 'planet' && state.replication.interval === 'minute' &&
        state.replication.sequenceNumber !== null ? String(state.replication.sequenceNumber) : '0',
      time_used: 0.0,
      memory_used: process.memoryUsage().rss,
      output_format: 'JSON'
    };

    // localEngine extension: operational detail for monitoring this server.
    const localEngine = {
      shards: shardCount,
      elements: elementCount,
      amenities: config.amenities,
      shardPrecision: config.shardPrecision,
      lastSeq: state.lastSeq,
      lastUpdate: state.lastUpdate,
      dataTimestamp: state.dataTimestamp,
      updateIntervalSeconds: config.updateIntervalSeconds,
      updateBaseUrl: state.replication?.baseUrl ?? config.updateBaseUrl,
      updateKind: state.replication?.kind ?? config.updateKind,
      updateGranularity: state.replication?.interval ?? config.updateGranularity,
      replication: state.replication,
      stats: stats.snapshot(engine.cacheHits, engine.cacheMisses)
    };

    return reply.type('application/json').send({ ...conformant, localEngine });
  });

  app.get('/api/timestamp', async (_request, reply) => {
    const state = await dataState();
    return reply.type('text/plain').send(state.dataTimestamp ?? '');
  });

  app.post('/api/kill_my_queries', (_request, reply) => {
    // No local query queue; conformant no-op (200).
    return reply.code(200).send('');
  });

  // Base URL answers 2xx so the proxy recovery probe (HEAD) marks the
  // upstream available. Fastify answers HEAD on GET routes automatically.
  app.get('/', (_request, reply) => reply.code(200).send('ok'));

  return Promise.resolve(app.ready()).then(() => app);
};
