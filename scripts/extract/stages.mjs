import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto'; import readline from 'node:readline';
import { parseOsmElements } from './xml.mjs'; import { encodeElement, encodeId } from './lines.mjs'; import { run, runPipeline, pool, registerChild } from './process.mjs';
import { createProgress } from './progress.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
async function fileHash(file) { const h = createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
async function* readLines(file) { const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity }); for await (const line of rl) if (line) yield line; }
const files = (dir, re) => fs.readdirSync(dir).filter(x => re.test(x)).sort().map(x => path.join(dir, x));
async function xmlToLines(source, outfile, select) {
  const tmp = `${outfile}.tmp-${process.pid}`; fs.mkdirSync(path.dirname(outfile), { recursive: true }); const out = fs.createWriteStream(tmp);
  let child;
  try { child = (await import('node:child_process')).spawn('osmium', ['cat', source, '-f', 'osm'], { stdio: ['ignore', 'pipe', 'inherit'] }); registerChild(child); const closed = new Promise(resolve => { child.once('error', error => resolve({ error })); child.once('close', code => resolve({ code })); });
    for await (const e of parseOsmElements(child.stdout)) { const line = await select(e); if (line) { if (!out.write(`${line}\n`)) await new Promise(r => out.once('drain', r)); } }
    const result = await closed; if (result.error) throw result.error; if (result.code !== 0) throw new Error(`osmium cat exited ${result.code}`);
    await new Promise((r, j) => out.end(e => e ? j(e) : r())); fs.renameSync(tmp, outfile);
  } catch (e) { child?.kill('SIGTERM'); out.destroy(); try { fs.unlinkSync(tmp); } catch {} throw e; }
}
async function writeLines(outfile, iterable) { const tmp = `${outfile}.tmp-${process.pid}`; const out = fs.createWriteStream(tmp); for await (const line of iterable) if (!out.write(`${line}\n`)) await new Promise(r => out.once('drain', r)); await new Promise((r, j) => out.end(e => e ? j(e) : r())); fs.renameSync(tmp, outfile); }
async function validateOsmXml(file) { let count = 0; for await (const _element of parseOsmElements(fs.createReadStream(file))) count++; const fd = fs.openSync(file, 'r'); try { const size = fs.fstatSync(fd).size; const head = Buffer.alloc(Math.min(size, 4096)); fs.readSync(fd, head, 0, head.length, 0); const tail = Buffer.alloc(Math.min(size, 4096)); fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length)); const textHead = head.toString('utf8'); const textTail = tail.toString('utf8'); if (!/<osm\b/.test(textHead) || !/<\/osm\s*>\s*$/.test(textTail)) throw new Error(`osmium produced malformed OSM XML: ${file}`); } finally { fs.closeSync(fd); } return count; }
async function mergeNodeIds(chunk, idfile, output, workerRamMb) {
  const awk = 'BEGIN { if ((getline want < idfile) <= 0) want="" } { id=$1; sub(/^n/,"",id); if (seen && (id+0) < (previous+0)) { print "node stream is not ID-sorted" > "/dev/stderr"; exit 42 }; previous=id; seen=1; while (want != "" && (want+0) < (id+0)) { if ((getline want < idfile) <= 0) want="" }; if (want != "" && (want+0)==(id+0)) print }';
  const pipe = runPipeline([
    ['osmium', ['cat', '--object-type=node', chunk, '-f', 'opl']],
    ['awk', ['-v', `idfile=${idfile}`, awk]],
    ['osmium', ['cat', '-F', 'opl', '-f', 'osm', '-']]
  ], { maxRssMb: workerRamMb });
  const tmp = `${output}.tmp-${process.pid}`; const stream = fs.createWriteStream(tmp);
  try {
    for await (const element of parseOsmElements(pipe.stdout)) {
      if (!stream.write(`${encodeElement(element)}\n`)) await new Promise((resolve) => stream.once('drain', resolve));
    }
    await pipe.done;
    await new Promise((resolve, reject) => stream.end(error => error ? reject(error) : resolve()));
    fs.renameSync(tmp, output);
  } catch (error) { pipe.kill(); stream.destroy(); try { fs.unlinkSync(tmp); } catch {} throw error; }
}
async function done(pathname, fingerprint, outputs, trustProgress = false) { const marker = `${pathname}.done`; if (!fs.existsSync(marker)) return false; try { const d = JSON.parse(fs.readFileSync(marker)); if (!trustProgress && d.fingerprint !== fingerprint) return false; for (const p of outputs) if (!fs.existsSync(p) || fs.statSync(p).size !== d.outputs[p]?.size || (!trustProgress && await fileHash(p) !== d.outputs[p]?.sha256)) return false; return true; } catch { return false; } }
async function mark(pathname, fingerprint, outputs) { const sizes = {}; for (const p of outputs) sizes[p] = { size: fs.statSync(p).size, sha256: await fileHash(p) }; fs.writeFileSync(`${pathname}.done.tmp`, JSON.stringify({ fingerprint, outputs: sizes, completedAt: new Date().toISOString() })); fs.renameSync(`${pathname}.done.tmp`, `${pathname}.done`); }
function chunks(root, sourceFingerprint = '') {
  const manifestPath = path.join(root, 'work/manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Stage 0 manifest is missing; run stage 0 first');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.complete !== true) throw new Error('Stage 0 manifest is incomplete; resume stage 0 first');
  if (sourceFingerprint && manifest.sourceFingerprint !== sourceFingerprint) throw new Error('Stage 0 manifest source fingerprint does not match the requested source');
  const expected = manifest.chunks?.map((item) => item.id);
  if (!Array.isArray(expected) || expected.length === 0) throw new Error('Stage 0 manifest has no expected chunks');
  return expected.map((id) => { const file = path.join(root, 'work/chunks', `${id}.pbf`); if (!fs.existsSync(file)) throw new Error(`expected stage 0 chunk is missing: ${file}`); return file; });
}
async function writeStageManifest(root, stage, sourceFingerprint, chunkIds, config, outputs, trustProgress = false) {
  const records = [];
  for (const file of outputs) {
    const stat = fs.statSync(file);
    let sha256;
    if (trustProgress) {
      const match = /c\d{4}/.exec(path.basename(file));
      const markerCandidates = [
        ...(match ? [path.join(root, 'work/state', `stage${stage}`, `${match[0]}.done`)] : []),
        path.join(root, 'work/state', `stage${stage}`, 'post', `${path.basename(file).replace(/\.[^.]+$/, '')}.done`)
      ];
      for (const marker of markerCandidates) {
        try { sha256 = JSON.parse(fs.readFileSync(marker, 'utf8')).outputs[file]?.sha256; } catch {}
        if (sha256) break;
      }
    }
    records.push({ file: path.relative(root, file), size: stat.size, sha256: sha256 ?? (trustProgress ? null : await fileHash(file)) });
  }
  const manifest = { stage, sourceFingerprint, chunkIds, config, upstreamCompletedAt: stage > 1 ? (() => { try { return JSON.parse(fs.readFileSync(path.join(root, `work/stage${stage - 1}/manifest.json`), 'utf8')).completedAt ?? null; } catch { return null; } })() : null, completedAt: new Date().toISOString(), outputs: records };
  const target = path.join(root, `work/stage${stage}/manifest.json`); const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest)); fs.renameSync(tmp, target);
  return manifest;
}
export async function validateStageManifest(root, stage, sourceFingerprint, expectedChunkIds, { verifyIntegrity = true } = {}) {
  const file = path.join(root, `work/stage${stage}/manifest.json`);
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`stage ${stage} manifest is missing or invalid`); }
  if (m.stage !== stage || m.sourceFingerprint !== sourceFingerprint || JSON.stringify(m.chunkIds) !== JSON.stringify(expectedChunkIds)) throw new Error(`stage ${stage} manifest does not match current source/chunk units`);
  if (!Array.isArray(m.outputs) || !m.outputs.length) throw new Error(`stage ${stage} manifest has no outputs`);
  for (const item of m.outputs) {
    const output = path.resolve(root, item.file);
    if (!output.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(output) || fs.statSync(output).size !== item.size || (verifyIntegrity && (!item.sha256 || await fileHash(output) !== item.sha256))) throw new Error(`stage ${stage} output failed manifest validation: ${item.file}`);
  }
  return m;
}
async function reusableStageManifest(root, stage, sourceFingerprint, chunkIds, config, verifyIntegrity) {
  try {
    const manifest = await validateStageManifest(root, stage, sourceFingerprint, chunkIds, { verifyIntegrity });
    return !config || JSON.stringify(manifest.config) === JSON.stringify(config);
  } catch { return false; }
}

