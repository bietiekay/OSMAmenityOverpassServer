# OSMAmenityOverpassServer — TODO and Status Tracking

**Status:** October 15, 2026. Local implementation and acceptance of
[`ZIEL-PROMPT.md`](ZIEL-PROMPT.md) are complete (Sol: planning/review; Luna:
coding).

**Legend:** ✅ complete · 🔄 in progress · ⬜ open · ⛔ deferred/blocked

**Reference plan:** [`2026-10-14-osm-amenity-overpass-server.md`](2026-10-14-osm-amenity-overpass-server.md).
Round 4 (§19) supersedes the Stage 1/2/3 design in §6; §19.8 is the canonical
order of next steps in that plan. The top-level status below is authoritative
where older entries later in this file conflict with it.

## Current implementation — authoritative acceptance status

See the [work brief](ZIEL-PROMPT.md).

**Accepted:** 260 tests across 37 files passed; both `npm run verify` and
`npm run test:ci` succeeded. Coverage: **92.98% statements, 85.03% branches,
90.86% functions, 97.38% lines**. The unchanged 90/85/90/90 gates passed.
Japan acceptance covered 32,293 main objects, 6,720 shards, a complete source
comparison, HTTP E2E, and proxy E2E. See the [local acceptance report](2026-10-15-abnahme.md)
for measurements and limitations. Older failed coverage runs and open
implementation items below document the work history and have been superseded
by this acceptance. Remaining external evidence: Docker, a full-planet run,
and public Overpass parity.

## Documentation and deployment follow-up

- ✅ All repository documentation is in English; dated filenames are retained
  for link compatibility. Current setup and operating instructions are in
  [the operations guide](../docs/OPERATIONS.md); module/data-flow details are in
  [the architecture guide](../docs/ARCHITECTURE.md).
- ✅ Native commissioning, example environment/systemd unit, Docker commands,
  monitoring, source rotation, backup, restore, rollback and retention documented.
- ⬜ Before planet production, add an aggregate byte cap for the shared update
  geometry member cache. The existing 64 MiB resolved-object check applies per
  lookup invocation and is not a bound on total updater memory. This limitation
  was identified during the documentation review after local acceptance.

## Implementation and verification history

- ✅ Git state checked: commit `e6c9859` (`initial`) exists.
- ✅ Baseline run: `npm run verify` and `npm run test:ci` passed with 80 tests
  each. At that point the coverage gate was ineffective: thresholds were in
  the wrong place and expressed as fractions instead of percentages. A green
  run did not establish that required coverage had been met.
- ✅ `osmium fileinfo` checked the Japan source: 2,553,517,967 bytes,
  data timestamp `2026-10-14T20:21:12Z`, regional replication at
  `https://download.geofabrik.de/asia/japan-updates`, sequence **4939**. This
  is **not** a global minute cursor.
- ✅ Local prerequisites at measurement time: Node 22.23.3, npm 10.8.2,
  osmium 1.14.0, and redis-server. Free space measured as 75 GB on `/home` and
  20 GB on `/ssdbuffer`; older disk measurements no longer applied. No Docker
  dependency was needed.
- ✅ Reproduced and corrected the `tags-filter` diagnosis: a fixture with the
  default referenced-object completion yielded 13,791 nodes / 658 ways /
  40 relations; `-R` yielded exactly 10,000 / 500 / 40 and no non-matches.
  The 3,949 additional objects were expected references, not an established
  bug. The planned streaming extraction design was retained.
- ✅ Luna interface package: strict QL parser, GET, type filtering,
  `(type,id)` identity, output/member behavior, errors, OAM index, and gates.
- ✅ Luna pipeline package: CLI and Stages 0–3, streaming parser, worker/RAM
  budgets, cancellation, resume, and verification.
- ✅ Luna assembly package: Stage 4 with disk-backed lookups, bounded RAM,
  helper objects, and atomic index generations.
- ✅ Fixture regenerated: `npm run make-fixture -- --verify` passed; source and
  chunks each contained 100,000 nodes / 10,000 ways / 1,000 relations.
- ✅ Independent Japan source counts: 324,798,135 nodes, 46,719,361 ways,
  251,313 relations (`osmium fileinfo -e -j`). `tags-count` found 1,432,885
  objects with an `amenity` key. Native `tags-filter -R` counts for all
  amenities and `toilets` are under `/home/osm-amenity/japan/verification/`.
