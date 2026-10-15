Create a **new standalone project**, named `OSMAmenityOverpassServer`, that is a
**self-updating, Overpass-compatible amenity data server** with a geohash-sharded
on-disk index. It must serve worldwide OSM data for a pre-configured set of
amenity values (starting with `amenity=toilets`) so that an existing,
**unmodified** [Overpass-Proxy](../Overpass-Proxy) can consume it purely via its
`UPSTREAM_URLS` configuration.

This prompt is the self-contained specification for the entire project.

---

## 📁 Folder placement

```
/
├── Overpass-Proxy/              # existing, v1.5.0 — must remain unmodified
└── OSMAmenityOverpassServer/    # you create everything here
```

The project must be fully self-contained: plan documents, agent setup notes,
specs, Dockerfile/compose template, license (identical to Overpass-Proxy), and
the complete source.

---

## 🧩 Project overview

Build a **standalone Overpass-compatible server** that:

- serves one specific Overpass query shape — the geohash-tile amenity query the
  proxy generates (`node["amenity"="X"](s,w,n,e);` per type, bbox tuple,
  `out body meta; >; out skel qt;`) — answered from a local index,
- answers every other query with `501 {"error":"out of scope"}` so the proxy
  fails over to its remote Overpass pool (proxy contract: 5xx/429 = failover;
  the proxy retries 403/408/413/5xx twice and probes upstreams with `HEAD`),
- keeps its data fresh from **OSM minute replication diffs** with minimal
  recurring work,
- can be re-built from a retained planet source (full re-extract), and
- exposes a diagnostic interface so data freshness is externally monitorable
  in a way conformant with other Overpass servers.

---

## ⚙️ Functional scope

### Serving
- Implement the Overpass endpoints the proxy needs:
  - `POST /api/interpreter` (form field `data`) and `GET /api/interpreter`
  - `GET /api/status`, `GET /api/timestamp`
  - `POST /api/kill_my_queries` (200 no-op — no local query queue)
  - `HEAD` on the base URL → 2xx (upstream recovery probe)
- Query handling:
  - Parse the QL subset (see `specification.md` §1); in-scope iff single
    configured amenity value, single bbox, node/way/relation set commands,
    `out body/skel/tags/geom [meta] [qt]`, optional `>;`.
  - In-scope → `200` with Overpass JSON or XML + `ETag`.
  - Out-of-scope → `501 {"error":"out of scope"}`.
  - Missing/blank `data` → `400 {"error":"missing query in form field \"data\""}`.
- Member nodes from `>;` are served skel/quiet (coords only, no tags) from
  inline member coordinates stored in the shard — no cross-shard fetch.

### Data source and updates
- One-time build from the OSM planet (PBF, produced locally from
  `planet-latest.osm.bz2` via osmium because planet.openstreetmap.org no
  longer serves PBF).
- Ongoing updates: always from **minute replication files**
  (`minute/NNN/NNN/NNN.osc.gz`, `state.txt` with `sequenceNumber`); the loop
  interval (default hourly) only controls catch-up frequency.
- The canonical data-age cursor is the **minute sequence number**; hour/day
  file catch-up is out of scope (counters are not interconvertible).
- Periodic full re-extract as drift guard (default weekly).
- New amenity values are re-derivable from retained raw data without a
  new planet download.

### Diagnostic interface (external monitoring)
- `GET /api/status` must contain a conformant Overpass block:
  `version`, `osm_osm_change` (minute sequence of applied data as string,
  `"0"` when empty), `time_used`, `memory_used` (RSS bytes), `output_format`.
  An external monitor compares `osm_osm_change` against the live
  `minute/state.txt` `sequenceNumber` to measure staleness.
- Add a non-standard `localEngine` extension: shard/element counts, amenities,
  shard precision, lastSeq/lastUpdate/dataTimestamp, update configuration,
  and live stats (queries, errors, shard cache hits/misses, latency p50/p95,
  last query time).

### Data pipeline
- Iterative, abortable, RAM-bounded (no unbounded allocation), splittable
  into work packages, resumable, parallelizable across cores/machines.
- Stage 0: pure-TypeScript PBF block scanner + byte-copy chunking
  (supports both the osmium ≥ 1.14 "new" PBF framing and the classic framing);
  `--verify` re-counts objects with osmium and requires equality with the
  planet file.
- Stages 1–3: amenity extraction (osmium + Lua), member merge + coordinates,
  shard assembly — parallel per chunk / shard group, done-marker resume.
- Disk: PBF (~89 GB) + final shards on the small volume; transient bz2
  (~167 GB) + chunk work (~90 GB) on the big volume.

---

## 🗄️ Data model

- Geohash shards, precision 5 by default (one proxy tile = one shard).
- Custom binary format **OAM1** (pure TS, `DataView`, no native deps):
  78-byte header (magic, version, geohash, count, section offsets, build
  sequence, config hash, crc32), string pool, element records (51-byte base +
  inline way member coordinates + relation members), id index, node-ref
  index. Nodes live in exactly one shard; ways/relations are duplicated into
  all intersecting cells.
- Bookkeeping: `state.json` (lastSeq, lastUpdate, dataTimestamp),
  `manifest.json` (totalElements), `work/` pipeline scratch.

---

## 🧠 Technical stack

- **Language:** Node.js 20+ + TypeScript (strict, NodeNext)
- **Server:** Fastify + `@fastify/formbody`
- **Geo:** `ngeohash`
- **Logging:** pino
- **Planet tooling:** osmium-tool (offline use only)
- **Tests:** Vitest (unit) + Supertest (integration)
- **Linting:** ESLint 9 (flat config) + TypeScript
- **No** Redis dependency for the core (optional Phase-2 hook only)

