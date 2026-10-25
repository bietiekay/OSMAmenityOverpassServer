import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Docker server launcher', () => {
  for (const checkExit of [0, 1]) it(`starts the server only after the index check succeeds (check exit ${checkExit})`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oam-start-')); roots.push(root);
    const bin = path.join(root, 'bin'); mkdirSync(bin);
    const log = path.join(root, 'calls');
    writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nif [ "$1" = scripts/check-index.mjs ]; then exit "$CHECK_EXIT"; fi\nexit 0\n', { mode: 0o755 });
    const result = spawnSync('sh', [path.resolve('scripts/start-server.sh')], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, CHECK_EXIT: String(checkExit) } });
    expect(result.status).toBe(checkExit);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(checkExit === 0 ? ['scripts/check-index.mjs', 'dist/index.js'] : ['scripts/check-index.mjs']);
  });
});
