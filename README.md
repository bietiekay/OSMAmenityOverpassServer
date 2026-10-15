# OSMAmenityOverpassServer

A local OSM amenity index serving the narrow Overpass QL subset used by
Overpass-Proxy. In-scope requests are answered from geohash shards; unsupported
requests return `501 {"error":"out of scope"}` so the unmodified proxy can
fall through to its next upstream. This repository targets full-planet builds
and has been exercised with Japan data; a planet-scale run is not claimed here.

## Documentation

- [Installation, commissioning, and operations](docs/OPERATIONS.md): native
  Linux setup, source download, extraction, systemd, proxy integration, Docker,
  updates, monitoring, backup, rollback, and troubleshooting.
- [Architecture and implementation](docs/ARCHITECTURE.md): module map, data
  flow, generation transactions, formats, budgets, and tests.
- [API and storage specification](specification.md).
- [Verified acceptance results](plans/2026-10-15-abnahme.md) and
  [current status](plans/TODO.md).
- [Implementation brief](plans/ZIEL-PROMPT.md) and
  [historical design decisions](plans/2026-10-14-osm-amenity-overpass-server.md).

All documentation is in English. Some dated planning filenames are retained
to preserve existing links. Local verification datasets and logs mentioned in
the acceptance report are external artifacts, not repository contents.

## Run the server

```bash
npm ci
npm run build
OSM_AMENITY_DATA_DIR=/path/to/pipeline/data npm start
```

Set `OSM_AMENITY_UPDATE_BASE_URL` to the exact namespace recorded in the
generation's `state.json`. For Japan this is normally
`https://download.geofabrik.de/asia/japan-updates`; the default planet feed
does not match a regional baseline. See the commissioning guide before starting
an installation for the first time.

The data directory must be a published generation containing `manifest.json`,
`state.json`, and `shards/`. A valid empty generation has an explicit empty
`manifest.shards` array. A missing or invalid generation fails interpreter
requests instead of returning a misleading empty success.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8081` | HTTP listen port |
| `OSM_AMENITY_DATA_DIR` | `.` | Active generation directory (often pipeline `data/` symlink) |
| `OSM_AMENITY_AMENITIES` | `toilets` | Comma-separated configured amenity values |
| `OSM_AMENITY_SHARD_PRECISION` | `5` | Geohash precision, 3 through 7 |
| `OSM_AMENITY_SHARD_CACHE_MB` | `256` | In-memory shard LRU limit |
| `OSM_AMENITY_UPDATE_INTERVAL_SECONDS` | `3600` | Update-loop wake cadence |
| `OSM_AMENITY_UPDATE_BASE_URL` | `https://planet.openstreetmap.org/replication` | Replication namespace root; Geofabrik host implies regional/day, otherwise planet/minute |
| `OSM_AMENITY_SOURCE_PBF` | unset | Optional retained PBF path for updater re-extract; mounted path can differ from the source path recorded at build |
| `OSM_AMENITY_REEXTRACT_SOURCE_PBF` | unset | Optional PBF used only for weekly drift re-extracts; falls back to `OSM_AMENITY_SOURCE_PBF` |
| `OSM_AMENITY_REEXTRACT_EVERY_SECONDS` | `604800` | Drift-guard interval (one week by default) |
| `OSM_AMENITY_REDIS_URL` | unset | Reserved setting; direct proxy Redis invalidation is not implemented |
| `OSM_AMENITY_REDIS_INVALIDATE` | `false` | Reserved Redis invalidation toggle; only read when Redis is configured |
| `LOG_VERBOSITY` | `info` | `errors`, `info`, or `debug` |

The active generation's persisted replication descriptor is authoritative for
its local cursor. `osm_osm_change` is populated only for a known planet/minute
cursor; regional daily sequence numbers are reported in `localEngine` and never
misrepresented as global minute values.

## Endpoints

- `POST` and `GET /api/interpreter`: reads form or query parameter `data`. A
  supported query returns Overpass JSON/XML and a stable `ETag`; unsupported
  syntax returns 501; a blank query returns 400.
- `GET /api/status`: Overpass monitoring fields plus local generation, cursor,
  configuration, and query statistics.
- `GET /api/timestamp`: generation data timestamp, or an empty string when
  unknown.
- `POST /api/kill_my_queries`: successful no-op (there is no queued query work).
- `HEAD /` and `HEAD /api/interpreter`: successful recovery probes.

The parser accepts a constrained amenity equality + common bbox query, optional
`node`/`way`/`relation` selectors, one supported output clause and optional
`>;` member expansion. Unknown filters/directives/leftover QL are out of scope.
See [specification.md](specification.md) for response and storage semantics.

## Build the index

