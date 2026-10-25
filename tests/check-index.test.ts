import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkIndex } from '../scripts/check-index.mjs';
import { buildIndex } from '../scripts/extract/assembly.mjs';
import { encodeElement } from '../scripts/extract/lines.mjs';
import { IndexDatabase } from '../src/index/database.js';
import { loadConfig } from '../src/config.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const replication = { baseUrl: 'https://planet.example/minute', kind: 'planet', interval: 'minute', sequenceNumber: 31 };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commission-sqlite-')); roots.push(root);
  const source = path.join(root, 'source.pbf');
  await fs.writeFile(source, 'unchanged source bytes; the checker does not parse or hash PBFs');
  const input = path.join(root, 'work/stage1'); await fs.mkdir(input, { recursive: true });
  await fs.writeFile(path.join(input, 'amen_c0000.lines'), encodeElement({ type: 'node', id: 1, version: 1, lat: 35, lon: 139, tags: { amenity: 'toilets' } }) + '\n');
  await buildIndex({ pipelineDir: root, source, sourceFingerprint: createHash('sha256').update(await fs.readFile(source)).digest('hex'), sourceTimestamp: '2026-10-14T00:00:00Z', replication, logger: () => {} });
  const env = { OSM_AMENITY_DATA_DIR: path.join(root, 'data'), OSM_AMENITY_UPDATE_BASE_URL: replication.baseUrl, OSM_AMENITY_AMENITIES: 'toilets' };
  const config = loadConfig(env);
  const mutate = (fn: (db: IndexDatabase) => void) => { const db = new IndexDatabase(config.dataDir); try { fn(db); } finally { db.close(); } };
  return { root, source, env, config, mutate };
}

describe('SQLite commissioning and startup check', () => {
  it('checks authoritative metadata and optionally full integrity while ignoring stale sidecars', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.config.dataDir, 'manifest.json'), '{}');
    await fs.writeFile(path.join(f.config.dataDir, 'state.json'), '{}');
    expect(await checkIndex(f.config)).toMatchObject({ ok: true, format: 'OAM-SQLITE-1', elements: 1, integrityChecked: false, replication: { sequenceNumber: 31 } });
    expect(await checkIndex(f.config, { integrity: true, requireElements: true })).toMatchObject({ integrityChecked: true });
    const result = spawnSync(process.execPath, ['scripts/check-index.mjs', '--integrity', '--require-elements'], { env: { ...process.env, ...f.env }, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, elements: 1, integrityChecked: true });
  });
  it('rejects legacy format, mismatched server config, unknown flags and missing arguments', async () => {
    const f = await fixture();
    await expect(checkIndex({ ...f.config, amenities: ['drinking_water'] })).rejects.toThrow(/Amenity configuration mismatch/);
    await expect(checkIndex({ ...f.config, updateBaseUrl: 'https://other.example/minute' })).rejects.toThrow(/Replication URL mismatch/);
    await expect(checkIndex({ ...f.config, shardPrecision: 6 })).rejects.toThrow(/Compatibility precision mismatch/);
    const legacy = path.join(f.root, 'legacy'); await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'manifest.json'), '{"format":"OAM1"}');
    await expect(checkIndex({ ...f.config, dataDir: legacy })).rejects.toThrow(/No migration is provided/);
    for (const args of [['--unknown'], ['--data-dir'], ['--data-dir', '--integrity']]) {
      const result = spawnSync(process.execPath, ['scripts/check-index.mjs', ...args], { encoding: 'utf8' });
      expect(result.status).toBe(1); expect(result.stderr).toContain('Index check failed');
    }
  });
  it('rejects invalid cursor, timestamp, source fingerprint and missing retained source', async () => {
    const f = await fixture();
    let original: Record<string, any>;
    f.mutate(db => { original = db.getMetadata('state')!; });
    for (const [state, error] of [
      [{ ...original!, replication: { ...replication, sequenceNumber: 0 } }, /positive namespace-local/],
      [{ ...original!, lastSeq: 30 }, /Planet minute cursor mismatch/],
      [{ ...original!, dataTimestamp: 'invalid' }, /valid data timestamp/],
      [{ ...original!, sourceFingerprint: null }, /source fingerprint/]
    ] as const) {
      f.mutate(db => db.setMetadata('state', state));
      await expect(checkIndex(f.config)).rejects.toThrow(error);
    }
    f.mutate(db => db.setMetadata('state', original!));
    await fs.rm(f.source);
    await expect(checkIndex(f.config)).rejects.toThrow(/Retained source PBF is not readable/);
    const override = path.join(f.root, 'mounted.pbf'); await fs.writeFile(override, 'source mounted at another path');
    expect(await checkIndex({ ...f.config, sourcePbf: override })).toMatchObject({ sourcePbf: override });
  });
  it('detects broken spatial counts during commissioning without scanning on every startup', async () => {
    const f = await fixture();
    f.mutate(db => db.db.exec('DELETE FROM spatial'));
    await expect(checkIndex(f.config, { integrity: true })).rejects.toThrow(/spatial index count mismatch/);
  });
});