- ✅ Independent amenity counts by type: all values **678,906 nodes /
  745,991 ways / 7,988 relations**; `toilets` **19,828 / 12,407 / 58**,
  totaling **32,293** unique toilet main objects.
- ✅ Integration/review of all packages and an effective coverage gate
  demonstrated.
- ✅ Coverage negative test: nine passing config tests plus explicitly set
  100% thresholds returned exit 1 with coverage errors. The repaired threshold
  configuration enforced a gate; the actual 90/85 targets still had to be met
  after productive code was complete.
- ✅ First complete fixture run through Stages 0–4 with `--verify`: 10,540
  unique main objects (10,000 nodes / 500 ways / 40 relations), 144 shards;
  subsequent source/chunk counts matched. This was not yet Japan acceptance.
- ✅ Full Japan Stages 0–4 run started with `--verify`, 256 MiB chunks, an 8 GiB
  total budget, and 2 GiB worker budget. Process-tree RSS and disk were
  measured; log `verification/extract-full.log`, PID file `extract.pid`, and
  final metrics `extract-metrics.json` were under `/home/osm-amenity/japan/`.
- ✅ First real HTTP fixture smoke test: recursive tile query returned 200 and
  301 elements; node-only GET returned 200 and 38 nodes; ETags were present.
  Status testing found a missing manifest count; the builder added
  `totalElements`, and re-verification followed.
- ✅ Initial proxy E2E used the unchanged proxy checkout and local Redis on the
  fixture: tile query 200 / 55 elements, controlled fallback after 501 returned
  200, recovery HEAD returned 200. The proxy was installed and built from its
  existing lockfile without source changes. Harness/results:
  `verification/proxy-smoke.mjs` / `proxy-smoke-results.json`.
- ✅ Japan Stage 1 SIGINT test: process stopped, no osmium children remained,
  no later stages started, and the Stage 0 marker remained. First run took
  312.35 s with peak process-tree RSS 291.50 MiB. Evidence:
  `verification/extract-abort.log` / `extract-abort-metrics.json`.
- ✅ Japan resumed with actual Node worker processes rather than XML parsing in
  the shared event loop; worker RSS monitoring included osmium.
- ✅ Japan Stage 1 completed: native source counts and independent line-file
  counts matched exactly: N 678,906 / W 745,991 / R 7,988. Worker run through
  the Stage 2 transition took 688.77 s with peak process-tree RSS 732 MiB.
- ✅ A real Japan run exposed two osmium edge cases: `getid` returns exit 1 with
  valid XML for missing chunk-local IDs; `fileinfo -e --json` fails on way-only
  chunks because their bbox JSON is undefined even though the data and
  human-readable counts are valid. Fixes and regression tests passed; resume
  retained completed Stage 1 packages.
- ✅ Manifest migration and resume verified against real data: Stage 0 checks
  SHA, block count, and size while preserving all Stage 1 results; Stage 1
  skips all ten packages. Japan Stage 2 completed, then Stage 3 started.
- ✅ RAM protection verified against real data: native Node `getid` exceeded
  2 GiB per worker with modern IDs above 14 billion and was terminated; the
  cursor and active index were not published. Evidence:
  `extract-rss-limit.log` / `extract-rss-limit-metrics.json` (22.02 s,
  5.80 GiB peak process-tree RSS).
- ✅ Stage 3 now uses numerically sorted OPL/ID streaming reconciliation rather
  than memory-heavy `getid` bitmaps. A real high-ID fixture with IDs above
  14 billion passed Stages 0–4; Japan resumed with the same configuration.
  The 2 GiB worker budget remains.
- ✅ Full Japan Stages 0–4 run with `--verify` passed (exit 0): 2,265.46 s
  (37 min 45 s), peak process-tree RSS 1,096.40 MiB, maximum sampled disk use
  4,324,698,893 bytes. Results: 6,720 shards / 32,293 unique toilet main
  objects / 187 unique helper objects / 61 spatial duplicates / 32,541 shard
  records.
- ✅ Full integrity scan of all 6,720 shards with the current reader: valid
  CRC/configuration hash; main objects exactly N 19,828 / W 12,407 / R 58.
  Evidence: `verification/shard-integrity.json`.
