# OSMAmenityOverpassServer

A standalone, self-updating, **Overpass-compatible amenity data server** with a
geohash-sharded on-disk index. It serves worldwide OSM amenity data (starting
with `amenity=toilets`) and is designed to be consumed by
[Overpass-Proxy](../Overpass-Proxy) **without any modification of the proxy** —
integration happens purely via the proxy's `UPSTREAM_URLS` configuration.

```
 ToileFinder app ──▶ Overpass-Proxy ──▶ OSMAmenityOverpassServer (this repo)
                        │  UPSTREAM_URLS ──▶  /api/interpreter on port 8081
                        └───────────────────▶  remote Overpass pool (failover)
```

Out-of-scope queries (other amenity values, non-amenity tags, non-tile shapes)
answer `501 {"error":"out of scope"}` so the proxy fails over to the remote
pool transparently.

## Why this exists

The proxy in front of the ToiletFinder app needs a *local, always-available,
low-latency* source for the one query shape it actually generates (the
geohash-tile amenity query). A full Overpass instance is expensive to run and
to keep fresh; this server stores exactly the pre-configured amenity values,
serves them from a geohash shard index (one proxy tile = one shard), and keeps
itself up to date with OSM minute replication diffs — with minimal recurring
work.

## Repository layout

```
OSMAmenityOverpassServer/
├── src/
│   ├── index.ts               # entry point: config -> engine -> server
│   ├── config.ts              # OSM_AMENITY_* env config
│   ├── server.ts              # Fastify app: interpreter/status/timestamp/kill
│   ├── query.ts               # in-scope QL subset parser (tile query shape)
│   ├── output.ts              # Overpass JSON/XML renderers + ETag
│   ├── replication.ts         # minute replication state/URL/catch-up helpers
│   ├── stats.ts               # latency p50/p95, cache hit/miss, errors
│   ├── logger.ts              # pino wrapper
│   └── index/
│       ├── geohash.ts         # bbox <-> geohash cell math (precision 5)
│       ├── shard.ts           # OAM1 binary shard writer/reader/verifier
│       ├── engine.ts          # query engine + shard LRU byte cache
│       └── apply.ts           # minute-diff apply decisions (upsert/delete)
├── scripts/
│   ├── extract.mjs            # planet extraction pipeline (stage 0 + stubs)
│   └── make-fixture.mjs       # synthetic planet for tests / stage-0 verify
├── tests/                     # vitest (unit + integration), 80 tests
├── Dockerfile                 # 2-stage build (node:20-alpine)
├── docker-compose.yml.template
├── LICENSE                    # same license as Overpass-Proxy
├── specification.md           # wire contracts + data formats (OAM1, status, ...)
└── OSMAmenityOverpassServer-Prompt.md  # project prompt (self-contained spec)
```

## Requirements

- Node.js >= 20 (tested with 22.x)
- For planet extraction only: `osmium-tool` (>= 1.14) for PBF conversion and
  object-count verification. The server itself has **no native dependencies**.

## Quick start (fixture)

```bash
npm install
npm run build

# generate a synthetic planet and validate stage 0 (block split + counts)
npm run make-fixture -- --out-dir fixtures --verify

# run the server against the fixture data dir
OSM_AMENITY_DATA_DIR=fixtures/data npm start
```

## Planet pipeline (one-time + periodic re-extract)

Measured 2026-10-14: planet.openstreetmap.org no longer serves PBF; the
download is `planet-latest.osm.bz2` (~167 GB), converted locally with osmium:

```bash
# 1) download (resumable)
curl -fSL --retry 10 --retry-delay 10 --retry-all-errors -C - \
  -o /ssdbuffer/osm-amenity/planet/planet-latest.osm.bz2 \
  https://planet.openstreetmap.org/planet/planet-latest.osm.bz2

# 2) verify md5 (published on the planet page)
md5sum /ssdbuffer/osm-amenity/planet/planet-latest.osm.bz2

# 3) convert to PBF (output on the /home volume, ~89 GB)
osmium cat /ssdbuffer/osm-amenity/planet/planet-latest.osm.bz2 \
  -o /home/.../data/planet-latest.osm.pbf --overwrite

# 4) stage 0: block split into work chunks (byte copy, parallel, resumable)
node scripts/extract.mjs \
  --planet-source /home/.../data/planet-latest.osm.pbf \
  --data-dir /ssdbuffer/osm-amenity/data \
  --stages 0 --chunk-mb 1024 --verify
```

Disk placement (measured on the target machine):

