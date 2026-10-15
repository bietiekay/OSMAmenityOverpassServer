/**
 * Replication catch-up (plan §7, Round 3.1): the canonical cursor is the
 * minute sequence number; the update source is always the minute files
 * `minute/NNN/NNN/NNN.osc.gz`. The loop interval (OSM_AMENITY_UPDATE_INTERVAL_SECONDS)
 * only controls how often catch-up runs.
 *
 * osmchange parsing + apply is Phase 2; the pure helpers (state parse, URL
 * build, catch-up lists) are complete and tested.
 */
import { promises as fs } from 'node:fs';

export type Granularity = 'minute';

export interface ReplicationState {
  version: number;
  sequenceNumber: number;
  timestamp: string;
  md5?: string;
}

/** Parse a replication state.txt (version 2 or 3). */
export const parseStateTxt = (text: string): ReplicationState => {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
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
  return {
    version: Number(fields.version ?? 2),
    sequenceNumber: sequence,
    timestamp: fields.timestamp,
    md5: fields.md5sum
  };
};

/**
 * `7327518` -> `<baseUrl>/minute/732/751/8.osc.gz`
 * (standard OSM replication layout: 7-digit sequence split 3/3/1).
 */
export const minuteFileUrl = (baseUrl: string, sequence: number): string => {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new Error(`invalid minute sequence: ${sequence}`);
  }
  const padded = String(sequence).padStart(7, '0');
  const [a, b, c] = [padded.slice(0, 3), padded.slice(3, 6), padded.slice(6)];
  return `${baseUrl}/minute/${a}/${b}/${c}.osc.gz`;
};

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
  return Array.from({ length: currentSeq - lastSeq }, (_, i) => lastSeq + 1 + i);
};

/** GET `<baseUrl>/minute/state.txt` and parse it. */
export const fetchState = async (baseUrl: string, _granularity: Granularity = 'minute'): Promise<ReplicationState> => {
  const url = `${baseUrl}/minute/state.txt`;
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