`--data-dir` is the pipeline root. The working data is under `work/`; the
published server generation is under `data/`. Stage 0 accepts `--source` (with
`--planet-source` as an alias); stages 1–3 extract amenities and resolve way
and node references; stage 4 assembles and atomically publishes OAM shards.

```bash
node scripts/extract.mjs \
  --source /path/to/region.osm.pbf \
  --data-dir /path/to/pipeline \
  --stages 0-4 \
  --chunk-mb 256 --ram-mb 8192 --worker-ram-mb 2048 --workers 3 \
  --all-amenity-values true --verify
```

Supported extraction options are `--source`/`--planet-source`, `--data-dir`,
`--stages` (`0`, a stage, or range such as `0-4`), `--chunk-mb`, `--ram-mb`,
`--worker-ram-mb`, `--workers`, `--shard-precision`, `--keep-chunks`,
`--all-amenity-values`, `--amenities`, and `--verify`. Extraction requires
`osmium-tool`; run `node scripts/extract.mjs` with no stage source to resume a
previously recorded stage from `work/manifest.json`. Specify the intended
`--stages` and `--data-dir`; the CLI defaults to stage 0, which requires a source.

A reusable live HTTP smoke verifier is available after starting a local server:

```bash
node scripts/verify-http.mjs \
  --url http://127.0.0.1:8081 \
  --expected-nodes /path/to/tokyo-expected-nodes.json
```

It checks real HTTP GET/POST JSON, XML, stable ETags, expected node records,
400/501 behavior, status, kill no-op, and HEAD probes. Without the expected
file it uses a bounded Tokyo-area smoke bbox.

To compare a saved QL query against public Overpass by typed object identity
and complete element fields (ignoring response order), run:

```bash
npm run parity -- --local-url http://127.0.0.1:8081/api/interpreter \
  --reference-url https://overpass-api.de/api/interpreter \
  --query-file query.ql
```

The report includes source timestamps as diagnostics. A mismatch or HTTP error
exits nonzero; public endpoint availability is not guaranteed.

## Replication and current limits

The updater reads a namespace-local replication cursor and applies contiguous
minute/day diffs through immutable generations. Weekly drift rebuilds run stages
0–4 into an inactive generation, reject unknown or mismatched snapshot cursors,
replay the configured namespace through the current live cursor under the
generation lock, then activate atomically. If no successful re-extract time is
recorded yet, the first scheduled check establishes the weekly timer baseline
instead of rebuilding immediately. A separate
`OSM_AMENITY_REEXTRACT_SOURCE_PBF` may provide a newer source snapshot; when it
is unset, the updater reuses `OSM_AMENITY_SOURCE_PBF`, then the active
generation's recorded source path. The update watch loop
checks the weekly schedule after each catch-up cycle. These mechanisms still
do not prove public Overpass parity, crash recovery in every failure mode, or
planet-scale resource bounds. Regional Geofabrik inputs use their own daily
namespace and sequence.

The line pipeline is partitioned and bounded in its lookups, but Japan success
does not demonstrate planet-size runtime or resource bounds. Relations currently
have aggregate bounds and direct member expansion; nested relation closure and
full public Overpass parity remain limited.

Each update batch hardlinks the generation tree and scans its shard inventory
for validation and an exact recount. Publication also syncs the generation tree.
This work scales with the complete index, even when few shards change. Dependency
closure is capped at 50,000 tracked objects, affected cells at 5,000, rebuilt rows
at 64 MiB, and each resolved-object lookup at 64 MiB. The shared geometry
member-object cache has no aggregate byte cap; total updater RAM is not bounded
by that per-lookup limit. A batch exceeding a checked limit
fails without advancing the cursor; reduce the update interval or use a newer
baseline. These checks do not establish planet memory bounds or throughput.
Retain the baseline PBF unchanged while it serves updates; provide a newer
snapshot through a separate re-extract path. Old immutable generations currently
require operator-managed retention and disk capacity.

## Docker packaging

The runner uses `node:22-bookworm-slim` and installs Debian's `osmium-tool`,
`coreutils`, `util-linux` (for `flock`), and `gawk` because the update/re-extract pipeline runs offline
inside the container. The prior Alpine runtime did not include an available
`osmium-tool` package. The pipeline root is a writable `/osm` volume; the active
server data path is `/osm/data`, and the retained PBF is mounted read-only at
`/source/region.osm.pbf` through `OSM_AMENITY_SOURCE_PBF`. See
`docker-compose.yml.template` for required host path variables.

Docker packaging has not been built or tested locally and is not part of the
current verification result.

## Development checks

```bash
npm run lint
npm run build
npm test
npm run test:ci
```

`test:ci` enforces 90% statements, 85% branches, 90% functions, and 90% lines
across TypeScript server code, extraction modules, and updater modules.