- ✅ Complete semantic Japan parity against independent native extraction:
  all 32,293 main objects compared by type/ID, version, timestamp, tags,
  ordered node/member references, and coordinates. Including spatial copies,
  32,350 main records and 12,463 way geometries were checked with no mismatch.
  Evidence: `verification/full-source-parity.json`.
- ℹ️ The measured 37 min 45 s was a successful resume; completed Stage 1/2
  outputs were reused. It is not a clean full-build timing.
- ✅ Independent native chunk counts: all ten chunks exactly 324,798,135 nodes /
  46,719,361 ways / 251,313 relations. Evidence:
  `verification/chunk-counts.json`.
- ✅ Real Japan HTTP test on port 18083 with the matching regional update
  source: 20 Tokyo reference nodes matched field by field; GET/POST, JSON/XML,
  ETag, errors, status, and HEAD passed. Status: regional sequence 4939, global
  minute cursor 0, correct source timestamp.
- ✅ Proxy E2E repeated against Japan: tile query 200 / 20 elements, controlled
  501 fallback 200 / one fallback request, recovery HEAD 200.
- ✅ Integration check: `npm run verify` passed again with 156 tests. Overall
  work was not yet complete at that point: update/recovery review findings,
  weekly re-extract, and coverage gates remained open.
- 🔄 Next full run at that historical point: 186 tests passed;
  `npm run test:ci` was expectedly red at 84.70% statements, 76.31% branches,
  82.69% functions, and 90.21% lines. Operational/lifecycle/error tests were
  added; productive update and extraction modules stayed in the coverage gate.
- ✅ Cache review removed the additional, unbounded set of every generation/cell
  key ever loaded. Invalidation now scans only entries actually held by the
  bounded LRU.
- ✅ Delta store: copy-on-write, restart, cache eviction, and compaction received
  additional checks. A partition that remains too large after compaction aborts
  the private update build instead of publishing unreadable data.
- ✅ Implemented the existing `npm run parity` command, which previously
  pointed to a missing file: explicit local/reference endpoints and query file;
  full comparison by `(type,id)` with differing objects and source timestamps
  diagnosed. Comparison and HTTP-error tests passed.
- ✅ Japan lifecycle test with the new bootstrap: start from `/tmp`, successful
  status HTTP, SIGTERM exits 0 and stops the update worker without orphans in
  0.015 s. Evidence: `verification/lifecycle-smoke.json`.
- ✅ Real Japan HTTP geometry/member samples: way `291429213` (8 elements) and
  relation `14049126` (40 elements) checked in JSON and XML with metadata,
  ordered references, geometry, and recursively emitted way nodes. Evidence:
  `verification/http-way-relation.json`.
- ✅ Native CLI re-index on a small Japan-coordinate fixture: initial `toilets`
  selection yields one main object; Stage 4 alone with `drinking_water` yields
  two. Stages 1–3 were reused and a new generation activated atomically.
  Evidence: `/home/osm-amenity/reindex-smoke/`.
- ✅ Generation lock changed to Linux `flock` with a persistent lock inode;
  the kernel releases it even after SIGKILL. No stale-lock reaper is needed.
  Real subprocess/SIGKILL recovery test passed. Files and nested directories in
  the private tree are synced before publication.
- 🔄 Sol's follow-up review fixed and tested source rotation after weekly
  rebuilds, equal-size PBF replacement detection, and preservation of the
  global cursor on a zero-gap rebuild. The source-index cache also recovers
  from a temporarily incorrect PBF without manual deletion (regression passed).
- ✅ Coordinated `npm run verify` after review fixes: 238 tests across 33 files
  passed, including lint and build.
- 🔄 Coverage at the same historical point: 91.35% statements, 82.79% branches,
  89.80% functions, and 96.66% lines. Branch/function thresholds were still
  below target; additional error-path tests followed.
- ℹ️ Scaling limits were explicitly documented: each update batch performs a
  hardlink copy and complete inventory/shard checks with exact recounting;
  dependency/rebuild caches are bounded, but old generations are not
  automatically retained/cleaned. No planet throughput evidence exists.
- ✅ Earlier review integration: `npm run verify` passed with 120 tests across
  15 files. Coverage remained open then; productive pipeline/update code was
  still growing and remained in the gate.
- ⬜ Public Tokyo parity: the attempt against overpass-api.de returned HTTP
  **406**. An independent native reference extraction is available at
  `verification/toilets-reference.osm.pbf`; source-based Tokyo checks and full
  parity of all main objects passed.