export async function stage1Chunk({ root, chunk, allAmenities, amenities, sourceFingerprint = '', resumeMode = 'verify' }) {
    const id = path.basename(chunk, '.pbf'); const outdir = path.join(root, 'work/stage1'); const a = path.join(outdir, `amen_${id}.lines`), ids = path.join(outdir, `ids_${id}.lines`); const marker = path.join(root, 'work/state/stage1', id);
    if (resumeMode === 'trust' && await done(marker, null, [a, ids], true)) return false;
    const fp = hash(JSON.stringify({ sourceFingerprint, chunk: await fileHash(chunk), allAmenities, amenities })); if (await done(marker, fp, [a, ids])) return false;
    fs.mkdirSync(outdir, { recursive: true }); const idOut = fs.createWriteStream(`${ids}.tmp-${process.pid}`); const writeId = async line => { if (!idOut.write(`${line}\n`)) await new Promise(r => idOut.once('drain', r)); };
    await xmlToLines(chunk, a, async e => { const match = allAmenities ? Object.hasOwn(e.tags, 'amenity') : amenities.some(v => e.tags.amenity === v); if (!match) return null; if (e.type === 'way') for (const n of e.nodeIds) await writeId(encodeId('node', n)); if (e.type === 'relation') for (const m of e.members) if (m.type === 'way' || m.type === 'node') await writeId(encodeId(m.type, m.ref)); return encodeElement(e); }); await new Promise((resolve, reject) => idOut.end(error => error ? reject(error) : resolve())); fs.renameSync(`${ids}.tmp-${process.pid}`, ids); fs.mkdirSync(path.dirname(marker), { recursive: true }); await mark(marker, fp, [a, ids]);
    return true;
}
export async function stage1({ root, workers, workerRamMb = 2048, allAmenities, amenities, sourceFingerprint = '', resumeMode = 'verify' }) {
  const list = chunks(root, sourceFingerprint); let completed = 0;
  const progress = createProgress('stage 1 chunks', list.length);
  const chunkIds = list.map((file) => path.basename(file, '.pbf'));
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(path.join(root, 'work/stage1/manifest.json'), 'utf8')); } catch {}
  if (resumeMode === 'trust' && prior?.sourceFingerprint === sourceFingerprint && JSON.stringify(prior.chunkIds) === JSON.stringify(chunkIds)) {
    if (JSON.stringify(prior.config) === JSON.stringify({ allAmenities, amenities }) && await reusableStageManifest(root, 1, sourceFingerprint, chunkIds, { allAmenities, amenities }, false)) {
      console.log(`stage 1: trusting completed manifest from ${prior.completedAt ?? 'an earlier run'}; skipping completed stage`);
      return;
    }
    if (JSON.stringify(prior.config) !== JSON.stringify({ allAmenities, amenities })) {
      fs.rmSync(path.join(root, 'work/stage1'), { recursive: true, force: true });
      fs.rmSync(path.join(root, 'work/state/stage1'), { recursive: true, force: true });
      prior = null;
    }
  }
  const reusableDownstream = prior?.sourceFingerprint === sourceFingerprint && JSON.stringify(prior.chunkIds) === JSON.stringify(chunkIds) && JSON.stringify(prior.config) === JSON.stringify({ allAmenities, amenities });
  let changed = false;
  const heapMb = Math.max(32, Math.floor(workerRamMb * 0.65));
  const worker = new URL('./worker.mjs', import.meta.url).pathname;
  await pool(list, workers, async chunk => {
    const result = await run(process.execPath, [`--max-old-space-size=${heapMb}`, worker, JSON.stringify({ root, chunk, allAmenities, amenities, sourceFingerprint, resumeMode })], { maxRssMb: workerRamMb });
    changed ||= result.stdout.includes('stage1-chunk:written');
    completed++; progress(completed, completed === list.length);
  });
  if (!reusableDownstream || changed) for (const n of [2, 3]) { fs.rmSync(path.join(root, `work/stage${n}`), { recursive: true, force: true }); fs.rmSync(path.join(root, `work/state/stage${n}`), { recursive: true, force: true }); }
  const outputs = chunkIds.flatMap((id) => [path.join(root, 'work/stage1', `amen_${id}.lines`), path.join(root, 'work/stage1', `ids_${id}.lines`)]);
  await writeStageManifest(root, 1, sourceFingerprint, chunkIds, { allAmenities, amenities }, outputs, resumeMode === 'trust');
}
async function sortedIds(root, selector, target, ramMb, chunkIds) { const all = chunkIds.map((id) => path.join(root, 'work/stage1', `ids_${id}.lines`)); const temp = `${target}.raw`; const out = fs.createWriteStream(temp); for (const file of all) for await (const line of readLines(file)) if (line.startsWith(selector + ' ')) { if (!out.write(`${line.slice(2)}\n`)) await new Promise(r => out.once('drain', r)); } await new Promise(r => out.end(r)); await run('sort', ['-n', '-u', '-S', `${Math.max(32, ramMb)}M`, temp, '-o', target]); fs.unlinkSync(temp); }
async function lookupChunks(root, idfile, stage, prefix, type, workers, sourceFingerprint = '', workerRamMb = 2048, resumeMode = 'verify') { const list = chunks(root, sourceFingerprint); let idsHash; if (resumeMode !== 'trust') idsHash = await fileHash(idfile); let completed = 0; const progress = createProgress(`stage ${stage} chunks`, list.length); await pool(list, workers, async chunk => { const id = path.basename(chunk, '.pbf'); const dir = path.join(root, `work/stage${stage}`); const out = path.join(dir, `${prefix}_${id}.xml`); const marker = path.join(root, `work/state/stage${stage}`, id); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.dirname(marker), { recursive: true }); if (resumeMode === 'trust' && await done(marker, null, [out], true)) { completed++; progress(completed, completed === list.length); return; } idsHash ??= await fileHash(idfile); const fp = hash(JSON.stringify({ sourceFingerprint, ids: idsHash, chunk: await fileHash(chunk), type })); if (await done(marker, fp, [out])) { completed++; progress(completed, completed === list.length); return; }
    const tmp = `${out}.tmp-${process.pid}`; try { fs.unlinkSync(tmp); } catch {} if (fs.statSync(idfile).size === 0) fs.writeFileSync(tmp, '<?xml version="1.0" encoding="UTF-8"?><osm version="0.6"></osm>'); else { const result = await run('osmium', ['getid', '-i', idfile, '--default-type', type, chunk, '-o', tmp, '-f', 'osm'], { acceptCodes: [1, 3], maxRssMb: workerRamMb }); if (!fs.existsSync(tmp)) throw new Error(`osmium getid exited ${result.code} without producing output for ${chunk}`); } await validateOsmXml(tmp); fs.renameSync(tmp, out); await mark(marker, fp, [out]); completed++; progress(completed, completed === list.length);
  }); }