| Volume | Free | Usage |
|---|---|---|
| `/home` | ~133 GB | PBF (~89 GB) + final shard data (~5 GB) |
| `/ssdbuffer` | ~183 GB | bz2 during download (peak 167 GB), then work/ + chunks (~90 GB) |
| `/hauswolke` | ~163 GB | overflow only |

## Configuration (environment)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8081` | Listen port (proxy tile queries arrive here) |
| `OSM_AMENITY_DATA_DIR` | `.` | Shard + `state.json` directory |
| `OSM_AMENITY_AMENITIES` | `toilets` | Comma-separated amenity values to serve |
| `OSM_AMENITY_SHARD_PRECISION` | `5` | Geohash precision (3–7); 5 = proxy tile size |
| `OSM_AMENITY_SHARD_CACHE_MB` | `256` | Shard LRU byte-cache size |
| `OSM_AMENITY_UPDATE_INTERVAL_SECONDS` | `3600` | Catch-up loop wake interval |
| `OSM_AMENITY_UPDATE_BASE_URL` | `https://planet.openstreetmap.org/replication` | Minute replication base URL |
| `OSM_AMENITY_REEXTRACT_EVERY_SECONDS` | `604800` | Drift-guard: full re-extract period (weekly) |
| `OSM_AMENITY_REDIS_URL` | — | Optional (Phase 2: direct tile invalidation via proxy Redis) |
| `LOG_VERBOSITY` | `info` | `errors` \| `info` \| `debug` |

## Endpoints

| Endpoint | Behaviour |
|---|---|
| `POST/GET /api/interpreter` | In-scope tile query (form field `data`) → 200 with Overpass JSON/XML + `ETag`. Out of scope → `501 {"error":"out of scope"}`. Missing/blank `data` → `400 {"error":"missing query in form field \"data\""}`. |
| `GET /api/status` | Conformant Overpass status block (`version`, `osm_osm_change`, `time_used`, `memory_used`, `output_format`) plus a `localEngine` extension (shards, elements, lastSeq, stats, ...) for external monitoring. |
| `GET /api/timestamp` | Data-sequence timestamp (text/plain; falls back to now). |
| `POST /api/kill_my_queries` | 200 no-op (no local query queue). |
| `HEAD /` (base URL) | 2xx — answers the proxy's upstream recovery probe. |

`osm_osm_change` is the **minute replication sequence number** of the applied
data — the canonical freshness field of other Overpass servers. An external
monitor compares it against the live `minute/state.txt` `sequenceNumber`.
See [specification.md](specification.md) for full contracts.

## Proxy integration

The proxy stays unmodified; it just gains this server as one of its upstreams:

```env
UPSTREAM_URLS=http://amenity-server:8081/api/interpreter,https://overpass.kumi.systems/api/interpreter
```

The proxy retries this upstream on 403/408/413/5xx and probes availability
with `HEAD` on the base URL; the `501 out of scope` answer is *not* retried
and triggers failover to the next upstream.

## Self-update loop

- Source: OSM **minute** replication files (`minute/NNN/NNN/NNN.osc.gz`),
  always — the canonical cursor is the minute sequence number.
- The loop wakes every `OSM_AMENITY_UPDATE_INTERVAL_SECONDS` (default hourly),
  reads `minute/state.txt`, and applies every missing minute file to the
  affected geohash shards (affected cells only; shard cache invalidated
  post-update).
- Hour/day file catch-up is a documented future optimization (the counters
  are not interconvertible — minute sequence stays the canonical cursor).
- A full re-extract runs every `OSM_AMENITY_REEXTRACT_EVERY_SECONDS`
  (default: weekly) as a drift guard against accumulated apply errors.

## Tests & verification

```bash
npm run lint      # eslint (src/**/*.ts)
npm run build     # tsc (strict, NodeNext)
npm test          # vitest run — 10 files, 80 tests
npm run verify    # lint + build + test (one command)
npm run test:ci   # vitest with coverage gate (lines >= 90%, branches >= 85%)
```

Stage-0 pipeline verification:

```bash
npm run make-fixture -- --out-dir fixtures --verify
# -> fixture planet: osmium object counts of the chunk files must equal
#    the counts of the fixture planet file (VERIFY OK)
```

## Known limitations / open items

- Stages 1–3 of the extraction pipeline (amenity extraction, member merge,
  shard assembly) are implemented against the OAM1 format in `src/index/` and
  validated on fixtures; the full-planet run executes after the planet
  download + conversion (see pipeline above).
- Minute-diff *apply* (osmchange parsing) is the Phase-2 item; the pure
  helpers (state parse, URL build, catch-up list, apply decisions) are
  complete and tested.
- Cache TTL starts at 24 h and is stepped down based on measured
  local-source performance (plan §9).
- Public Overpass parity checks must run on a networked machine.
