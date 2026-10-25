#!/usr/bin/env node
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { IndexDatabase, DATABASE_FILE, DATABASE_FORMAT } from '../dist/index/database.js';
import { buildConfigHash } from '../dist/index/shard.js';

/** Read authoritative metadata in one snapshot; full integrity checks are opt-in. */
export async function checkIndex(config, { integrity = false, requireElements = false } = {}) {
  const root = await fs.realpath(config.dataDir);
  const file = path.join(root, DATABASE_FILE);
  await fs.access(file, constants.R_OK).catch(() => {
    throw new Error(`Fresh ${DATABASE_FORMAT} import required: ${file} is missing. No migration is provided; use a new pipeline directory.`);
  });
  const index = new IndexDatabase(root, { readOnly: true });
  try {
    index.db.exec('BEGIN');
    const manifest = index.getMetadata('manifest');
    const state = index.getMetadata('state');
    assert.ok(manifest && state, 'Database manifest and replication state must both be present');
    assert.equal(manifest.format, DATABASE_FORMAT, 'Fresh SQLite import required');
    assert.ok(Array.isArray(manifest.amenities), 'Database amenity configuration is missing');
    assert.deepEqual([...manifest.amenities].sort(), [...config.amenities].sort(), 'Amenity configuration mismatch');
    assert.equal(manifest.shardPrecision, config.shardPrecision, 'Compatibility precision mismatch');
    assert.equal(manifest.configHash, buildConfigHash({ amenities: config.amenities, precision: config.shardPrecision }).toString('hex'), 'Database config hash mismatch');
    assert.equal(state.replication?.baseUrl, config.updateBaseUrl, 'Replication URL mismatch');
    assert.equal(state.replication?.kind, config.updateKind, 'Replication kind mismatch');
    assert.equal(state.replication?.interval, config.updateGranularity, 'Replication interval mismatch');
    assert.ok(Number.isSafeInteger(state.replication?.sequenceNumber) && state.replication.sequenceNumber > 0, 'A positive namespace-local replication cursor is required');
    if (state.replication.kind === 'planet' && state.replication.interval === 'minute') {
      assert.equal(state.lastSeq, state.replication.sequenceNumber, 'Planet minute cursor mismatch');
    }
    assert.ok(typeof state.dataTimestamp === 'string' && Number.isFinite(Date.parse(state.dataTimestamp)), 'A valid data timestamp is required');
    assert.match(state.sourceFingerprint ?? '', /^[0-9a-f]{64}$/, 'Retained source fingerprint is missing or invalid');
    const counts = index.counts();
    assert.equal(manifest.totalElements, counts.mainUnique, 'Database main-object count mismatch');
    if (requireElements) assert.ok(counts.mainUnique > 0, 'No configured amenities imported');
    if (integrity) index.validate();
    // Rebuilds may record a newer local source than the original configured override.
    const candidates = [...new Set([state.sourcePbf, config.sourcePbf].filter(Boolean))];
    let sourcePbf = null;
    for (const candidate of candidates) {
      try {
        await fs.access(candidate, constants.R_OK);
        const stat = await fs.stat(candidate);
        if (stat.isFile() && stat.size > 0) { sourcePbf = candidate; break; }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
      }
    }
    assert.ok(sourcePbf, 'Retained source PBF is not readable; restore it or configure OSM_AMENITY_SOURCE_PBF');
    index.db.exec('COMMIT');
    return {
      ok: true, format: DATABASE_FORMAT, generation: manifest.generation,
      dataDir: root, elements: counts.mainUnique, supportObjects: counts.supportObjects,
      dataTimestamp: state.dataTimestamp, replication: state.replication,
      sourcePbf, integrityChecked: integrity
    };
  } finally { index.close(); }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let dataDir = null; let integrity = false; let requireElements = false;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--data-dir':
        dataDir = argv[++i];
        if (!dataDir || dataDir.startsWith('--')) throw new Error('--data-dir needs the active data/ directory');
        break;
      case '--integrity': integrity = true; break;
      case '--require-elements': requireElements = true; break;
      case '--help':
        console.log('Usage: node scripts/check-index.mjs [--data-dir /pipeline/data] [--integrity] [--require-elements]\nChecks SQLite metadata, configuration, cursor, counts and source readability.\n--integrity also scans database integrity; no source hashing or migration is performed.');
        return;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  const config = loadConfig({ ...env, ...(dataDir ? { OSM_AMENITY_DATA_DIR: dataDir } : {}) });
  const result = await checkIndex(config, { integrity, requireElements });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`Index check failed: ${error.message}`); process.exitCode = 1; });
}
