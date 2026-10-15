#!/usr/bin/env node
/**
 * Fixture builder (plan §12, Phase 0): generates a small OSM XML with known
 * object counts (nodes / ways / relations, some with amenity=toilets plus
 * noise), converts it to PBF with osmium, and optionally runs the Stage 0
 * block-split with a small chunk target and verifies the object counts.
 *
 * Usage:
 *   node scripts/make-fixture.mjs --out-dir fixtures [--nodes 100000]
 *      [--ways 10000] [--relations 1000] [--chunk-mb 1] [--verify]
 *
 * The fixture must be large enough that osmium produces several PBF blocks,
 * so the Stage 0 split creates several self-contained chunks.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const OUT_DIR = args['out-dir'] ? path.resolve(args['out-dir']) : path.resolve('fixtures');
const NODES = Number(args.nodes ?? 100000);
const WAYS = Number(args.ways ?? 10000);
const RELATIONS = Number(args.relations ?? 1000);
const CHUNK_MB = Number(args['chunk-mb'] ?? 1);
const VERIFY = Boolean(args.verify);

// Deterministic pseudo-random (LCG) so the fixture is reproducible.
let seed = 20261014;
const rnd = () => {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
};

// Small region around a point (Japan) so geohash cells stay few.
const LAT0 = 35.0, LON0 = 135.0, SPAN = 0.5;

const ts = '2026-10-01T12:00:00Z';
const version = 1;
const changeset = 999999;

const writeStream = (file) => fs.createWriteStream(file);

const buildFixtureXml = (file) => {
  const stream = writeStream(file);
  const chunked = (parts, every = 50000) => {
    let i = 0;
    for (const part of parts) {
      stream.write(part);
      if ((i += 1) % every === 0) {
        // allow backpressure
        while (stream.write('') === false) {
          // flush synchronously
          break;
        }
      }
    }
  };

  const header =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<osm version="0.6" generator="osm-amenity-fixture">\n`;

  const nodeParts = [];
  for (let i = 1; i <= NODES; i += 1) {
    const lat = LAT0 + rnd() * SPAN;
    const lon = LON0 + rnd() * SPAN;
    let tags = '';
    if (i % 10 === 0) {
      tags = `<tag k="amenity" v="toilets"/><tag k="name" v="Fixture WC ${i}"/>`;
    } else if (i % 7 === 0) {
      tags = `<tag k="amenity" v="drinking_water"/>`;
    } else if (i % 5 === 0) {
      tags = `<tag k="building" v="yes"/>`;
    }
    nodeParts.push(
      `<node id="${i}" version="${version}" changeset="${changeset}" timestamp="${ts}" lat="${lat.toFixed(8)}" lon="${lon.toFixed(8)}">${tags}</node>\n`
    );
  }

  const wayParts = [];
  for (let w = 1; w <= WAYS; w += 1) {
    const id = NODES + w;
    const nodeCount = 3 + Math.floor(rnd() * 8);
    let nds = '';
    for (let n = 0; n < nodeCount; n += 1) {
      const ref = 1 + Math.floor(rnd() * NODES);
      nds += `<nd ref="${ref}"/>`;
    }
    let tags = '';
    if (w % 20 === 0) {
      tags = `<tag k="amenity" v="toilets"/><tag k="operator" v="fixture"/>`;
    } else if (w % 9 === 0) {
      tags = `<tag k="highway" v="residential"/>`;
    }
    wayParts.push(`<way id="${id}" version="${version}" changeset="${changeset}" timestamp="${ts}">${nds}${tags}</way>\n`);
  }

  const relParts = [];
  for (let r = 1; r <= RELATIONS; r += 1) {
    const id = NODES + WAYS + r;
    const wayCount = 2 + Math.floor(rnd() * 6);
    let members = '';
    for (let m = 0; m < wayCount; m += 1) {
      const ref = NODES + 1 + Math.floor(rnd() * WAYS);
      const role = m === 0 ? 'outer' : 'inner';
      members += `<member type="way" ref="${ref}" role="${role}"/>`;
    }
    const tags = r % 25 === 0
      ? `<tag k="amenity" v="toilets"/><tag k="leisure" v="park"/>`
      : `<tag k="boundary" v="administrative"/>`;
    relParts.push(
      `<relation id="${id}" version="${version}" changeset="${changeset}" timestamp="${ts}">${members}${tags}</relation>\n`
    );
  }

  const footer = '</osm>\n';

  const writeAll = () => {
    stream.write(header);
    chunked(nodeParts);
    chunked(wayParts);
    chunked(relParts);
    stream.write(footer);
    stream.end();
  };

  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    writeAll();
  });
};

const osmiumCat = (input, output) => {
  const res = spawnSync('osmium', ['cat', input, '-o', output, '--overwrite'], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`osmium cat failed: ${res.stderr || res.stdout}`);
  }
};

const osmiumNumObjects = (file) => {
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  // osmium show prints ANSI colours; strip them, then count object lines.
  const awkProg =
    '{ gsub(/\\033\\[[0-9;]*m/, "") } /^node / { n++ } /^way / { w++ } /^relation / { r++ } END { printf "%d %d %d", n+0, w+0, r+0 }';
  const res = spawnSync('sh', ['-c', `osmium show ${quoted} | awk '${awkProg}'`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`osmium show failed on ${file}: ${res.stderr || res.stdout}`);
  }
  const [nodes, ways, relations] = res.stdout.trim().split(/\s+/).map(Number);
  return { nodes, ways, relations };
};

const run = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const xmlFile = path.join(OUT_DIR, 'fixture.osm.xml');
  const pbfFile = path.join(OUT_DIR, 'fixture.osm.pbf');

  console.log(`generating fixture xml (${NODES} nodes, ${WAYS} ways, ${RELATIONS} relations) -> ${xmlFile}`);
  await buildFixtureXml(xmlFile);

  console.log(`converting to pbf -> ${pbfFile}`);
  osmiumCat(xmlFile, pbfFile);
  const counts = osmiumNumObjects(pbfFile);
  console.log(`fixture pbf: ${counts.nodes} nodes, ${counts.ways} ways, ${counts.relations} relations`);

  if (counts.nodes !== NODES || counts.ways !== WAYS || counts.relations !== RELATIONS) {
    throw new Error('fixture object counts do not match the generated XML');
  }

  if (VERIFY) {
    // Run the Stage 0 block-split with a small chunk target, then verify counts.
    const dataDir = path.join(OUT_DIR, 'stage0');
    fs.rmSync(dataDir, { recursive: true, force: true });
    const extract = path.resolve('scripts', 'extract.mjs');
    const res = spawnSync(
      process.execPath,
      [
        extract,
        '--planet-source', pbfFile,
        '--data-dir', dataDir,
        '--stages', '0',
        '--chunk-mb', String(CHUNK_MB),
        '--verify'
      ],
      { encoding: 'utf8', stdio: 'inherit' }
    );
    if (res.status !== 0) {
      throw new Error('stage 0 split/verify failed');
    }
    console.log(`stage 0 split + osmium verify OK (chunk-mb=${CHUNK_MB})`);
  }

  console.log('fixture complete');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
