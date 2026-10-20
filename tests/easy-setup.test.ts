import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/easy-setup.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'oam-wizard-'));
  dirs.push(root);
  const deployment = path.join(root, 'deployment with spaces');
  const pipeline = path.join(root, 'pipeline');
  const sources = path.join(root, 'source with spaces');
  mkdirSync(sources);
  writeFileSync(path.join(sources, 'planet.osm.pbf'), 'immutable test baseline');
  return { root, deployment, pipeline, sources };
}
type Workspace = ReturnType<typeof workspace>;
function answers(w: Workspace, changes: Record<string, string> = {}) {
  const fields = {
    repository: '', deployment: w.deployment, pipeline: w.pipeline, sourceMode: 'existing',
    source: path.join(w.sources, 'planet.osm.pbf'),
    project: 'test-planet', service: 'amenity-test', network: 'test-overpass', alias: 'test-amenity',
    hostIp: '', hostPort: '9091', proxyMode: '', proxyService: '', fallbacks: 'none',
    amenities: 'toilets,drinking_water', precision: '6', cache: '512', update: '300', rebuild: '', log: '',
    chunk: '128', ram: '6144', worker: '2048', workers: '2', updateWorkers: '3', allValues: '', keepChunks: '', verify: '', write: ''
  };
  return Object.entries(fields).map(([key, value]) => changes[key] ?? value).join('\n') + '\n';
}
function run(args: string[], input = '', env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [script, ...args], {
    input, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20_000
  });
}
function configure(w: Workspace, changes: Record<string, string> = {}) {
  const result = run(['--configure-only'], answers(w, changes));
  expect(result.stderr, result.stdout).not.toContain('Error:');
  expect(result.status, result.stderr).toBe(0);
}
function mockDocker(w: Workspace) {
  const bin = path.join(w.root, 'bin');
  mkdirSync(bin);
  const mock = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t' "$@" >> "$MOCK_LOG"
printf '\\n' >> "$MOCK_LOG"
if [[ $1 == info ]]; then exit 0; fi
if [[ $1 == network ]]; then exit 0; fi
if [[ $1 == inspect ]]; then
  [[ -f $MOCK_ROOT/container ]] || exit 1
  if [[ \${2:-} != --format ]]; then exit 0; fi
  case "$3" in
    *Labels*) printf '%s\\n' "$MOCK_DEPLOYMENT" ;;
    *Running*) echo false ;;
    *ExitCode*) echo "\${MOCK_IMPORT_EXIT:-0}" ;;
  esac
  exit 0
fi
if [[ $1 == logs ]]; then echo 'mock import log'; exit 0; fi
if [[ $1 == wait ]]; then echo "\${MOCK_IMPORT_EXIT:-0}"; exit 0; fi
if [[ $1 == rm ]]; then rm "$MOCK_ROOT/container"; exit 0; fi
if [[ $1 == compose ]]; then
  shift
  if [[ \${1:-} == version ]]; then [[ \${MOCK_LEGACY:-0} != 1 ]]; exit; fi
  [[ $1 != --project-name ]] || shift 4
  case "$1" in
    config|build|stop|ps) exit 0 ;;
    run)
      if [[ " $* " == *" -d "* ]]; then
        touch "$MOCK_ROOT/container"
        mkdir -p "$MOCK_PIPELINE/data"
        echo '{"generation":"test"}' > "$MOCK_PIPELINE/data/manifest.json"
        echo mock-container-id
      elif [[ " $* " == *sourceMetadata* ]]; then
        if [[ \${MOCK_BAD_HEADER:-0} == 1 ]]; then echo 'invalid source provenance' >&2; exit 1; fi
        echo 'OSM_AMENITY_UPDATE_BASE_URL=https://planet.openstreetmap.org/replication/minute'
        echo 'OSM_AMENITY_REPLICATION_SEQUENCE_NUMBER=7325026'
      else
        echo 'validated generation'
      fi
      ;;
    exec) echo '{"ok":true}' ;;
    up) touch "$MOCK_ROOT/started" ;;
    *) echo "Unexpected mock command: $*" >&2; exit 1 ;;
  esac
  exit 0
fi
exit 1
`;
  writeFileSync(path.join(bin, 'docker'), mock, { mode: 0o755 });
  writeFileSync(path.join(bin, 'docker-compose'), `#!/usr/bin/env bash