---

## 🗂️ Required files and structure

```
OSMAmenityOverpassServer/
├── src/
│   ├── index.ts               # bootstrap: config -> engine -> server
│   ├── config.ts              # OSM_AMENITY_* env loader
│   ├── server.ts              # endpoints + conformant status
│   ├── query.ts               # in-scope QL subset parser
│   ├── output.ts              # JSON/XML Overpass renderers + ETag
│   ├── replication.ts         # state.txt parse, minute URL, catch-up list
│   ├── stats.ts               # percentiles + counters
│   ├── logger.ts              # pino wrapper
│   └── index/
│       ├── geohash.ts         # bbox <-> cell math
│       ├── shard.ts           # OAM1 write/read/verify, crc32, config hash
│       ├── engine.ts          # query engine + shard LRU byte cache
│       └── apply.ts           # minute-diff apply decisions
├── scripts/
│   ├── extract.mjs            # stage 0 (complete) + stages 1–3 (pipeline)
│   └── make-fixture.mjs       # synthetic planet + stage-0 verify
├── tests/                     # one test file per src module
├── plans/
│   ├── 2026-10-14-osm-amenity-overpass-server.md  # plan (R3 + R4: Japan dev target, osmium findings, stage design)
│   └── TODO.md                                # status tracking of every planned step (living document)
├── Dockerfile                 # 2-stage, node:20-alpine
├── docker-compose.yml.template
├── LICENSE                    # same license as Overpass-Proxy
├── README.md
├── specification.md           # wire + data-format contracts
├── OSMAmenityOverpassServer-Prompt.md
└── package.json / tsconfig.json / eslint.config.js / vitest.config.ts
```

---

## 🧪 Test coverage (mandatory)

- **Unit tests:**
  - QL parser: tile shape, all amenity spellings, foreign tag filters,
    out-clause matrix, malformed input.
  - Geohash tiling: bbox→cells, cells→bbox, intersection, edge cells.
  - OAM1: round-trip write/read/verify, crc32 failure, wrong magic/version,
    config-hash mismatch.
  - Engine: node/way/relation queries, member skel dedupe, cache hit/miss.
  - Replication: state.txt v2/v3, minute URL split 3/3/1, catch-up lists.
- **Integration tests (Supertest against the running app):**
  - Tile query → 200 JSON with expected elements + ETag.
  - Out-of-scope (other amenity, other tag) → 501.
  - Missing `data` → 400.
  - `/api/status` conformant block + `localEngine`.
  - `/api/timestamp`, `/api/kill_my_queries`, HEAD base URL.

Coverage targets:
- Lines ≥ 90%, Branches ≥ 85%, Functions ≥ 90%, Statements ≥ 90%.
- The coverage gate must fail the run when not met.

---

## 🧩 Configuration (ENV)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8081` | Listen port |
| `OSM_AMENITY_DATA_DIR` | `.` | Shard + state directory |
| `OSM_AMENITY_AMENITIES` | `toilets` | Comma-separated amenity values |
| `OSM_AMENITY_SHARD_PRECISION` | `5` | Geohash precision (3–7) |
| `OSM_AMENITY_SHARD_CACHE_MB` | `256` | Shard LRU byte cache |
| `OSM_AMENITY_UPDATE_INTERVAL_SECONDS` | `3600` | Catch-up loop wake interval |
| `OSM_AMENITY_UPDATE_BASE_URL` | `https://planet.openstreetmap.org/replication` | Minute replication base URL |
| `OSM_AMENITY_REEXTRACT_EVERY_SECONDS` | `604800` | Drift-guard re-extract period |
| `OSM_AMENITY_REDIS_URL` | — | Optional Phase-2 invalidation hook |
| `LOG_VERBOSITY` | `info` | `errors` / `info` / `debug` |

---

## 🧰 Docker setup

- `Dockerfile`: 2-stage build (`node:20-alpine`), runtime image without the
  public web dir, runs `node dist/index.js`.
- `docker-compose.yml.template`: server container with a named volume for
  `OSM_AMENITY_DATA_DIR`; ready to add to the existing proxy stack.

---

## 📜 README contents

Include:
- Overview (purpose, architecture, why 501 fails over cleanly).
- Endpoint documentation + example curl commands.
- Environment variables.
- Planet pipeline (download → md5 → osmium convert → stage 0 → verify).
- How to run locally and in Docker.
- How to run tests.
- Disk layout guidance.
- Known limitations / open items.

---

## ✅ Acceptance criteria

1. The project builds independently: `npm run build`, `npm run lint`,
   `npm test` all pass.
2. The existing Overpass-Proxy (v1.5.0) works against this server
   **unmodified**, solely via `UPSTREAM_URLS`.
3. Tile queries for configured amenity values return correct Overpass
   JSON/XML with ETag; other queries return 501.
4. `GET /api/status` exposes `osm_osm_change` conformant with other Overpass
   servers so external monitoring can measure data staleness.
5. Stage 0 produces valid chunks: osmium object counts of the chunks equal
   the planet file's counts (`--verify`).
6. The pipeline is resumable (done markers) and abortable (SIGINT/SIGTERM).
7. Unit + integration tests pass with the coverage gate.
8. The repository contains plan, prompt, spec, Dockerfile, compose template,
   and license (same as Overpass-Proxy).

---

Generate the **entire folder structure and files** under
`/OSMAmenityOverpassServer/` according to the spec above.
