import { describe, expect, it } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { randomBytes } from 'node:crypto'; import { spawn, spawnSync } from 'node:child_process';
import { decodeElement, encodeElement, encodeId, parseId } from '../scripts/extract/lines.mjs';
import { stage1, stage1Chunk, stage2, stage3 } from '../scripts/extract/stages.mjs';
import { run } from '../scripts/extract/process.mjs';
import { runWorker, runWorkerMain, startWorker } from '../scripts/extract/worker.mjs';
import { main, osmiumNumObjects, runCli, runVerify, scanBlocks, parseBlobHeaderNew, readVarintFromBuffer } from '../scripts/extract.mjs';
import { pool, runPipeline } from '../scripts/extract/process.mjs';
import { validateStageManifest } from '../scripts/extract/stages.mjs';

describe('extract line format', () => {
  it('rejects malformed standard PBF framing and protobuf headers', () => {
    expect(() => readVarintFromBuffer(Buffer.from([0x80]), 0)).toThrow(/runs past end/);
    expect(() => parseBlobHeaderNew(Buffer.from([0x06]))).toThrow(/unsupported wire type/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-pbf-errors-'));
    try {
      const truncated = path.join(root, 'truncated.pbf'); fs.writeFileSync(truncated, Buffer.from([0, 0, 0, 8, 0x0a]));
      expect(() => scanBlocks(truncated)).toThrow(/truncated read/);
      const badWire = path.join(root, 'bad-wire.pbf'); fs.writeFileSync(badWire, Buffer.from([0, 0, 0, 1, 0x06]));
      expect(() => scanBlocks(badWire)).toThrow(/unsupported wire type/);
      const oversized = path.join(root, 'oversized.pbf'); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(65537); fs.writeFileSync(oversized, prefix);
      expect(() => scanBlocks(oversized)).toThrow(/unrecognised OSM PBF framing/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('roundtrips entity-decoded Unicode and encoded tags', () => {
    const e = { type: 'relation', id: 9, version: 2, timestamp: 13, changeset: 8, members: [{ type: 'way', ref: 12, role: '' }, { type: 'node', ref: 17, role: 'entrance & saída' }], tags: { amenity: 'toilets & café', 'é': '🗾=yes' }, nodeIds: [] };
    expect(decodeElement(encodeElement(e))).toEqual(e);
  });
  it('handles nodes, ways, empty tags, and ids', () => {
    const node = { type: 'node', id: 1, version: 0, timestamp: 0, changeset: 0, lat: 35.1234567, lon: 139.1, tags: {}, nodeIds: [], members: [] };
    expect(decodeElement(encodeElement(node))).toEqual(node);
    const way = { type: 'way', id: 2, nodeIds: [1, 3], tags: {}, members: [] };
    expect(decodeElement(encodeElement(way))).toMatchObject(way);
    expect(parseId(encodeId('node', 1))).toEqual({ type: 'node', id: 1 });
  });
  it('rejects malformed and unsafe line records without unbounded loops', () => {
    expect(() => decodeElement('W 1 1 0 0 7')).toThrow(/delimiter/);
    expect(() => decodeElement('N 1 1 0 0 999999999 0 -')).toThrow(/latitude/);
    expect(() => decodeElement('R 1 1 0 0 x:4:role -')).toThrow(/member/);
  });

  it('resolves global references across chunk boundaries and validates resumable outputs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-stage-test-'));
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin); const calls = path.join(root, 'calls');
    const fake = path.join(bin, 'osmium');
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs'); const a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, a[0]+'\\n');
if(a[0]==='cat'&&a.includes('--object-type=node')){const xml=fs.readFileSync(a[2],'utf8');for(const m of xml.matchAll(/<node\\b[^>]*>/g)){const tag=m[0],id=tag.match(/id="(\\d+)"/)[1],lat=tag.match(/lat="([^"]+)"/)[1],lon=tag.match(/lon="([^"]+)"/)[1];process.stdout.write('n'+id+' v1 dV c0 t x'+lon+' y'+lat+'\\n');}}
else if(a[0]==='cat'&&a.includes('-F')){process.stdout.write('<?xml version="1.0"?><osm version="0.6">');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{for(const row of input.trim().split(/\\n/)){if(!row)continue;const id=row.match(/^n(\\d+)/)[1],lon=row.match(/ x([^ ]+)/)[1],lat=row.match(/ y([^ ]+)/)[1];process.stdout.write('<node id="'+id+'" lat="'+lat+'" lon="'+lon+'"/>');}process.stdout.write('</osm>');});}
else if(a[0]==='cat'){fs.createReadStream(a[1]).pipe(process.stdout);process.exitCode=0;}
else if(a[0]==='getid'){const idfile=a[a.indexOf('-i')+1], type=a[a.indexOf('--default-type')+1], chunk=a[a.indexOf('--default-type')+2], out=a[a.indexOf('-o')+1]; const ids=new Set(fs.readFileSync(idfile,'utf8').trim().split(/\\s+/)); const xml=fs.readFileSync(chunk,'utf8'); const re=type==='way'?/<way\\b[^>]*>[\\s\\S]*?<\\/way>/g:/<node\\b[^>]*>[\\s\\S]*?<\\/node>/g; const rows=[...xml.matchAll(re)].map(x=>x[0]).filter(x=>ids.has(x.match(/id="(\\d+)"/)[1])); fs.writeFileSync(out,'<osm>'+rows.join('')+'</osm>');}
else process.exitCode=2;\n`); fs.chmodSync(fake, 0o755);
    const chunks = path.join(root, 'work/chunks'); fs.mkdirSync(chunks, { recursive: true });
    fs.writeFileSync(path.join(chunks, 'c0000.pbf'), '<osm><relation id="900" version="1"><member type="way" ref="500" role="outer"/><member type="node" ref="10" role="label"/><tag k="amenity" v="toilets"/></relation></osm>');
    fs.writeFileSync(path.join(chunks, 'c0001.pbf'), '<osm><node id="10" lat="35.1" lon="139.1"></node><node id="11" lat="35.2" lon="139.2"></node><way id="500"><nd ref="10"/><nd ref="11"/></way></osm>');
    fs.writeFileSync(path.join(root, 'work/manifest.json'), JSON.stringify({ complete: true, sourceFingerprint: 'fixture-a', chunks: [{ id: 'c0000' }, { id: 'c0001' }] }));
    const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    try {
      const opts = { root, workers: 2, workerRamMb: 64, allAmenities: true, amenities: ['toilets'], sourceFingerprint: 'fixture-a' };
      await stage1(opts); await stage2(opts); await stage3(opts);
      const amenFile = path.join(root, 'work/stage1/amen_c0000.lines');
      const amen = decodeElement(fs.readFileSync(amenFile, 'utf8').trim());
      expect(amen.members.map(m => m.ref)).toEqual([500, 10]);
      expect(decodeElement(fs.readFileSync(path.join(root, 'work/stage2/ways_c0001.lines'), 'utf8').trim()).id).toBe(500);
      expect(fs.readFileSync(path.join(root, 'work/stage3/nodes_c0001.lines'), 'utf8')).toContain(' 10 ');
      const initialCalls = fs.readFileSync(calls, 'utf8').trim().split('\n').length;
      await stage1(opts);
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(initialCalls);
      const original = fs.readFileSync(amenFile, 'utf8'); fs.writeFileSync(amenFile, original.replace('outer', 'other'));
      await stage1(opts);
      expect(fs.readFileSync(amenFile, 'utf8')).toBe(original);
      const altered = { ...opts, sourceFingerprint: 'fixture-b' }; fs.writeFileSync(path.join(root, 'work/manifest.json'), JSON.stringify({ complete: true, sourceFingerprint: 'fixture-b', chunks: [{ id: 'c0000' }, { id: 'c0001' }] })); await stage1(altered);
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n').length).toBeGreaterThan(initialCalls);
      expect(await runWorker(JSON.stringify({ ...opts, chunk: path.join(chunks, 'c0000.pbf'), sourceFingerprint: 'worker-direct' }))).toBe(true);
      expect(await runWorker({ ...opts, chunk: path.join(chunks, 'c0000.pbf'), sourceFingerprint: 'worker-direct' })).toBe(false);
    } finally { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('enforces worker process-tree RSS budgets', async () => {
    await expect(run(process.execPath, ['-e', 'const x=Buffer.alloc(160*1024*1024,1);setInterval(()=>{},1000)'], { maxRssMb: 80 })).rejects.toThrow(/exceeded 80 MiB RSS/);
  }, 10000);

  it('bounds captured native output, rejects command and pipeline failures, and validates pool arguments', async () => {
    const captured = await run(process.execPath, ['-e', 'process.stdout.write("abcdefghij"); process.stderr.write("klmnopqrst")'], { maxOutputBytes: 4 });
    expect(captured.stdout).toBe('ghij'); expect(captured.stderr).toBe('qrst');
    await expect(run('definitely-not-an-osmium-command', [])).rejects.toThrow();
    await expect(run(process.execPath, ['-e', 'process.stderr.write("bad");process.exit(7)'])).rejects.toThrow(/exited 7: bad/);
    await expect(pool([1, 2], 2, async value => { if (value === 2) throw new Error('task failed'); })).rejects.toThrow('task failed');
    expect(() => runPipeline([['cat', []]])).toThrow(/at least two/);
    const pipeline = runPipeline([['definitely-not-a-command-a', []], ['cat', []]]);
    await expect(pipeline.done).rejects.toThrow(/ENOENT|native pipeline command exited/);
  });

  it('rejects mismatched, empty, escaped, and tampered stage manifests', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-stage-manifest-'));
    const stageDir = path.join(root, 'work/stage1'); fs.mkdirSync(stageDir, { recursive: true });
    const output = path.join(stageDir, 'amen_c0000.lines'); fs.writeFileSync(output, 'ok\n');
    const { createHash } = await import('node:crypto');
    const manifestPath = path.join(stageDir, 'manifest.json');
    const outputRow = { file: 'work/stage1/amen_c0000.lines', size: 3, sha256: createHash('sha256').update('ok\n').digest('hex') };
    const write = (manifest: object) => fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const base = { stage: 1, sourceFingerprint: 'source', chunkIds: ['c0000'], outputs: [outputRow] };
    try {
      await expect(validateStageManifest(root, 1, 'source', ['c0000'])).rejects.toThrow(/missing or invalid/);
      write({ ...base, outputs: [] }); await expect(validateStageManifest(root, 1, 'source', ['c0000'])).rejects.toThrow(/no outputs/);
      write({ ...base, chunkIds: ['c0001'] }); await expect(validateStageManifest(root, 1, 'source', ['c0000'])).rejects.toThrow(/does not match/);
      write({ ...base, outputs: [{ ...outputRow, file: '../outside' }] }); await expect(validateStageManifest(root, 1, 'source', ['c0000'])).rejects.toThrow(/failed manifest validation/);
      write(base); fs.writeFileSync(output, 'tampered'); await expect(validateStageManifest(root, 1, 'source', ['c0000'])).rejects.toThrow(/failed manifest validation/);
      write({ ...base, sourceFingerprint: 'other' }); await expect(validateStageManifest(root, 1, 'source', ['c0000'])).rejects.toThrow(/does not match/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('stops child process groups on SIGINT', async () => {
    if (process.platform !== 'linux') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-abort-test-'));
    const worker = path.join(root, 'runner.mjs'); const pidFile = path.join(root, 'child.pid'); const processModule = new URL('../scripts/extract/process.mjs', import.meta.url).href;
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    fs.writeFileSync(worker, `import {run} from ${JSON.stringify(processModule)}; try { await run(process.execPath,['-e',${JSON.stringify(childCode)}]); } catch {}`);
    try {
      const runner = spawn(process.execPath, [worker], { stdio: 'ignore' });
      for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 50));
      const childPid = Number(fs.readFileSync(pidFile, 'utf8')); runner.kill('SIGINT');
      await new Promise((resolve, reject) => { runner.once('error', reject); runner.once('close', resolve); });
      expect(runner.exitCode).not.toBeNull();
      let terminated = false;
      for (let i = 0; i < 20; i++) {
        try { const stat = fs.readFileSync(`/proc/${childPid}/stat`, 'utf8'); if (stat.split(' ')[2] === 'Z') { terminated = true; break; } }
        catch { terminated = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(terminated).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 10000);

  it('splits standard PBF framing, verifies independent counts, and repairs a tampered resumed chunk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-stage0-test-'));
    try {
      const xml = path.join(root, 'tiny.osm'); const pbf = path.join(root, 'tiny.osm.pbf'); const data = path.join(root, 'pipeline');
      fs.writeFileSync(xml, '<osm version="0.6" generator="test"><node id="1" lat="35" lon="139" version="1"><tag k="amenity" v="toilets"/></node><node id="2" lat="35.1" lon="139.1" version="1"/><way id="3" version="1"><nd ref="1"/><nd ref="2"/></way><relation id="4" version="1"><member type="way" ref="3" role="outer"/></relation></osm>');
      const make = spawnSync('osmium', ['cat', xml, '-o', pbf, '--overwrite'], { encoding: 'utf8' });
      expect(make.status, make.stderr).toBe(0);
      const runCli = async (stages: string) => { const messages: string[] = []; await main(['--source', pbf, '--data-dir', data, '--stages', stages, '--chunk-mb', '1', '--verify'], { logger: (...parts: unknown[]) => messages.push(parts.join(' ')) }); return messages.join('\n'); };
      const first = await runCli('0'); expect(first).toContain('VERIFY OK');
      await main(['--source', pbf, '--data-dir', data, '--stages', '0-4', '--chunk-mb', '1', '--workers', '1', '--ram-mb', '1024', '--worker-ram-mb', '512', '--amenities', 'toilets'], { logger: () => {} });
      const built = JSON.parse(fs.readFileSync(path.join(data, 'data/manifest.json'), 'utf8'));
      expect(built.totalElements).toBe(1); expect(built.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      await main(['--data-dir', data, '--stages', '4', '--amenities', 'toilets'], { logger: () => {} });
      const workManifestPath = path.join(data, 'work/manifest.json'); const legacy = JSON.parse(fs.readFileSync(workManifestPath, 'utf8')); delete legacy.sourceFingerprint; delete legacy.complete; fs.writeFileSync(workManifestPath, JSON.stringify(legacy));
      const legacyResume = await runCli('0'); expect(legacyResume).toContain('upgrading validated legacy chunk manifest');
      expect(fs.existsSync(path.join(data, 'work/stage1/manifest.json'))).toBe(true);
      const chunk = path.join(data, 'work/chunks/c0000.pbf'); const original = fs.readFileSync(chunk); const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1; fs.writeFileSync(chunk, damaged);
      const resumed = await runCli('0'); expect(resumed).toContain('VERIFY OK');
      expect(fs.readFileSync(chunk)).toEqual(fs.readFileSync(pbf));
      const badXml = path.join(root, 'bad.osm'); const badPbf = path.join(root, 'bad.osm.pbf'); const badChunks = path.join(root, 'badchunks'); fs.mkdirSync(badChunks);
      fs.writeFileSync(badXml, '<osm version="0.6"><node id="99" lat="0" lon="0" version="1"/></osm>');
      const badMake = spawnSync('osmium', ['cat', badXml, '-o', badPbf, '--overwrite'], { encoding: 'utf8' }); expect(badMake.status, badMake.stderr).toBe(0);
      fs.copyFileSync(badPbf, path.join(badChunks, 'c0000.pbf'));
      expect(runVerify({ planetSource: pbf, chunksDir: badChunks, logger: () => {} })).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30000);

it('covers CLI preflight, abort, incomplete stage 0, and empty-PBF behavior', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-cli-branches-'));
  try {
    await expect(main(['--source', path.join(root, 'absent.pbf')], { logger: () => {} })).rejects.toThrow(/source not found/);
    const cliErrors: Error[] = [];
    expect(await runCli(['--source', path.join(root, 'absent.pbf')], { logger: () => {}, onError: (error: Error) => cliErrors.push(error) })).toBe(1);
    expect(cliErrors[0].message).toMatch(/source not found/);
    await expect(main(['--data-dir', path.join(root, 'no-source'), '--stages', '0'], { logger: () => {} })).rejects.toThrow(/--source <file.pbf> is required/);
    await expect(main(['--stages', '4', '--data-dir', path.join(root, 'missing')], { logger: () => {} })).rejects.toThrow(/no work\/manifest.json provenance/);
    const input = path.join(root, 'source.pbf'); fs.writeFileSync(input, 'placeholder');
    let stagesRun = 0;
    await main(['--source', input, '--data-dir', path.join(root, 'aborted'), '--stages', '0-1'], {
      logger: () => {}, sourceFingerprint: async () => 'fingerprint', sourceMetadata: () => ({ timestamp: null }),
      wasAborted: () => true, runStage0: async () => { stagesRun++; return { complete: true }; }
    });
    expect(stagesRun).toBe(0);
    let pollCount = 0;
    await main(['--source', input, '--data-dir', path.join(root, 'abort-after-stage'), '--stages', '1-2'], {
      logger: () => {}, sourceFingerprint: async () => 'fingerprint', sourceMetadata: () => ({ timestamp: null }),
      wasAborted: () => ++pollCount > 1, stage1: async () => { stagesRun++; }, stage2: async () => { stagesRun++; }
    });
    expect(stagesRun).toBe(1);
    stagesRun = 0;
    await main(['--source', input, '--data-dir', path.join(root, 'partial'), '--stages', '0-1'], {
      logger: () => {}, sourceFingerprint: async () => 'fingerprint', sourceMetadata: () => ({ timestamp: null }),
      runStage0: async () => ({ complete: false }), stage1: async () => { stagesRun++; }
    });
    expect(stagesRun).toBe(0);

    const stage4Data = path.join(root, 'stage4-errors'); fs.mkdirSync(path.join(stage4Data, 'work'), { recursive: true });
    const workManifest = path.join(stage4Data, 'work/manifest.json');
    const stage4 = () => main(['--source', input, '--data-dir', stage4Data, '--stages', '4'], {
      logger: () => {}, sourceFingerprint: async () => 'fingerprint', sourceMetadata: () => ({ timestamp: null })
    });
    fs.writeFileSync(workManifest, JSON.stringify({ complete: false, sourceFingerprint: 'fingerprint', chunks: [{ id: 'c0000' }] }));
    await expect(stage4()).rejects.toThrow(/manifest is incomplete/);
    fs.writeFileSync(workManifest, JSON.stringify({ complete: true, sourceFingerprint: 'other', chunks: [{ id: 'c0000' }] }));
    await expect(stage4()).rejects.toThrow(/source differs/);
    fs.writeFileSync(workManifest, JSON.stringify({ complete: true, sourceFingerprint: 'fingerprint', chunks: [] }));
    await expect(stage4()).rejects.toThrow(/no expected chunks/);

    const emptyXml = path.join(root, 'empty.osm'); const emptyPbf = path.join(root, 'empty.pbf'); const emptyData = path.join(root, 'empty-data');
    fs.writeFileSync(emptyXml, '<osm version="0.6"></osm>');
    const generated = spawnSync('osmium', ['cat', emptyXml, '-o', emptyPbf], { encoding: 'utf8' });
    expect(generated.status, generated.stderr).toBe(0);
    await main(['--source', emptyPbf, '--data-dir', emptyData, '--stages', '0', '--chunk-mb', '1'], { logger: () => {} });
    const manifest = JSON.parse(fs.readFileSync(path.join(emptyData, 'work/manifest.json'), 'utf8'));
    expect(manifest.complete).toBe(true); expect(manifest.chunks).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);

it('handles populated chunks with empty amenity-reference sets and defers chunk deletion to Stage 3', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-no-refs-'));
  try {
    const xml = path.join(root, 'nodes.osm'); const source = path.join(root, 'nodes.pbf'); const data = path.join(root, 'pipeline');
    fs.writeFileSync(xml, '<osm version="0.6"><node id="1" lat="35" lon="139"/><node id="2" lat="36" lon="140"/></osm>');
    const made = spawnSync('osmium', ['cat', xml, '-o', source], { encoding: 'utf8' }); expect(made.status, made.stderr).toBe(0);
    await main(['--source', source, '--data-dir', data, '--stages', '0-3', '--chunk-mb', '1', '--workers', '1', '--ram-mb', '1024', '--worker-ram-mb', '512', '--keep-chunks', 'false'], { logger: () => {} });
    expect(fs.statSync(path.join(data, 'work/stage3/node-ids.txt')).size).toBe(0);
    expect(fs.statSync(path.join(data, 'work/stage3/nodes_c0000.lines')).size).toBe(0);
    expect(fs.existsSync(path.join(data, 'work/chunks'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);

it('backpressures Stage 1 line and reference streams for a dense amenity way', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-stage1-backpressure-'));
  try {
    const xml = path.join(root, 'dense.osm'); const chunk = path.join(root, 'dense.pbf');
    const refs = Array.from({ length: 4000 }, (_, i) => `<nd ref="${i + 1}"/>`).join('');
    fs.writeFileSync(xml, `<osm version="0.6"><way id="9000">${refs}<tag k="amenity" v="toilets"/></way></osm>`);
    const made = spawnSync('osmium', ['cat', xml, '-o', chunk], { encoding: 'utf8', timeout: 30000 }); expect(made.status, made.stderr).toBe(0);
    await expect(stage1Chunk({ root, chunk, allAmenities: false, amenities: ['toilets'], sourceFingerprint: 'dense' })).resolves.toBe(true);
    expect(fs.readFileSync(path.join(root, 'work/stage1/ids_dense.lines'), 'utf8').trim().split('\n')).toHaveLength(4000);
    expect(fs.readFileSync(path.join(root, 'work/stage1/amen_dense.lines'), 'utf8').length).toBeGreaterThan(16 * 1024);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);

  it('invalidates stale stage data when the source changes to fewer expected chunks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-source-switch-'));
    try {
      const makeHuge = (id: number, suffix: string) => {
        const xml = path.join(root, `${suffix}.osm`); const pbf = path.join(root, `${suffix}.pbf`);
        const objects = Array.from({ length: 8000 }, (_, i) => `<node id="${id + i}" lat="35" lon="139"><tag k="name" v="${randomBytes(120).toString('hex')}"/></node>`).join('');
        fs.writeFileSync(xml, `<osm version="0.6">${objects}</osm>`);
        const made = spawnSync('osmium', ['cat', xml, '-o', pbf, '--overwrite'], { encoding: 'utf8', timeout: 30000 });
        expect(made.status, made.stderr).toBe(0); return pbf;
      };
      const first = makeHuge(10, 'one'); const second = makeHuge(11, 'two');
      const blockList = (file: string) => {
        const bytes = fs.readFileSync(file); const blocks: Buffer[] = []; let at = 0;
        const varint = (buf: Buffer, start: number) => { let n = 0; let shift = 0; let i = start; while (true) { const b = buf[i++]; n += (b & 127) * 2 ** shift; if (!(b & 128)) return [n, i]; shift += 7; } };
        while (at < bytes.length) { const header = bytes.readUInt32BE(at); const body = bytes.subarray(at + 4, at + 4 + header); let p = 0; let blob = 0; while (p < body.length) { const [tag, next] = varint(body, p); p = next; if ((tag & 7) === 0) { const [value, after] = varint(body, p); p = after; if ((tag >>> 3) === 3) blob = value; } else if ((tag & 7) === 2) { const [size, after] = varint(body, p); p = after + size; } else throw new Error('unexpected PBF header field'); } const length = 4 + header + blob; blocks.push(bytes.subarray(at, at + length)); at += length; }
        return blocks;
      };
      const firstBlocks = blockList(first); const secondBlocks = blockList(second);
      const sourceA = path.join(root, 'source-a.pbf'); const sourceB = path.join(root, 'source-b.pbf'); const data = path.join(root, 'pipeline');
      fs.writeFileSync(sourceA, Buffer.concat([firstBlocks[0], firstBlocks[1], secondBlocks[1]]));
      fs.writeFileSync(sourceB, Buffer.concat([firstBlocks[0], firstBlocks[1]]));
      const run = async (source: string) => { const messages: string[] = []; await main(['--source', source, '--data-dir', data, '--stages', '0', '--chunk-mb', '1', '--verify'], { logger: (...parts: unknown[]) => messages.push(parts.join(' ')) }); return messages.join('\n'); };
      const a = await run(sourceA); expect(a).toContain('VERIFY OK');
      expect(JSON.parse(fs.readFileSync(path.join(data, 'work/manifest.json'), 'utf8')).chunks).toHaveLength(2);
      const originalFingerprint = JSON.parse(fs.readFileSync(path.join(data, 'work/manifest.json'), 'utf8')).sourceFingerprint;
      fs.mkdirSync(path.join(data, 'work/stage1'), { recursive: true }); fs.writeFileSync(path.join(data, 'work/stage1/amen_c0001.lines'), 'stale');
      const b = await run(sourceB); expect(b).toContain('VERIFY OK');
      const manifest = JSON.parse(fs.readFileSync(path.join(data, 'work/manifest.json'), 'utf8'));
      expect(manifest.chunks).toHaveLength(1); expect(manifest.sourceFingerprint).not.toBe(originalFingerprint);
      expect(fs.existsSync(path.join(data, 'work/stage1/amen_c0001.lines'))).toBe(false);
      expect(fs.readdirSync(path.join(data, 'work/chunks')).filter(name => /^c\d+\.pbf$/.test(name))).toEqual(['c0000.pbf']);
      fs.mkdirSync(path.join(data, 'work/stage1'), { recursive: true }); fs.writeFileSync(path.join(data, 'work/stage1/ids_c0000.lines'), 'W 99999999\n');
      await stage2({ root: data, workers: 1, workerRamMb: 128, sourceFingerprint: manifest.sourceFingerprint });
      expect(fs.readFileSync(path.join(data, 'work/stage2/ways_c0000.xml'), 'utf8')).toMatch(/<\/osm>/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 60000);
});
  it('validates worker inputs before processing', async () => {
    await expect(runWorker('')).rejects.toThrow(/requires its JSON work item/);
    await expect(runWorker('{broken json')).rejects.toThrow();
    const errors: Error[] = [];
    expect(await runWorkerMain('', error => errors.push(error))).toBe(1);
    expect(errors).toHaveLength(1);
    expect(await startWorker(['node', '/tmp/other.mjs', ''], import.meta.url, () => {})).toBeNull();
    const workerPath = path.resolve('scripts/extract/worker.mjs');
    expect(await startWorker(['node', workerPath, ''], new URL('../scripts/extract/worker.mjs', import.meta.url).href, () => {})).toBe(1);
  });
  it('cleans failed XML conversion outputs and rejects missing stage work units', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-stage-errors-'));
    try {
      const chunk = path.join(root, 'work/chunks/c0000.pbf'); fs.mkdirSync(path.dirname(chunk), { recursive: true }); fs.writeFileSync(chunk, 'not a PBF');
      await expect(stage1Chunk({ root, chunk, allAmenities: true, amenities: ['toilets'], sourceFingerprint: 'bad' })).rejects.toThrow();
      expect(fs.existsSync(path.join(root, 'work/stage1/amen_c0000.lines.tmp-' + process.pid))).toBe(false);
      await expect(stage1({ root, workers: 1, allAmenities: true, amenities: [], sourceFingerprint: 'missing' })).rejects.toThrow(/Stage 0 manifest is missing/);
      fs.mkdirSync(path.join(root, 'work'), { recursive: true }); fs.writeFileSync(path.join(root, 'work/manifest.json'), JSON.stringify({ complete: false, chunks: [] }));
      await expect(stage2({ root, workers: 1 })).rejects.toThrow(/incomplete/);
      await expect(stage3({ root, workers: 1 })).rejects.toThrow(/incomplete/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('filters selected amenity values and emits only supported way and relation references', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-stage1-filter-'));
    try {
      const xml = path.join(root, 'filtered.osm'); const chunk = path.join(root, 'c0000.pbf');
      fs.writeFileSync(xml, '<osm version="0.6"><node id="1" lat="1" lon="1"><tag k="amenity" v="toilets"/></node><node id="2" lat="2" lon="2"><tag k="amenity" v="bench"/></node><way id="3"><nd ref="1"/><nd ref="2"/><tag k="amenity" v="toilets"/></way><relation id="4"><member type="way" ref="3" role="outer"/><member type="node" ref="1" role="label"/><member type="relation" ref="8" role="subarea"/><tag k="amenity" v="toilets"/></relation></osm>');
      const made = spawnSync('osmium', ['cat', xml, '-o', chunk], { encoding: 'utf8' }); expect(made.status, made.stderr).toBe(0);
      expect(await stage1Chunk({ root, chunk, allAmenities: false, amenities: ['toilets'], sourceFingerprint: 'filter' })).toBe(true);
      const lines = fs.readFileSync(path.join(root, 'work/stage1/ids_c0000.lines'), 'utf8').trim().split('\n').sort();
      expect(lines).toEqual(['N 1', 'N 1', 'N 2', 'W 3']);
      const amenities = fs.readFileSync(path.join(root, 'work/stage1/amen_c0000.lines'), 'utf8').trim().split('\n').map(decodeElement);
      expect(amenities.map(e => `${e.type}:${e.id}`)).toEqual(['node:1', 'way:3', 'relation:4']);
      expect(await stage1Chunk({ root, chunk, allAmenities: false, amenities: ['toilets'], sourceFingerprint: 'filter' })).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects malformed XML from native getid before downstream indexing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-getid-xml-error-'));
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin); const fake = path.join(bin, 'osmium');
    fs.writeFileSync(fake, `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='getid')fs.writeFileSync(a[a.indexOf('-o')+1],'<wrong/>');else process.exitCode=2;\n`); fs.chmodSync(fake, 0o755);
    const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    try {
      const chunk = path.join(root, 'work/chunks/c0000.pbf'); fs.mkdirSync(path.dirname(chunk), { recursive: true }); fs.writeFileSync(chunk, 'fixture');
      fs.writeFileSync(path.join(root, 'work/manifest.json'), JSON.stringify({ complete: true, sourceFingerprint: 'fp', chunks: [{ id: 'c0000' }] }));
      fs.mkdirSync(path.join(root, 'work/stage1'), { recursive: true }); fs.writeFileSync(path.join(root, 'work/stage1/ids_c0000.lines'), 'W 1\n');
      await expect(stage2({ root, workers: 1, workerRamMb: 128, sourceFingerprint: 'fp' })).rejects.toThrow(/malformed OSM XML/);
    } finally { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('does not mask osmium count failures', () => {
    expect(() => osmiumNumObjects('/missing/osm-source.pbf')).toThrow(/osmium fileinfo failed/);
  });
  it('counts valid way-only and relation-only PBF chunks despite Osmium 1.14 JSON bbox errors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-count-types-'));
    try {
      for (const [name, xml, expected] of [
        ['ways', '<osm version="0.6"><way id="1"><nd ref="2"/></way></osm>', { nodes: 0, ways: 1, relations: 0 }],
        ['relations', '<osm version="0.6"><relation id="1"><member type="way" ref="2" role="outer"/></relation></osm>', { nodes: 0, ways: 0, relations: 1 }]
      ] as const) {
        const source = path.join(root, `${name}.osm`); const pbf = path.join(root, `${name}.pbf`); fs.writeFileSync(source, xml);
        const made = spawnSync('osmium', ['cat', source, '-o', pbf], { encoding: 'utf8' }); expect(made.status, made.stderr).toBe(0);
        expect(osmiumNumObjects(pbf)).toEqual(expected);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('resolves high OSM node IDs through bounded Stage 3 streaming merge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-high-node-id-'));
    try {
      const xml = path.join(root, 'high.osm'); const pbf = path.join(root, 'high.pbf'); const data = path.join(root, 'pipeline');
      fs.writeFileSync(xml, '<osm version="0.6"><node id="14000000001" lat="35" lon="139"/><node id="14000000002" lat="35.1" lon="139.1"/><way id="10"><nd ref="14000000001"/><nd ref="14000000002"/><tag k="amenity" v="toilets"/></way></osm>');
      const made = spawnSync('osmium', ['cat', xml, '-o', pbf], { encoding: 'utf8' }); expect(made.status, made.stderr).toBe(0);
      await main(['--source', pbf, '--data-dir', data, '--stages', '0-4', '--chunk-mb', '1', '--workers', '1', '--ram-mb', '1024', '--worker-ram-mb', '512', '--amenities', 'toilets'], { logger: () => {} });
      const nodes = fs.readFileSync(path.join(data, 'work/stage3/nodes_c0000.lines'), 'utf8');
      expect(nodes).toContain('N 14000000001 '); expect(nodes).toContain('N 14000000002 ');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30000);
