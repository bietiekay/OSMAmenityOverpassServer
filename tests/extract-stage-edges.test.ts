import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stage1, stage2, stage3 } from '../scripts/extract/stages.mjs';

async function withFakeOsmium(exitCode: number, run: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-getid-exit-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const fake = path.join(bin, 'osmium');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);const out=args[args.indexOf('-o')+1];fs.writeFileSync(out,'<?xml version="1.0"?><osm version="0.6"></osm>');process.exit(${exitCode});\n`);
  fs.chmodSync(fake, 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    fs.mkdirSync(path.join(root, 'work/chunks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'work/stage1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'work/chunks/c0000.pbf'), 'chunk fixture');
    fs.writeFileSync(path.join(root, 'work/stage1/ids_c0000.lines'), 'W 22\n');
    fs.writeFileSync(path.join(root, 'work/manifest.json'), JSON.stringify({ complete: true, sourceFingerprint: 'fp', chunks: [{ id: 'c0000' }] }));
    await run(root);
  } finally { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); }
}

describe('stage 2 native lookup exit handling', () => {
  it.each([1, 3])('accepts osmium getid exit %i when it produced valid partial XML', async (exitCode) => {
    await withFakeOsmium(exitCode, async (root) => {
      await expect(stage2({ root, workers: 1, workerRamMb: 128, sourceFingerprint: 'fp' })).resolves.toBeUndefined();
      expect(fs.readFileSync(path.join(root, 'work/stage2/ways_c0000.xml'), 'utf8')).toContain('</osm>');
      expect(fs.existsSync(path.join(root, 'work/stage2/manifest.json'))).toBe(true);
    });
  });

  it('surfaces a native lookup error even when it leaves a parseable output file', async () => {
    await withFakeOsmium(2, async (root) => {
      await expect(stage2({ root, workers: 1, workerRamMb: 128, sourceFingerprint: 'fp' })).rejects.toThrow(/osmium exited 2/);
    });
  });

  it('keeps Stage 3 products for identical way IDs and removes them when that input set changes', async () => {
    await withFakeOsmium(0, async (root) => {
      const options = { root, workers: 1, workerRamMb: 128, sourceFingerprint: 'fp' };
      await stage2(options);
      fs.mkdirSync(path.join(root, 'work/stage3'), { recursive: true });
      fs.writeFileSync(path.join(root, 'work/stage3/old-product'), 'still valid');
      await stage2(options);
      expect(fs.existsSync(path.join(root, 'work/stage3/old-product'))).toBe(true);
      fs.writeFileSync(path.join(root, 'work/stage1/ids_c0000.lines'), 'W 23\n');
      await stage2(options);
      expect(fs.existsSync(path.join(root, 'work/stage3'))).toBe(false);
    });
  });
});

it('reuses downstream stages for an identical Stage 1 config and invalidates them after a filter change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-stage1-config-change-'));
  try {
    const xml = path.join(root, 'source.osm'); const chunk = path.join(root, 'work/chunks/c0000.pbf');
    fs.mkdirSync(path.dirname(chunk), { recursive: true });
    fs.writeFileSync(xml, '<osm version="0.6"><node id="1" lat="35" lon="139"><tag k="amenity" v="toilets"/></node></osm>');
    execFileSync('osmium', ['cat', xml, '-o', chunk]);
    fs.writeFileSync(path.join(root, 'work/manifest.json'), JSON.stringify({ complete: true, sourceFingerprint: 'fp', chunks: [{ id: 'c0000' }] }));
    const options = { root, workers: 1, workerRamMb: 256, allAmenities: false, amenities: ['toilets'], sourceFingerprint: 'fp' };
    await stage1(options);
    fs.mkdirSync(path.join(root, 'work/stage2'), { recursive: true }); fs.writeFileSync(path.join(root, 'work/stage2/keep'), 'same config');
    fs.mkdirSync(path.join(root, 'work/stage3'), { recursive: true }); fs.writeFileSync(path.join(root, 'work/stage3/keep'), 'same config');
    await stage1(options);
    expect(fs.existsSync(path.join(root, 'work/stage2/keep'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'work/stage3/keep'))).toBe(true);
    await stage1({ ...options, amenities: ['bench'] });
    expect(fs.existsSync(path.join(root, 'work/stage2'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'work/stage3'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'work/stage1/amen_c0000.lines'), 'utf8')).toBe('');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10000);

it('removes a partial Stage 3 output when its native streaming pipeline fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-stage3-native-failure-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const fake = path.join(bin, 'osmium'); fs.writeFileSync(fake, '#!/bin/sh\necho "simulated native failure" >&2\nexit 9\n'); fs.chmodSync(fake, 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    fs.mkdirSync(path.join(root, 'work/chunks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'work/stage1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'work/stage2'), { recursive: true });
    fs.writeFileSync(path.join(root, 'work/chunks/c0000.pbf'), 'chunk fixture');
    fs.writeFileSync(path.join(root, 'work/stage1/ids_c0000.lines'), 'N 1\n');
    fs.writeFileSync(path.join(root, 'work/stage2/node-ids.txt'), '1\n');
    fs.writeFileSync(path.join(root, 'work/manifest.json'), JSON.stringify({ complete: true, sourceFingerprint: 'fp', chunks: [{ id: 'c0000' }] }));
    await expect(stage3({ root, workers: 1, workerRamMb: 128, sourceFingerprint: 'fp' })).rejects.toThrow(/native pipeline/);
    expect(fs.existsSync(path.join(root, `work/stage3/nodes_c0000.lines.tmp-${process.pid}`))).toBe(false);
  } finally { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); }
}, 5000);