- ✅ Persistent updates, including baseline/region model and recovery,
  implemented; final regressions and coverage passed in the accepted state.
- ✅ Coordinated re-extract with catch-up implemented; real worker E2E on a
  small PBF with local replication HTTP and Sol follow-up review passed.
- ✅ README, specification, and original prompt were updated to the implemented
  state; review fixes were incorporated as they landed.
- ⛔ Full-planet run and Docker E2E deferred to a suitable environment.
  Planet scalability still requires validation.

## 1. Repository foundation (Phase 0) — historical checklist

This section records the earlier implementation plan and its status when
written. Where it conflicts with the accepted status above, the acceptance
section supersedes it.

- ✅ Analyzed Overpass-Proxy v1.5.0 and verified upstream contract
  (`buildTileQuery` L18–29, `fetchTile`, `proxyTransparent`, `withUpstream`,
  `shouldMarkFailure`, `probeUpstream`, `OverpassResponse`) → plan §17.
- ✅ Wrote plan R3 + R3.1; appended R4 (October 15, 2026: Japan pivot,
  osmium 1.14 findings, new Stage design §19).
- ✅ Moved plan from `agents/plans/` to `plans/` (user decision, October 15,
  2026).
- ✅ Initial scaffold: `package.json` (Vitest **pinned exactly to 4.0.16** —
  §18.6), `tsconfig.json`, `vitest.config.ts` (then-incorrect coverage gates
  0.9/0.85/0.9/0.9), `eslint.config.js`, `.gitignore`, `LICENSE` (matching
  Overpass-Proxy), `Dockerfile` (then node:20-alpine, two stages),
  `docker-compose.yml.template`.
- ✅ Initial `src/`: logger, config, query, output, index/{geohash, shard
  (OAM1), engine, apply}, replication, stats, server, index.
- ✅ `scripts/extract.mjs` Stage 0 (block split, dual PBF-framing scanner,
  done marker, SIGINT/SIGTERM, resume, `--verify`).
- ✅ `scripts/make-fixture.mjs` (deterministic LCG fixture + Stage 0 verify).
- ✅ Tests: 10 files, **80/80 passed**; `npm run verify` (lint + build + tests)
  passed.
- ✅ Added `@vitest/coverage-v8` 4.0.16 as a dev dependency, exactly pinned to
  Vitest; before that, `test:ci` could not run (“MISSING DEPENDENCY”).
- ⬜ Historical first-commit checklist: `master` had **0 commits**; wait until
  step §19.8.7 (Japan full run + verification + E2E). This statement was
  superseded: commit `e6c9859` already existed.
- ⬜ Historical request to update README/Specification after Stages 1–4 landed
  (they then contained `--planet-source`, planet download instructions, and
  “stage 0 + stubs” notes); later documentation updates superseded it.

## 2. Data and sources — historical notes

- ✅ Installed osmium-tool 1.14.0 (libosmium 2.18.0; zlib/lz4/none).
- ✅ Downloaded the 167 GB planet `planet-latest.osm.bz2` on October 14, 2026
  and verified MD5 `b8ae8035c85335bae7186059ab5fbeaf`; **deleted October 15,
  2026** by user decision to use Japan for development/testing (§19.1).
- ✅ Japan PBF: Geofabrik `japan-latest.osm.pbf` → `japan-261014.osm.pbf`
  (October 14, 2026 dump, 2.55 GB) →
  `/ssdbuffer/osm-amenity/planet/japan-latest.osm.pbf`.
- ⬜ Historical fixture regeneration item: on-disk files came from an older
  generator version (building count 8,571 vs expected 7,143, §19.7); it had to
  be regenerated with `npm run make-fixture -- --verify` before first commit.
  Regeneration later passed.
- ⛔ Global `amenity` counts via taginfo were unavailable from the sandbox and
  were deferred to a network-enabled machine (Japan reference: 1,432,136
  objects, all values). Later Japan counts are recorded above.

## 3. Pipeline Stages 0–4 — original design checklist

- ✅ **Stage 0** — block split (byte copy, OSMHeader per chunk, atomic
  temporary-file + rename, resume).
