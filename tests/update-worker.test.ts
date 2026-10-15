import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createUpdateWorker } from '../scripts/update.mjs';

const replication = { baseUrl: 'https://planet.openstreetmap.org/replication', kind: 'planet', interval: 'minute' } as const;

async function setup(cursor = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-worker-'));
  const sourcePbf = path.join(root, 'retained.osm.pbf');
  await fs.writeFile(sourcePbf, 'retained source');
  const sourceFingerprint = createHash('sha256').update('retained source').digest('hex');
  const generation = path.join(root, 'data-generations', 'active');
  await fs.mkdir(generation, { recursive: true });
  await fs.writeFile(path.join(generation, 'state.json'), JSON.stringify({
    lastSeq: cursor, sourcePbf, sourceFingerprint,
    replication: { ...replication, sequenceNumber: cursor }
  }));
  await fs.symlink(path.relative(root, generation), path.join(root, 'data'), 'dir');
  return root;
}

const makeWorker = (root: string, overrides: object = {}) => createUpdateWorker({
  pipelineDir: root, replication, fetchState: async () => ({ sequenceNumber: 3, timestamp: '2026-10-15T00:00:00Z', originalPlanetSequence: 7329040 }),
  download: async (_replication: unknown, sequence: number, destination: string) => {
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, String(sequence));
    return { bytes: 1 };
  }, apply: async (_root: string, _first: string, options: Record<string, unknown>) => ({ sequence: options.sequence, changedCount: 2, cells: ['abc'] }),
  checkReextract: async () => null, onLog: () => {}, onError: () => {}, ...overrides
} as never);

