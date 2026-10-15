/** Parse and construct replication state and file paths for the selected
 * namespace. Regional daily sequence numbers remain local and are not
 * converted to planet minute numbers. */
import { promises as fs } from 'node:fs';

export type Granularity = 'minute' | 'day';

export interface ReplicationState {
  version: number;
  sequenceNumber: number;
  timestamp: string;
  md5?: string;
  /** Optional global planet sequence reported by regional state files. */
  originalPlanetSequence?: number;
}

/** Parse a replication state.txt (version 2 or 3). */
export const parseStateTxt = (text: string): ReplicationState => {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const regionalCursor = trimmed.match(/^#\s*(?:original_)?planet_sequence=(\d+)$/i) ??
      trimmed.match(/^#\s*original\s+OSM\s+minutely\s+replication\s+sequence\s+number\s+(\d+)\s*$/i);
    if (regionalCursor) {
      fields.original_planet_sequence = regionalCursor[1];
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith('#') && !trimmed.startsWith('#version=')) {
      continue;
    }
    const match = trimmed.match(/^#\s*version=(\d+)$|^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    if (match[1] !== undefined) {
      fields.version = match[1];
    } else {
      fields[match[2]] = match[3];
    }
  }

  const sequence = Number(fields.sequenceNumber);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new Error(`state.txt has no valid sequenceNumber: ${fields.sequenceNumber}`);
  }
  if (!fields.timestamp) {
    throw new Error('state.txt has no timestamp');
  }
  const timestamp = fields.timestamp.replace(/\\:/g, ':');
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`state.txt has invalid timestamp: ${fields.timestamp}`);
  const originalPlanetSequence = Number(
    fields.originalPlanetSequence ?? fields.original_planet_sequence ?? fields.planetSequence
  );
  return {
    version: Number(fields.version ?? 2),
    sequenceNumber: sequence,
    timestamp,
    md5: fields.md5sum,
    ...(Number.isSafeInteger(originalPlanetSequence) && originalPlanetSequence > 0 ? { originalPlanetSequence } : {})
  };
};

/**
 * `7327518` -> `<baseUrl>/minute/007/327/518.osc.gz`
 * (standard OSM replication layout: 9-digit sequence split 3/3/3).
 */
export const fileUrl = (baseUrl: string, sequence: number, granularity: Granularity = 'minute'): string => {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new Error(`invalid minute sequence: ${sequence}`);
  }
  if (!Number.isSafeInteger(sequence)) {
    throw new Error(`invalid minute sequence: ${sequence}`);
  }
  const padded = String(sequence).padStart(9, '0');
  const [a, b, c] = [padded.slice(0, -6), padded.slice(-6, -3), padded.slice(-3)];
  return `${baseUrl}/${granularity}/${a}/${b}/${c}.osc.gz`;
};

export const minuteFileUrl = (baseUrl: string, sequence: number): string => fileUrl(baseUrl, sequence, 'minute');

/** All sequences to download for (lastSeq, currentSeq]; empty when up to date. */
export const catchUpSequenceList = (lastSeq: number | null, currentSeq: number): number[] => {
  if (currentSeq <= 0) {
    throw new Error(`invalid current sequence: ${currentSeq}`);
  }
  if (lastSeq === null) {
    throw new Error('lastSeq is required for catch-up (seed from a baseline build)');
  }
  if (lastSeq >= currentSeq) {
    return [];
  }
  const length = currentSeq - lastSeq;
  if (!Number.isSafeInteger(length) || length > 100_000) {
    throw new Error(`catch-up gap too large for an in-memory list (${length}); consume iterateCatchUpSequences instead`);
  }
  return [...iterateCatchUpSequences(lastSeq, currentSeq)];
};

/** Bounded-memory cursor for large catch-up gaps. */
export function* iterateCatchUpSequences(lastSeq: number, currentSeq: number): Generator<number> {
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0 || !Number.isSafeInteger(currentSeq) || currentSeq <= 0) {
    throw new Error('invalid catch-up sequence bounds');
  }
  for (let sequence = lastSeq + 1; sequence <= currentSeq; sequence += 1) yield sequence;
}

/** GET `<baseUrl>/minute/state.txt` and parse it. */
export const fetchState = async (baseUrl: string, granularity: Granularity = 'minute'): Promise<ReplicationState> => {
  const url = `${baseUrl}/${granularity}/state.txt`;
  const response = await fetch(url, { headers: { 'user-agent': 'osm-amenity-overpass-server' } });
  if (!response.ok) {
    throw new Error(`state.txt fetch failed: HTTP ${response.status} for ${url}`);
  }
  return parseStateTxt(await response.text());
};

/**
 * Download a file to disk. Minute diffs are small (20-130 KB), so a full
 * in-memory read is the right size class; larger catch-up files (hour/day,
 * optional) should use a chunked writer instead.
 */
export const downloadFile = async (url: string, destination: string): Promise<number> => {
  const response = await fetch(url, { headers: { 'user-agent': 'osm-amenity-overpass-server' } });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, bytes);
  return bytes.length;
};
