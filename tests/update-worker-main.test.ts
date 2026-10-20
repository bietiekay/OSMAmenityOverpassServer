import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { main, runOnce, runWatch } from '../scripts/update.mjs';

const replication = { baseUrl: 'https://download.geofabrik.de/asia/japan-updates', kind: 'regional', interval: 'day' };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function localFeed(sequence: number, onRequest: (path: string) => void = () => {}) {
  const server = http.createServer((request, response) => {
    onRequest(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`sequenceNumber=${sequence}\ntimestamp=2026-10-15T00:00:00Z\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local replication feed has no TCP port');
  return { baseUrl: `http://127.0.0.1:${address.port}/replication/minute`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

describe('update worker public entry points', () => {
  it('loads CLI configuration and resolves the pipeline root from its data link', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-entry-'));
    const requests: string[] = [];
    const feed = await localFeed(5, (url) => requests.push(url));
    try {
      const generation = path.join(root, 'generation');
      await fs.mkdir(generation);
      await fs.writeFile(path.join(generation, 'state.json'), JSON.stringify({ replication: { baseUrl: feed.baseUrl, kind: 'planet', interval: 'minute', sequenceNumber: 5 } }));
      await fs.symlink(generation, path.join(root, 'data'));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await main(['--data-dir', path.join(root, 'data')], {
        OSM_AMENITY_UPDATE_BASE_URL: feed.baseUrl,
        OSM_AMENITY_SOURCE_PBF: '/mounted/baseline.pbf',
        OSM_AMENITY_REEXTRACT_SOURCE_PBF: '/mounted/new-snapshot.pbf'
      });
      expect(result).toMatchObject({ fromSequence: 5, toSequence: 5, changedCount: 0 });
      expect(requests).toEqual(['/replication/minute/state.txt']);
      expect(console.log).toHaveBeenCalledWith('up to date at 5');
    } finally { await feed.close(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it('offers one-shot and cancellation-safe watch APIs without launching a subprocess', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-public-'));
    try {
      await fs.mkdir(path.join(root, 'data'));
      await fs.writeFile(path.join(root, 'data/state.json'), JSON.stringify({ replication: { ...replication, sequenceNumber: 2 } }));
      const options = { pipelineDir: root, replication, onLog: vi.fn(),
        fetchState: async () => ({ sequenceNumber: 2, timestamp: '2026-10-15T00:00:00Z' }) };
      expect(await runOnce(options)).toMatchObject({ toSequence: 2 });
      const controller = new AbortController(); controller.abort();
      await expect(runWatch(options, { signal: controller.signal })).resolves.toBeUndefined();
      await expect(main([], { OSM_AMENITY_DATA_DIR: root, OSM_AMENITY_UPDATE_BASE_URL: replication.baseUrl, PORT: 'invalid' })).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('handles a real watch shutdown request and removes its process signal listeners', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-main-watch-'));
    const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
    const feed = await localFeed(2, () => queueMicrotask(() => process.emit('SIGTERM')));
    try {
      await fs.mkdir(path.join(root, 'data'));
      await fs.writeFile(path.join(root, 'data/state.json'), JSON.stringify({ replication: { baseUrl: feed.baseUrl, kind: 'planet', interval: 'minute', sequenceNumber: 2 } }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await main(['--watch'], { OSM_AMENITY_DATA_DIR: path.join(root, 'data'), OSM_AMENITY_UPDATE_BASE_URL: feed.baseUrl });
      expect(process.listenerCount('SIGINT')).toBe(beforeInt);
      expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    } finally { await feed.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