describe('importable update worker', () => {
  it('downloads an ordered contiguous sequence and applies it once with provenance', async () => {
    const root = await setup(); const order: number[] = []; let applied: Record<string, unknown> | undefined;
    try {
      const worker = makeWorker(root, {
        fetchState: async () => ({ sequenceNumber: 3, timestamp: '2026-10-15T00:00:00Z', originalPlanetSequence: 7329040 }),
        download: async (_namespace: unknown, sequence: number, destination: string) => {
          order.push(sequence); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, 'diff'); return { bytes: 4 };
        },
        apply: async (_pipeline: string, _first: string, options: Record<string, unknown>) => { applied = options; return { changedCount: 2, cells: ['abc'] }; }
      });
      const result = await worker.runOnce();
      expect(order).toEqual([2, 3]);
      expect(applied).toMatchObject({ sequence: 3, replication: { ...replication, originalMinuteSeq: 7329040 } });
      expect(result).toMatchObject({ fromSequence: 2, toSequence: 3, changedCount: 2 });
      await expect(fs.readdir(path.join(root, 'work', 'update-diffs'))).resolves.toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('fails closed for an unknown active sequence and a different replication namespace', async () => {
    const zero = await setup(0);
    try {
      const fetchState = vi.fn();
      await expect(makeWorker(zero, { fetchState }).runOnce()).rejects.toThrow(/refusing catch-up from zero/);
      expect(fetchState).not.toHaveBeenCalled();
    } finally { await fs.rm(zero, { recursive: true, force: true }); }
    const mismatch = await setup();
    try {
      await expect(makeWorker(mismatch, { replication: { ...replication, baseUrl: 'https://other.invalid/replication' } }).runOnce())
        .rejects.toThrow(/does not match/);
    } finally { await fs.rm(mismatch, { recursive: true, force: true }); }
  });

  it('rejects an excessive gap before downloading any diff', async () => {
    const root = await setup();
    try {
      const download = vi.fn();
      await expect(makeWorker(root, { fetchState: async () => ({ sequenceNumber: 100, timestamp: null }), maxDiffs: 5, download }).runOnce())
        .rejects.toThrow(/exceeds the 5-diff update limit/);
      expect(download).not.toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('returns cleanly when the remote cursor is current and rejects a regressed cursor', async () => {
    const root = await setup();
    try {
      const download = vi.fn();
      await expect(makeWorker(root, { fetchState: async () => ({ sequenceNumber: 1 }), download }).runOnce())
        .resolves.toMatchObject({ fromSequence: 1, toSequence: 1, changedCount: 0 });
      expect(download).not.toHaveBeenCalled();
      await expect(makeWorker(root, { fetchState: async () => ({ sequenceNumber: 0 }) }).runOnce())
        .rejects.toThrow(/replication source regressed/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('cleans downloaded diffs when the byte cap or apply step fails', async () => {
    const root = await setup();
    try {
      const download = async (_namespace: unknown, sequence: number, destination: string) => {
        await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, 'diff');
        return { bytes: sequence === 2 ? 3 : 1 };
      };
      await expect(makeWorker(root, { download, maxDiffBytes: 2 }).runOnce()).rejects.toThrow(/compressed bytes/);
      await expect(fs.readdir(path.join(root, 'work', 'update-diffs'))).resolves.toEqual([]);
      await expect(makeWorker(root, { download, apply: async () => { throw new Error('apply broke'); } }).runOnce())
        .rejects.toThrow('apply broke');
      await expect(fs.readdir(path.join(root, 'work', 'update-diffs'))).resolves.toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('continues the watch loop after update and weekly-check errors, then shuts down on abort', async () => {
    const root = await setup();
    try {
      const errors: string[] = []; const checks = vi.fn(); const controller = new AbortController();
      let fetchCount = 0;
      const worker = makeWorker(root, {
        fetchState: async () => {
          fetchCount += 1;
          if (fetchCount === 1) throw new Error('temporary network error');
          return { sequenceNumber: 1 };
        },
        checkReextract: async () => {
          checks();
          if (checks.mock.calls.length === 1) throw new Error('temporary rebuild error');
          controller.abort(new Error('stop watch'));
          return null;
        },
        onError: (error: Error) => errors.push(error.message)
      });
      await worker.runWatch({ signal: controller.signal, checkIntervalSeconds: 0 });
      expect(fetchCount).toBe(2);
      expect(checks).toHaveBeenCalledTimes(2);
      expect(errors).toEqual(['temporary network error', 'temporary rebuild error']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('uses the new generation source after weekly re-extract even if configuration still names the old PBF', async () => {
    const root = await setup();
    try {
      const oldSource = path.join(root, 'old.pbf'); const newSource = path.join(root, 'new.pbf');
      await fs.writeFile(oldSource, 'old source'); await fs.writeFile(newSource, 'new source');
      const hash = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
      const statePath = path.join(root, 'data/state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      state.sourcePbf = newSource; state.sourceFingerprint = await hash(newSource);
      await fs.writeFile(statePath, JSON.stringify(state));
      const applyCalls: Record<string, unknown>[] = [];
      const worker = makeWorker(root, {
        sourcePbf: oldSource,
        apply: async (_pipeline: string, _first: string, options: Record<string, unknown>) => { applyCalls.push(options); return { changedCount: 1, cells: [] }; }
      });
      await worker.runOnce();
      expect(applyCalls[0]).toMatchObject({ sourcePbf: newSource, sourcePbfFingerprint: state.sourceFingerprint });
      // A process restart has the same stale configured path but must resolve B
      // from the active generation instead of permanently failing its startup.
      await makeWorker(root, { sourcePbf: oldSource }).runOnce();
      expect(applyCalls).toHaveLength(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('uses a matching mounted override when the generation-recorded host path is unavailable', async () => {
    const root = await setup();
    try {
      const statePath = path.join(root, 'data/state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      const mounted = path.join(root, 'retained.osm.pbf');
      state.sourcePbf = '/host/build/source.osm.pbf';
      await fs.writeFile(statePath, JSON.stringify(state));
      const calls: Record<string, unknown>[] = [];
      await makeWorker(root, { sourcePbf: mounted, apply: async (_pipeline: string, _first: string, options: Record<string, unknown>) => {
        calls.push(options); return { changedCount: 0, cells: [] };
      } }).runOnce();
      expect(calls[0]).toMatchObject({ sourcePbf: mounted, sourcePbfFingerprint: state.sourceFingerprint });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('honors abort before network work and exits watch promptly during its wait', async () => {
    const root = await setup();
    try {
      const controller = new AbortController(); controller.abort(new Error('stop now'));
      const fetchState = vi.fn();
      await expect(makeWorker(root, { fetchState }).runOnce(controller.signal)).rejects.toThrow('stop now');
      expect(fetchState).not.toHaveBeenCalled();
      const watchController = new AbortController();
      const worker = makeWorker(root, { checkReextract: async () => { watchController.abort(new Error('shutdown')); return null; } });
      await worker.runWatch({ signal: watchController.signal, checkIntervalSeconds: 3600 });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