- ⬜ **Stage 1** — `osmium cat chunk.pbf -f osm` → temporary OSM XML → pure Node
  streaming filter → `stage1/amen_cNNNN.lines` + `stage1/ids_cNNNN.lines`.
  The design was complete (plan §19.3/§19.4), implementation not yet started
  at that historical point. The then-recorded decision said `tags-filter` was
  unusable due to a §19.2 bug, with no Lua workaround (`osmium run` was absent
  from that build). The top-level history corrects this diagnosis: the extra
  objects were expected reference completion; the streaming design was kept.
- ⬜ **Stage 2** — global way IDs (`W` lines) → `osmium getid
  --default-type way` per chunk → `stage2/ways_cNNNN.xml` → parse → merge way
  lines and node references into the node-ID set.
- ⬜ **Stage 3** — global node IDs → `osmium getid --default-type node` per
  chunk → `stage3/nodes_cNNNN.xml` (ID → lat/lon).
- ⬜ **Stage 4** — pure Node: line files + node map → cell assignment (plan
  §19.5) → `stage4/cells/<geohash>.rec` (u32le length + record) → call
  `writeShard()` from `dist/index/shard.js` per cell (run `npm run build`
  automatically if `dist/` is absent) → atomically write `data/shards/*.bin`,
  `manifest.json`, and `state.json` (`lastSeq: 0`, `dataTimestamp` from source
  mtime). The deployed implementation uses JSONL cell spools and source
  timestamps; see the acceptance and review reports.
- ⬜ Historical Vitest requests: XML stream filter, line-format parser
  (round-trip, encoded tags, empty role, zero tags, missing timestamp), Stage 4
  assembly (cell assignment, way/relation duplication, member placement,
  deduplication, manifest/state), with coverage gates. These were subsequently
  implemented and covered.
- ⬜ Historical Japan run command and checks are preserved in
  [`ZIEL-PROMPT.md`](ZIEL-PROMPT.md); the run later passed, as documented above.
- ⛔ Full-planet production run deferred by user on October 15, 2026; the plan
  called for at least 200 GB free (§19.6). The pipeline is source-independent,
  with no Japan-specific code path, but a planet run remains untested.

## 4. Server and endpoints — original checklist

- ✅ Fastify: `POST/GET /api/interpreter` (501 `out of scope`, 400 for missing
  `data`), `GET /api/status` (Overpass-compatible block + `localEngine`),
  `GET /api/timestamp`, `POST /api/kill_my_queries` (200 no-op), and 2xx HEAD
  on the base URL.
- ✅ Engine: LRU byte cache (256 MB default), bbox filtering, typed identity,
  JSON/XML renderer, ETag.
- ✅ Real Japan E2E and unchanged proxy E2E later passed; see acceptance report.

## 5. Update pipeline — original checklist

- ✅ Initial helpers/tests: `replication.ts` (`state.txt` parsing, minute URL
  construction, catch-up list) and `apply.ts` (version guard,
  `upsertElement`/`deleteElement`, affected cells).
- ✅ Persistent update loop, shard rewrite, regional/global cursor handling,
  recovery, and weekly re-extract/catch-up were implemented later; see current
  status and acceptance report.
- ⬜ Optional follow-up: `OSM_AMENITY_REDIS_URL` tile-key invalidation in proxy
  Redis after each batch.

## 6. Operations and measurement — deferred work

- ⬜ TTL measurement (§9): collect p50/p95 latency, shard-cache hit rate, and
  batch times, then tune 24 h → 6 h → 1 h → 15 min based on data (at least
  24 hours per trial).
- ⬜ Public parity against live Overpass is network-dependent; a real Tokyo
  attempt returned HTTP **406**. `npm run parity` is available for retries.
- ⬜ Performance benchmark: shard load, query p50/p95, and update batch using a
  real hourly file.
- ⛔ Full Docker Compose stack (`proxy` + `redis` + `amenity-server`) with Japan
  data remains untested because Docker was unavailable.

## 7. Longer-term goals beyond Japan

1. Planet index through the same pipeline (`--source planet-latest.osm.pbf`),
   plan §19.1/§19.6.
2. Self-updating server: minute catch-up, freshness ≤1 hour, canonical cursor
   equal to minute sequence → `/api/status.osm_osm_change` (§18.2). Regional/day
   mode remains explicitly distinct.
3. Prefer the amenity server as a proxy upstream by EWMA latency; retain the
   remote pool as fallback.
4. Tune cache TTL using measured data.
5. Optional extensions: more keys (Stages 1–4 only), Redis invalidation,
   hour/day diff catch-up, relation-to-relation resolution (§19.5).