export async function stage2({ root, workers, workerRamMb = 2048, sourceFingerprint = '', resumeMode = 'verify' }) {
  const list = chunks(root, sourceFingerprint);
  const chunkIds = list.map((file) => path.basename(file, '.pbf'));
  const manifestPath = path.join(root, 'work/stage2/manifest.json');
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  let stage1Manifest = null;
  try { stage1Manifest = JSON.parse(fs.readFileSync(path.join(root, 'work/stage1/manifest.json'), 'utf8')); } catch {}
  const stage1Unchanged = prior?.upstreamCompletedAt === (stage1Manifest?.completedAt ?? null);
  if (resumeMode === 'trust' && stage1Unchanged && prior?.sourceFingerprint === sourceFingerprint && JSON.stringify(prior.chunkIds) === JSON.stringify(chunkIds) && await reusableStageManifest(root, 2, sourceFingerprint, chunkIds, null, false)) {
    console.log(`stage 2: trusting completed manifest from ${prior.completedAt ?? 'an earlier run'}; skipping completed stage`);
    return;
  }
  if (resumeMode === 'trust' && prior && !stage1Unchanged) {
    fs.rmSync(path.join(root, 'work/stage2'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'work/state/stage2'), { recursive: true, force: true });
    prior = null;
  }

  const ids = path.join(root, 'work/stage2/way-ids.txt');
  fs.mkdirSync(path.dirname(ids), { recursive: true });
  const idsStatePath = path.join(root, 'work/state/stage2/way-ids.done.json');
  let idsState = null;
  try { idsState = JSON.parse(fs.readFileSync(idsStatePath, 'utf8')); } catch {}
  const idsReusable = resumeMode === 'trust' && idsState?.upstreamCompletedAt === (stage1Manifest?.completedAt ?? null) && idsState?.sourceFingerprint === sourceFingerprint &&
    JSON.stringify(idsState.chunkIds) === JSON.stringify(chunkIds) && fs.existsSync(ids) && fs.statSync(ids).size === idsState.size;
  if (!idsReusable) {
    await sortedIds(root, 'W', ids, workerRamMb, chunkIds);
    fs.mkdirSync(path.dirname(idsStatePath), { recursive: true });
    fs.writeFileSync(idsStatePath, JSON.stringify({ sourceFingerprint, chunkIds, upstreamCompletedAt: stage1Manifest?.completedAt ?? null, size: fs.statSync(ids).size, completedAt: new Date().toISOString() }));
  }
  const wayIdsSha256 = resumeMode === 'trust' ? (prior?.config?.wayIdsSha256 ?? `trusted-size-${fs.statSync(ids).size}`) : await fileHash(ids);
  if (prior?.sourceFingerprint !== sourceFingerprint || JSON.stringify(prior.chunkIds) !== JSON.stringify(chunkIds) ||
      (resumeMode !== 'trust' && prior.config?.wayIdsSha256 !== wayIdsSha256)) {
    fs.rmSync(path.join(root, 'work/stage3'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'work/state/stage3'), { recursive: true, force: true });
  }
  await lookupChunks(root, ids, 2, 'ways', 'way', workers, sourceFingerprint, workerRamMb, resumeMode);
  const lines = chunkIds.map((id) => path.join(root, 'work/stage2', `ways_${id}.xml`));
  const nodeIds = path.join(root, 'work/stage2/node-ids.txt');
  const postDir = path.join(root, 'work/state/stage2/post');
  fs.mkdirSync(postDir, { recursive: true });
  const nodeIdsMarker = path.join(postDir, 'node-ids');
  const nodeIdsFingerprint = hash(JSON.stringify({ sourceFingerprint, wayIdsSha256, phase: 'node-ids' }));
  if (!await done(nodeIdsMarker, nodeIdsFingerprint, [nodeIds], resumeMode === 'trust')) {
    const nodeRaw = path.join(root, 'work/stage2/node-ids.raw');
    const out = fs.createWriteStream(nodeRaw);
    for (const file of lines) for await (const element of parseOsmElements(fs.createReadStream(file))) {
      for (const nodeId of element.nodeIds) if (!out.write(`${nodeId}\n`)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve) => out.end(resolve));
    await run('sort', ['-n', '-u', '-S', `${workerRamMb}M`, nodeRaw, '-o', nodeIds]);
    fs.unlinkSync(nodeRaw);
    await mark(nodeIdsMarker, nodeIdsFingerprint, [nodeIds]);
  }
  const outputs = [nodeIds];
  for (const file of lines) {
    const target = file.replace(/\.xml$/, '.lines');
    const chunkId = /c\d{4}/.exec(path.basename(file))?.[0];
    const marker = path.join(postDir, path.basename(target).replace(/\.lines$/, ''));
    const fingerprint = hash(JSON.stringify({ sourceFingerprint, wayIdsSha256, chunkId, phase: 'way-lines' }));
    if (!await done(marker, fingerprint, [target], resumeMode === 'trust')) {
      await writeLines(target, (async function* () { for await (const element of parseOsmElements(fs.createReadStream(file))) yield encodeElement(element); })());
      await mark(marker, fingerprint, [target]);
    }
    outputs.push(target);
  }
  await writeStageManifest(root, 2, sourceFingerprint, chunkIds, { wayIdsSha256 }, outputs, resumeMode === 'trust');
}
export async function stage3({ root, workers, workerRamMb = 2048, sourceFingerprint = '', keepChunks = true, resumeMode = 'verify' }) {
  const list = chunks(root, sourceFingerprint);
  const chunkIds = list.map((file) => path.basename(file, '.pbf'));
  const manifestPath = path.join(root, 'work/stage3/manifest.json');
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  let stage2Manifest = null; let stage1Manifest = null;
  try { stage2Manifest = JSON.parse(fs.readFileSync(path.join(root, 'work/stage2/manifest.json'), 'utf8')); } catch {}
  try { stage1Manifest = JSON.parse(fs.readFileSync(path.join(root, 'work/stage1/manifest.json'), 'utf8')); } catch {}
  const upstreamUnchanged = prior?.upstreamCompletedAt === (stage2Manifest?.completedAt ?? null) &&
    stage2Manifest?.upstreamCompletedAt === (stage1Manifest?.completedAt ?? null);
  if (resumeMode === 'trust' && upstreamUnchanged && prior?.sourceFingerprint === sourceFingerprint && JSON.stringify(prior.chunkIds) === JSON.stringify(chunkIds) && await reusableStageManifest(root, 3, sourceFingerprint, chunkIds, null, false)) {
    console.log(`stage 3: trusting completed manifest from ${prior.completedAt ?? 'an earlier run'}; skipping completed stage`);
    if (!keepChunks) {
      fs.rmSync(path.join(root, 'work/chunks'), { recursive: true, force: true });
      fs.rmSync(path.join(root, 'work/state/stage0'), { recursive: true, force: true });
    }
    return;
  }
  if (resumeMode === 'trust' && prior && !upstreamUnchanged) {
    fs.rmSync(path.join(root, 'work/stage3'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'work/state/stage3'), { recursive: true, force: true });
  }

  const idfile = path.join(root, 'work/stage3/node-ids.txt');
  const idStatePath = path.join(root, 'work/state/stage3/node-ids.done.json');
  fs.mkdirSync(path.dirname(idfile), { recursive: true });
  let idState = null;
  try { idState = JSON.parse(fs.readFileSync(idStatePath, 'utf8')); } catch {}
  const idsReusable = resumeMode === 'trust' && idState?.upstreamCompletedAt === (stage2Manifest?.completedAt ?? null) &&
    idState?.stage1CompletedAt === (stage1Manifest?.completedAt ?? null) && idState?.sourceFingerprint === sourceFingerprint &&
    JSON.stringify(idState.chunkIds) === JSON.stringify(chunkIds) && fs.existsSync(idfile) && fs.statSync(idfile).size === idState.size;
  if (!idsReusable) {
    const raw = path.join(root, 'work/stage3/node-ids.raw');
    const out = fs.createWriteStream(raw);
    for (const id of chunkIds) for await (const line of readLines(path.join(root, 'work/stage1', `ids_${id}.lines`))) {
      if (line.startsWith('N ') && !out.write(`${line.slice(2)}\n`)) await new Promise((resolve) => out.once('drain', resolve));
    }
    for await (const line of readLines(path.join(root, 'work/stage2/node-ids.txt'))) {
      if (!out.write(`${line}\n`)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve) => out.end(resolve));
    await run('sort', ['-n', '-u', '-S', `${workerRamMb}M`, raw, '-o', idfile]);
    fs.unlinkSync(raw);
    fs.mkdirSync(path.dirname(idStatePath), { recursive: true });
    fs.writeFileSync(idStatePath, JSON.stringify({ sourceFingerprint, chunkIds, upstreamCompletedAt: stage2Manifest?.completedAt ?? null, stage1CompletedAt: stage1Manifest?.completedAt ?? null, size: fs.statSync(idfile).size, completedAt: new Date().toISOString() }));
  }

  let idsHash = resumeMode === 'trust' ? undefined : await fileHash(idfile);
  const outputs = [idfile];
  let completed = 0;
  const progress = createProgress('stage 3 chunks', list.length);
  await pool(list, workers, async (chunk) => {
    const id = path.basename(chunk, '.pbf');
    const target = path.join(root, 'work/stage3', `nodes_${id}.lines`);
    const marker = path.join(root, 'work/state/stage3', id);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    if (resumeMode === 'trust' && await done(marker, null, [target], true)) {
      outputs.push(target); completed++; progress(completed, completed === list.length); return;
    }
    idsHash ??= await fileHash(idfile);
    const fp = hash(JSON.stringify({ sourceFingerprint, idsHash, chunk: await fileHash(chunk), type: 'node-stream-merge-v1' }));
    if (!await done(marker, fp, [target])) {
      if (fs.statSync(idfile).size === 0) await writeLines(target, []);
      else await mergeNodeIds(chunk, idfile, target, workerRamMb);
      await mark(marker, fp, [target]);
    }
    outputs.push(target); completed++; progress(completed, completed === list.length);
  });
  outputs.sort();
  const nodeIdsSha256 = resumeMode === 'trust' ? `trusted-size-${fs.statSync(idfile).size}` : idsHash;
  await writeStageManifest(root, 3, sourceFingerprint, chunkIds, { nodeIdsSha256, method: 'streaming-osmium-opl-merge' }, outputs, resumeMode === 'trust');
  if (!keepChunks) {
    fs.rmSync(path.join(root, 'work/chunks'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'work/state/stage0'), { recursive: true, force: true });
  }
}