printf 'legacy-compose\\n' >> "$MOCK_LOG"
exec "$(dirname "$0")/docker" compose "$@"
`, { mode: 0o755 });
  // No real download: exercise the real checksum/resume/publish logic on tiny bytes.
  const bytes = 'downloaded test planet';
  const md5 = createHash('md5').update(bytes).digest('hex');
  writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
out=''
while (( $# )); do
  if [[ $1 == --output ]]; then out=$2; shift; fi
  shift
done
if [[ $out == *.md5 ]]; then
  printf '%s  planet-latest.osm.pbf\\n' "\${MOCK_MD5:-${md5}}" > "$out"
else
  printf '%s' '${bytes}' > "$out"
fi
`, { mode: 0o755 });
  return {
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_LOG: path.join(w.root, 'docker.log'), MOCK_ROOT: w.root,
    MOCK_DEPLOYMENT: w.deployment, MOCK_PIPELINE: w.pipeline
  };
}

describe('interactive Docker setup', () => {
  it('generates a custom deployment with spaces in paths, no fallbacks, and a shell-safe wrapper', () => {
    const w = workspace();
    configure(w);
    const compose = readFileSync(path.join(w.deployment, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain(`- '${w.pipeline}:/osm:rw'`);
    expect(compose).toContain("'127.0.0.1:9091:8081'");
    expect(compose).toContain("aliases: ['test-amenity']");
    const env = readFileSync(path.join(w.deployment, 'server.env'), 'utf8');
    expect(env).toContain('OSM_AMENITY_AMENITIES=toilets,drinking_water');
    expect(env).toContain('OSM_AMENITY_SHARD_PRECISION=6');
    expect(env).toContain('OSM_AMENITY_UPDATE_INTERVAL_SECONDS=300');
    expect(env).toContain('OSM_AMENITY_UPDATE_WORKERS=3');
    const proxy = readFileSync(path.join(w.deployment, 'proxy.compose.example.yml'), 'utf8');
    expect(proxy).toContain('UPSTREAM_URLS: "http://test-amenity:8081/api/interpreter"');
    expect(proxy).not.toContain('overpass-api.de');
    const wrapper = path.join(w.deployment, 'compose.sh');
    expect(spawnSync('bash', ['-n', wrapper]).status).toBe(0);
    const docker = mockDocker(w);
    expect(spawnSync(wrapper, ['config'], { env: { ...process.env, ...docker } }).status).toBe(0);
    expect(readFileSync(docker.MOCK_LOG, 'utf8')).toContain(`--project-name\ttest-planet\t--file\t${w.deployment}/docker-compose.yml\tconfig`);
    expect(spawnSync(wrapper, ['config'], { env: { ...process.env, ...docker, MOCK_LEGACY: '1' } }).status).toBe(0);
    expect(readFileSync(docker.MOCK_LOG, 'utf8')).toContain('legacy-compose');
  });

  it('accepts custom download locations and generates a remote-proxy example without local networks', () => {
    const w = workspace();
    configure(w, {
      sourceMode: 'download',
      source: [w.sources, 'snapshot.osm.pbf', 'https://example.com/planet.osm.pbf', 'https://example.com/planet.osm.pbf.md5'].join('\n'),
      proxyMode: 'remote', proxyService: 'remote-proxy\nhttps://backend.example.com/api/interpreter',
      fallbacks: 'https://overpass-api.de/api/interpreter'
    });
    const proxy = readFileSync(path.join(w.deployment, 'proxy.compose.example.yml'), 'utf8');
    expect(proxy).toContain('remote-proxy:');
    expect(proxy).toContain('https://backend.example.com/api/interpreter,https://overpass-api.de/api/interpreter');
    expect(proxy).not.toContain('networks:');
    expect(readFileSync(path.join(w.deployment, 'server.env'), 'utf8')).toContain('/source/snapshot.osm.pbf');
    expect(existsSync(path.join(w.sources, 'snapshot.osm.pbf'))).toBe(false);
  });

  it('rejects a shell-substitution path, invalid port, and oversized worker count by asking again', () => {
    const w = workspace();
    const sentinel = path.join(w.root, 'injected');
    configure(w, {
      deployment: `/tmp/$(touch ${sentinel})\n${w.deployment}`,
      hostPort: '70000\n9091', workers: '4\n2'
    });
    expect(existsSync(sentinel)).toBe(false);
  });

  it('does not overwrite an existing deployment or adopt an already initialized pipeline', () => {
    const w = workspace();
    configure(w);
    const file = path.join(w.deployment, 'server.env');
    const original = readFileSync(file, 'utf8');
    const result = run(['--configure-only'], answers(w));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Deployment directory is not empty');
    expect(readFileSync(file, 'utf8')).toBe(original);
    const fresh = workspace();
    mkdirSync(path.join(fresh.pipeline, 'data'), { recursive: true });
    const adopted = run(['--configure-only'], answers(fresh));
    expect(adopted.status).toBe(1);
    expect(adopted.stderr).toContain('Pipeline already contains');
  });

  it('resumes through metadata, detached extraction, verification and startup without losing settings', () => {
    const w = workspace();
    configure(w);
    const docker = mockDocker(w);
    const result = run(['--resume', w.deployment], '\n'.repeat(4), docker);
    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(docker.MOCK_LOG, 'utf8');
    expect(log).toContain('--amenities\ttoilets,drinking_water\t--shard-precision\t6');
    expect(log).toContain('--ram-mb\t6144\t--worker-ram-mb\t2048\t--workers\t2');
    expect(log).toContain('--verify\ttrue');
    expect(log).toContain('scripts/verify-http.mjs');
    expect(readFileSync(path.join(w.deployment, 'server.env'), 'utf8')).toContain(
      'OSM_AMENITY_UPDATE_BASE_URL=https://planet.openstreetmap.org/replication/minute'
    );
    expect(existsSync(path.join(w.root, 'started'))).toBe(true);
    // A completed import is not launched again on the next resume.
    const second = run(['--resume', w.deployment], '\n'.repeat(3), docker);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(docker.MOCK_LOG, 'utf8').split('--stages\t0-4').length - 1).toBe(1);
  });

  it('never starts the HTTP updater after a failed import or invalid source header', () => {
    const w = workspace();
    configure(w);
    const docker = mockDocker(w);
    const result = run(['--resume', w.deployment], '\n'.repeat(3), { ...docker, MOCK_IMPORT_EXIT: '9' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Import exited with code 9');
    expect(existsSync(path.join(w.root, 'started'))).toBe(false);
    const fresh = workspace();
    configure(fresh);
    const invalid = run(['--resume', fresh.deployment], '\n', { ...mockDocker(fresh), MOCK_BAD_HEADER: '1' });
    expect(invalid.status).toBe(1);
    expect(existsSync(path.join(fresh.root, 'container'))).toBe(false);
  });

  it('resumes a download with a matching identity, verifies bytes, and preserves the published baseline', () => {
    const w = workspace();
    configure(w);
    rmSync(path.join(w.sources, 'planet.osm.pbf'));
    const settings = path.join(w.deployment, 'settings.tsv');
    writeFileSync(settings, readFileSync(settings, 'utf8').replace('source_mode\texisting', 'source_mode\tdownload'));
    const partial = path.join(w.sources, 'planet.osm.pbf.part');
    writeFileSync(partial, 'interrupted bytes');
    const checksum = createHash('md5').update('downloaded test planet').digest('hex');
    writeFileSync(`${partial}.identity`, `https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf\n${checksum}\n`);
    const docker = mockDocker(w);
    const result = run(['--resume', w.deployment], '\n'.repeat(5), docker);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(w.sources, 'planet.osm.pbf'), 'utf8')).toBe('downloaded test planet');
    expect(existsSync(path.join(w.sources, 'planet.osm.pbf.part'))).toBe(false);
    const bad = workspace();
    configure(bad);
    rmSync(path.join(bad.sources, 'planet.osm.pbf'));
    const badSettings = path.join(bad.deployment, 'settings.tsv');
    writeFileSync(badSettings, readFileSync(badSettings, 'utf8').replace('source_mode\texisting', 'source_mode\tdownload'));
    const failed = run(['--resume', bad.deployment], '\n\n', { ...mockDocker(bad), MOCK_MD5: '0'.repeat(32) });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('Download checksum failed');
    expect(existsSync(path.join(bad.sources, 'planet.osm.pbf'))).toBe(false);
    expect(existsSync(path.join(bad.root, 'container'))).toBe(false);
  });

  it('rejects an unrelated partial snapshot and never downloads over a missing active baseline', () => {
    const w = workspace();
    configure(w);
    rmSync(path.join(w.sources, 'planet.osm.pbf'));
    const settings = path.join(w.deployment, 'settings.tsv');
    writeFileSync(settings, readFileSync(settings, 'utf8').replace('source_mode\texisting', 'source_mode\tdownload'));
    const partial = path.join(w.sources, 'planet.osm.pbf.part');
    writeFileSync(partial, 'unrelated partial bytes');
    const docker = mockDocker(w);
    const result = run(['--resume', w.deployment], '\n\n', docker);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Partial download belongs to another snapshot');
    expect(readFileSync(partial, 'utf8')).toBe('unrelated partial bytes');
    mkdirSync(path.join(w.pipeline, 'data'));
    const active = run(['--resume', w.deployment], '\n', docker);
    expect(active.status).toBe(1);
    expect(active.stderr).toContain('lost its retained baseline');
  });

  it('does not evaluate commands in a tampered settings file', () => {
    const w = workspace();
    configure(w);
    const sentinel = path.join(w.root, 'executed');
    const file = path.join(w.deployment, 'settings.tsv');
    writeFileSync(file, readFileSync(file, 'utf8') + `$(touch ${sentinel})\tvalue\n`);
    const result = run(['--resume', w.deployment]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid or duplicate saved setting');
    expect(existsSync(sentinel)).toBe(false);
  });
});
