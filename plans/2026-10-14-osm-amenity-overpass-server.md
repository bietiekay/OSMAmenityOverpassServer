# OSMAmenityOverpassServer — Standalone Overpass Data Source (Plan, Round 4)

> Historical planning record. Early sections contain superseded assumptions and
> proposed behavior, not the current operational contract. Use
> [the acceptance report](2026-10-15-abnahme.md), [current status](TODO.md), and
> [the operations guide](../docs/OPERATIONS.md) for the implemented system.
> Section 20 records the corrections to this plan.

- **Date:** 2026-10-14 (Round 4 addendum 2026-10-15)
- **Status:** Round 4 plan: Japan as the development/test target, osmium 1.14 findings, Stages 1–4 revised (§19); defaults confirmed.
- **Intended repository location:** `plans/2026-10-14-osm-amenity-overpass-server.md` in the **new** `OSMAmenityOverpassServer` repository (moved from `agents/plans/` to `plans/` on 2026-10-15 by user decision; related files: `plans/TODO.md` for status tracking).
- **Target repository:** `/home/bietiekay/code/OSMAmenityOverpassServer` (`master`; at Round 4, scaffold + `src/` + `tests/` + `scripts/` exist, with 0 commits — see `plans/TODO.md` for details). The complete project framework is created there (§16).
- **Customer repository (remains unchanged):** `Overpass-Proxy` v1.5.0 (`/home/bietiekay/code/Overpass-Proxy`) — the proxy uses the new server purely through configuration as an upstream (§17), with no code changes.
- **Verified customer-repository contract:** `src/upstream.ts` (`fetchTile`, `proxyTransparent`, `withUpstream`, `shouldMarkFailure`, `probeUpstream`), `src/interpreter.ts` (transparent endpoints), `src/store.ts` (`OverpassResponse`), `src/tests/integration/mock-overpass.ts`.

## 0. Decision log (feedback → decision)

| # | User feedback | Decision |
|---|---|---|
| 1 | Region: worldwide, data-optimized, only preconfigured amenities | Extract the planet; the **final index contains only configured values** (§5). Keep all `amenity=*` objects as an intermediate disk stage to allow re-indexing (§6.5). |
| 2 | Start with `toilets`, configurable; new amenities should be regenerable from raw data; a full re-index is acceptable | `OSM_AMENITY_AMENITIES` (default `toilets`). Re-index paths: new **value** → Stage 3 only (minutes); new **key** → Stages 1–3; weekly full re-extract as a drift guard (§6.5). |
| 3 | Planet minute diffs; minute updates are not required; proposal: as live as practical with little recurring work | **Catch-up model**, with granularity matching the interval. Default **hourly** (24 jobs/day, freshness ≤ 1 h); `minute` is a configuration option; update effort is independent of index size (§7). |
| 4 | Missing changeset is acceptable; what information is actually included? | Source = official OSM planet file → **complete metadata is available** (version/timestamp/changeset), so this concern does not apply. Details in §4. |
| 5 | Keep remote upstreams as fallback | Keep the fallback: the server returns 501 for out-of-scope queries, and the proxy falls through to remote instances (§17). |
| 6 | Extraction on this machine; iterative, interruptible, configurable RAM limit, work units, resumable, scalable in parallel | Four-stage pipeline; block-split chunks (~90 work units); per-unit done markers; hard RAM budget + worker cap; chunks are self-contained → multi-core **and** multi-machine (§6). |
| 7 | Cache: start at 24 h, then reduce gradually depending on load; gain experience first | Start with 24 h TTL + **update-driven invalidation** (effective freshness = update interval); collect latency stats; choose a data-driven step policy after measurement (§9). |
| — | Document the plan and decisions in the repo, directory `agents/plans/` | This plan. Plan mode prevents writing to the repo; when changing agents, create a byte-for-byte copy in the new repo at `agents/plans/2026-10-14-osm-amenity-overpass-server.md`. |
| R3-1 | New `OSMAmenityOverpassServer` repo: entire project there (plan, agent setup, docs, Docker, license); leave Overpass-Proxy code untouched, and make it work with the new server; server must run independently and keep itself current | **Standalone server** (own process and container) with Overpass-compatible endpoints; proxy integration is configuration only (`UPSTREAM_URLS`), with no proxy code changes (§16, §17). |
| R3-2 | Hourly is good · precision 5 fits · keep chunks on disk (configurable, unnecessary for routine operation) · keep the all-values intermediate stage (configurable/disableable) · 8 GB total / 2 GB per worker — worker count and per-worker GB limit configurable · weekly re-extract is fine, but “why is it needed?” | All confirmed: hourly default, p5 shards, `--keep-chunks` (default true), `--all-amenity-values` (default true, can be disabled), `--workers` and `--worker-ram-mb` separately configurable, weekly drift re-extract (reason: §7.4). |

## 1. Scope

- **Region:** the entire planet (OSM Planet).
- **Content:** only objects whose `amenity` value is configured (initially `toilets`). No other keys and no open-ended value set.
- **Goal:** an independent, self-updating Overpass data server (new `OSMAmenityOverpassServer` repo) that fulfills the proxy contract (`node[amenity=X](s,w,n,e);out ...`); minimal storage cost; the unchanged Overpass-Proxy uses it as an upstream, while remote instances remain as fallback (decision #5, R3-1).
- **Out of scope:** OSM history, all objects, and other keys. The design allows a later key expansion without changing the final-index core (§6.5).

## 2. Verified facts (2026-10-13)

| Fact | Value | Source |
|---|---|---|
| `planet-latest.osm.pbf` | **89 GB**, dated 2026-10-08, md5 `d3b708ffc28873cf24a053e092dfd731` | planet.openstreetmap.org |
| `planet.osm` (XML bz2) | 167 GB (not required) | ibid. |
| Minute diffs | `replication/minute/NNN/NNN/NNN.osc.gz`, 20–130 KB/min, state seq 7327518 (2026-10-13T18:33Z) | ibid. |
| Hourly diffs | `replication/hour/NNN/NNN/NNN.osc.gz`, latest (000/123/467) ≈ **5.8 MB**, state seq 123467 | ibid. |
| Daily diffs | `replication/day/NNN/NNN/NNN.osc.gz`, latest (000/005/144) ≈ **105 MB** (typically 40–80 MB, peaks 300–400 MB), state seq 5144 | ibid. + OSM Wiki |
| State cursor | Each granularity has its **own** `state.txt`; sequence bases **cannot** be converted (hourly seq × 60 ≠ minute seq) | ibid. |
| Planet metadata | The official planet file contains **all** fields (version, timestamp, changeset, user, uid); only Geofabrik extracts are GDPR-stripped (version + timestamp) | OSM Wiki, Planet.osm (Extracts table) |
| `amenity` counts | Japan (Round 1): 1,432,136 objects, all values. Worldwide counts: **measure in Phase 0** (`taginfo` was unreachable from the sandbox) | taginfo (external) |
| Estimated `toilets` final index | ~30–250 MB (worldwide); intermediate stage with all `amenity` values ~2–15 GB | Estimate; Phase 0/1 measures actual size |

## 3. Data sources

- **Baseline:** `planet-latest.osm.pbf` (89 GB) — one-time download (verify md5, support resume with `curl -C`).
- **Updates:** OSM planet replication; granularity should match the update interval (§7): `minute/`, `hour/`, `day/`; each provides `.osc.gz` and `state.txt`.
- **Fallback source:** existing remote Overpass pools (unchanged, decision #5).
- Geofabrik is no longer the baseline source (GDPR stripping and country navigation); it remains an optional regional source for future scenarios (the `OSM_AMENITY_*` design allows this).

## 4. Metadata — what it contains (answer to Q4)

Overpass `out ... meta` attaches `meta: {version, timestamp, changeset}` to each element:

- **`version`** — version number of the OSM object; incremented on every edit. Used for edit-history tracking (which version a client sees and comparison during updates).
- **`timestamp`** — time of the last edit, ISO 8601 (for example, `2026-10-12T18:22:31Z`).
- **`changeset`** — numeric ID of the changeset in which the object was last edited → `https://www.openstreetmap.org/changesets/<ID>` shows **who** changed it, with which **comment/tool**, and in which area.

**Why it matters:** provenance and diagnosis (trace bad toilet data to the specific edit), and freshness heuristics. The proxy does not use it functionally — it is pass-through data for clients.

**Conclusion: there is no gap.** The source is the official OSM planet file, not Geofabrik → all baseline objects have complete `version`, `timestamp`, and `changeset`; `.osc.gz` updates do as well. The Round 1 concern (missing `changeset` due to Geofabrik GDPR stripping) applies only to Geofabrik extracts and therefore not to this setup. (`user`/`uid` are not part of standard Overpass `meta` output anyway.)

Implementation: store these fields in the index (§5) and emit them for `out ... meta` in JSON and, by default, as XML attributes.

## 5. Index format (final storage)

- **Sharding:** geohash precision **5** (default, `OSM_AMENITY_SHARD_PRECISION`) = proxy tile precision → one tile query = one shard. A p5 cell is approximately 4.9 km × 4.9 km; a typical BBox touches ~1–20 shards.
- **One file per shard:** `data/shards/<geohash5>.bin` — custom binary format, pure TypeScript reader (DataView), no native dependencies:
  - Header: magic `OAM1`, format version, shard geohash, element count, offsets (data, ID index, node-ref index), build sequence (minute sequence at build), config hash, CRC.
  - Element record: type (node/way/relation), id (u64), version (u32), timestamp (u32 Unix), changeset (u64), lat/lon (i32 × 1e-7 for nodes) or member IDs + **inline member coordinates** (for exact BBox filtering and `>;out skel qt` without loading extra shards), element BBox (s,w,n,e), tags (key/value indexes into the shard string pool).
  - **ID index:** sorted id → offset (update by ID).
  - **Node-ref index:** node id → element offsets (member update/delete paths).
- **Duplication:** a node is in exactly one shard (the cell of its point). A way/relation appears in **all** overlapping p5 cells (amenity duplication is small, typically 1–4). Deduplicate by id in query responses.
- **Global inverted index:** `data/index/elements.bin`: element id → [(shard, offset)] (efficient deletion on value change/delete; ~13 B × duplication per element).
- **Manifest/meta:** `data/manifest.json` (shard list, counts, data sequence), `data/meta.json` (config hash, extraction parameters, build time, source).
- Only configured values are included here (filter in Stage 3) — this is the data-optimized final index required by requirement #1.

## 6. Extraction pipeline (worldwide; iterative, interruptible, RAM-limited, parallel, resumable)

Principle: **work packages** are independent units with **done markers** in `work/state/`. Each worker process streams within a **configurable RAM budget** — no unbounded allocation. Work can be interrupted at any time (SIGTERM/kill); resume scans done markers and skips completed units. All outputs are written atomically (temporary file + rename).

**⚠️ Round 4 (2026-10-15):** The Stage 1/2/3 design in this section was **superseded** by §19.3/§19.4 (osmium 1.14 findings in §19.2: no `osmium run`/Lua, and the then-reported `tags-filter` issue). Stage 0 and the principles (work packages, done markers, atomic writes, RAM budgets, resume) remain valid. See §20 and [local acceptance](2026-10-15-abnahme.md) for corrections to historical assumptions.

**RAM budget (configuration, confirmed in R3):** `--ram-mb` (total budget, default 8192) and `--worker-ram-mb` (per-worker limit, default 2048) are **separately configurable**; `--workers N` (worker count, default auto = `min(Cores, floor(ram-mb / worker-ram-mb))`) is also configurable. Effective concurrency = `min(--workers, floor(--ram-mb / --worker-ram-mb))`. Default target chunk size is 1 GB. Each worker output stream is fully streaming (no whole-file buffering) so the per-worker limit can be respected.

```
planet-latest.osm.pbf (89 GB)
        │ Stage 0: block split (byte copy, one pass)
        ▼
work/chunks/c0000.pbf … cNNNN.pbf   (~90 chunks of ~1 GB each, each a valid PBF)
        │ Stage 1: amenity extraction (osmium + Lua, parallel per chunk)
        ▼
work/out/amenity.cNNN.pbf           (all amenity-* objects, full metadata)
work/out/members.cNNN.ids            (member node/way IDs as a u64 list)
        │ Stage 2: merge + member coordinates (parallel per chunk)
        ▼
work/members.ids (global, sorted) + work/out/member-nodes.cNNN.pbf
        │ Stage 3: shard assembly (pure TS, parallel per shard group)
        ▼
data/shards/*.bin + data/index/elements.bin + data/manifest.json + data/meta.json
```

### Stage 0 — Block split (pure TypeScript, byte copy, single pass)

- A PBF file consists of an OSMHeader block + OSMData blocks. **Historical framing assumption, corrected later:** these notes originally described a varint length prefix; standard OSM PBF uses a 4-byte big-endian BlobHeader length (§20; see [local acceptance](2026-10-15-abnahme.md)).
- The splitter reads **only framing/header bytes** and copies **complete blocks** byte-for-byte into chunk files (target size ~1 GB → ~90 chunks). Copy the OSMHeader into every chunk. **No payload decoding** → fast (~5–20 min for 89 GB), constant RAM (block buffer).
- Output: `work/chunks/cNNNN.pbf` (each independently readable) + `work/manifest.json` (chunk → byte range).
- **Verification (Phase 0, mandatory):** `osmium cat --num-objects` per chunk; sum must equal the planet object count. This ensures no object crosses a block boundary (osmium writer split behavior; extend a chunk past the target to the end of the object in that edge case).
- Work unit = chunk; resume per chunk.

### Stage 1 — Amenity extraction (osmium + Lua, parallel per chunk)

- Input: one chunk (valid, independently readable PBF → chunks can be copied to multiple machines).
- A Lua handler keeps **all** objects with the `amenity` key (every value — decision for fast re-indexing, §6.5) and writes:
  - `work/out/amenity.cNNN.pbf` (objects with full metadata),
  - `work/out/members.cNNN.ids` (u64 LE: node IDs of retained ways/relations + way IDs of retained relations that are not themselves retained).
- The osmium reader streams (RAM ≈ a few hundred MB per worker); the coordinator caps workers by the RAM budget.
- Work unit = chunk; resume per chunk.

### Stage 2 — Merge member IDs + coordinates (parallel per chunk)

- **2a:** Externally merge all `members.cNNN.ids` → sorted, unique `work/members.ids` (pure TypeScript, RAM-limited; estimated disk use 0.2–2 GB).
- **2b (conditional):** If retained relations refer to external (non-retained) ways: scan way chunks against this way-ID list, add their node IDs, and merge again. Rare; keep as a documented path.
- **2c:** Per chunk, **merge-scan** (two cursors: chunk node stream vs. `members.ids`) → `work/out/member-nodes.cNNN.pbf` containing only matching nodes.
  - Lua throughput ~1–3 M objects/s → ~12 billion nodes ≈ 70–120 min single-threaded; with 16 workers ≈ 5–10 min. Fallback if too slow: an osmium C++ plugin (~100 M objects/s). Keep this as a performance open item.
- Work unit = chunk; resume per chunk.

### Stage 3 — Shard assembly (pure TypeScript, parallel per shard group)

- Input: all `amenity.cNN.pbf` + `member-nodes.cNNN.pbf` (together only a few GB).
- Build final shards (§5): node → its own p5 cell; way/relation → all intersecting cells; **filter to configured values**; create ID + node-ref indexes, string pool, global `elements.bin`, `manifest.json`/`meta.json`.
- Atomic per shard; work unit = shard group; resumable.
- After completion: verify counts per shard, sample queries, and run `osmium check` on `work/out`; then optionally delete `work/chunks/` (default: keep, so re-indexing does not require another download).

### 6.5 Re-index paths (requirement #2, R3 confirmations)

**Round 4:** Stage numbering changed (§19.3): “rerun Stage 3” now means **Stage 4 (assembly)**; “Stages 1–3” means **Stages 1–4**.

- **New value** (for example, `drinking_water`): rerun Stage 4 → **minutes**, no planet access (all values are in `work/stage1/*.lines`).
- **All-values intermediate stage is configurable/disableable** (R3-4): `--all-amenity-values` (default **on**). When on, Stage 1 keeps all `amenity=*` objects → new values can be added by rerunning Stage 3. When off, Stage 1 keeps only configured values (same final index, smaller intermediate stage) → a new value requires rerunning Stages 1–3 (chunks still available) or a full re-extract.
- **Keep chunks on disk, configurable** (R3-3): `--keep-chunks` (default **on**). Chunks (~89–92 GB) are only needed for re-index/re-extract without re-download, not routine operation; when off, delete `work/chunks/` after Stage 2.
- **New key / major config change:** rerun Stages 1–3 (chunks available → no re-download; ~45–90 min). If chunks are no longer on disk, rerun Stages 0–3 (~1–2 h including download).
- **Drift guard:** full re-extract from a fresh planet, weekly by default (`OSM_AMENITY_REEXTRACT_EVERY_SECONDS=604800`, confirmed R3-6), with atomic `data/` directory swap only after parity check. Reason for the drift guard: §7.4.

## 7. Update pipeline (catch-up) — proposal for Q3

**Model:** cursor **per granularity** (`state.json`: `{granularity, last_seq, updated_at}`), because the sequence bases for `minute/`, `hour/`, and `day/` **cannot** be converted (verified: hourly seq 123467 × 60 ≠ minute seq 7327518).

Each scheduled run:

1. Fetch `state.txt` for the configured granularity (small GET).
2. Fetch all files `(last_seq, current_seq]` (automatically catch up after downtime; apply in ascending order).
3. Apply changes by streaming the osmchange XML (pure TypeScript; `zlib` for gzip, no full buffering):
   - Filter relevant objects: `amenity` ∈ configured values (create/modify/delete), member/tag changes for stored elements, node coordinate updates through the node-ref index.
   - **Version guard:** apply only if `new.version > stored.version` → **idempotent** (safe against overlap/double application).
   - Ignore unconfigured values (data optimization #1).
4. After the batch, atomically rewrite affected shards (temporary file + rename), evict affected shard entries from the internal LRU, update global indexes + manifest + data sequence, atomically persist state, and update `lastSeq`/`lastUpdate`. Proxy-side freshness comes from the TTL strategy (§9); optionally, the server can directly invalidate proxy Redis tile keys if given `REDIS_URL` (key schema in `Overpass-Proxy/src/store.ts`).
5. Consistency pass: delete stored ways/relations whose member nodes are missing (OSM referential integrity: those members no longer exist).

**Granularity = interval:** `minute` → `minute/NNN/NNN/NNN.osc.gz`; `hour` → `hour/NNN/NNN/NNN.osc.gz`; `day` → `day/NNN/NNN/NNN.osc.gz` (all `.osc.gz`, verified). **Changing granularity requires a full re-extract** (different cursor base) — an uncommon configuration change, documented.

**Frequency proposals:**

| Option | Jobs/day | Download/day | Freshness | Recurring effort |
|---|---:|---:|---|---|
| Minute | 1440 | ~50–200 MB (20–130 KB/min) | ≤ ~1 min | one timer; each run only parses and filters, negligible CPU |
| **Hourly (recommended default)** | 24 | typically 20–150 MB | ≤ 1 h | minimal |
| Daily | 1 | ~40–100 MB (peaks 300–400) | ≤ 24 h | minimal, but poor freshness |
| Adaptive batching (refinement, Phase 4) | Poll every 60 s; apply a batch at ≥ N KB or ≥ T min | like minute | variable | few jobs during inactive periods |

**Key insight for Q3:** Update effort per diff is **independent of index size** — with an amenity-only index and version-guarded upserts, the work is just “parse the diff + filter to configured values,” a small constant fraction of diff size, regardless of granularity. The index choice therefore does not limit update work; granularity determines only request count and freshness. The **real recurring work** is the weekly drift re-extract + parity check, not diff polling.

→ **Recommendation:** default to **hourly** (balance “live” behavior against minimal recurring effort); configure `minute` for genuine live updates (trivial cost); use `day` only as a cost-saving fallback.

### 7.4 Why perform a periodic full re-extract? (answer to Q6)

The incremental-diff path cannot reliably capture **every** change, and cannot detect its own gaps:

1. **Silent failures:** The updater acts only on changes that match its filter (configured values + stored elements + their members). Edge cases — for example, an element whose `amenity` value is removed from configuration and later restored (delete + create in a diff), relation-member swaps that change the member-node set, or node deletions that break the referential integrity of a stored way — can silently leave the index incorrect. There is no error; the data simply diverges.
2. **Version-guard limit:** “Apply only when `new.version > stored.version`” is idempotent for overlaps, but a historical restore/reimport can provide content with a version ≤ the stored version, which would be discarded.
3. **Baseline↔diff gap:** The weekly planet baseline and minute diffs (`osmdbt`) come from different pipelines; referential-integrity corrections on one side are not necessarily restated on the other.
4. **Accumulated rewrite residue:** Shards are rewritten over time during updates; small layout/compaction errors can accumulate.

The weekly re-extract is the **periodic reset to truth**: rebuild the entire index from one authoritative source (a fresh planet file), then swap atomically after a parity check. It also provides the re-index path for configuration changes (Q2) and a recurring validation anchor. **Weekly is sufficient:** hourly catch-up provides current freshness (≤ 1 h old); the re-extract only needs to limit *drift*, not edit latency. Cost: ~1–2 hours of unattended machine time per week, without downtime (atomic swap).

## 8. Local engine (query path, in-process, pure TypeScript)

- **Input:** amenity value + BBox + output format (json|xml) — custom implementation, copied 1:1 from `Overpass-Proxy/src/bbox.ts` (`extractAmenityValue`, `hasAmenityFilter`, normalization `trim().toLowerCase()`).
- **Shard resolution:** BBox → p5 cell set (typically 1–20; hard cap analogous to `MAX_TILES_PER_REQUEST`).
- **Loading:** shard files through an **LRU byte cache** (`OSM_AMENITY_SHARD_CACHE_MB`, default 256 MB) — hard RAM limit; evict stale shards.
- **Filtering:** value equality + BBox (node: point; way/relation: element-BBox intersection, then member-coordinate precision).
- **Deduplicate by id** (ways/relations duplicated in neighboring shards).
- **Output:**
  - **JSON:** exactly the same shape as `OverpassResponse` in `Overpass-Proxy/src/store.ts` (`version`/`generator`/`osm3s`/`elements`, including `meta` for `out ... meta`) → proxy stores the tile payload unchanged in Redis; cache contract (key, ETag, `expiresAt`) remains unchanged (§17).
  - **XML:** Overpass-compatible `<osm version="0.6" generator="...">` document; `node`/`way`/`relation` with `version`/`timestamp`/`changeset` attributes (standard Overpass XML behavior) → serves queries **without** `out:json` locally, such as `node[amenity=toilets](35.7986,139.7103,35.8351,139.7925);out;`.
- **ETag** from content hash; `expiresAt = now + TTL`.
- **Supported output forms:** `out` (= body), `out body [meta]`, `out skel [meta] [qt]`, `out tags [meta]`, `out geom [meta]`, each as JSON or XML; the `>` recursion operator (member nodes) is served from inline member coordinates. Unsupported QL (`around()`, `is_member`, multiple areas, other keys, etc.) → **HTTP 501** `{"error":"out of scope"}` → unchanged proxy falls through to remote instances (no functional gap; decision #5, §17).

## 9. TTL/cache strategy (Q7)

- **Starting point:** keep `CACHE_TTL_SECONDS=86400` (24 h) as a safety net for untouched tiles.
- **Freshness mechanism (standalone architecture):** by default, the server has no access to proxy Redis. Proxy-side freshness comes from the proxy cache TTL: after each hourly update batch, tiles can be at most one interval old — with a 24-hour TTL, this is usually acceptable because most tiles are rarely requested. Optionally, give the server `REDIS_URL` and directly invalidate tile keys for affected p5 cells after each batch (key schema in `Overpass-Proxy/src/store.ts`) → freshness equals the update interval, while TTL remains a safety net.
- **Measurement phase (Phase 4, about one week):** collect local query latency (p50/p95), shard-cache hit rate, update batch times, and diff sizes.
- **Gradual reduction (data-driven, not speculative):** if p95 < target (initially 20 ms) **and** hit rate is high, reduce TTL in steps: 24 h → 6 h → 1 h → 15 min (at least 24 h at each documented step). If latency degrades (large shards, cache-miss spikes, high load), revert one step.
- **Final decision** after the measurement phase: document it in this plan and `README`.

## 10. Standalone server: runtime, endpoints, operations (R3)

The server is an **independent process/container** in the new `OSMAmenityOverpassServer` repo. Overpass-Proxy remains **unchanged in code** (R3-1); it only adds the server as an upstream in `UPSTREAM_URLS` (§17). The server keeps itself current (in-process catch-up, §7) and can also run independently.

- **Process model:** one Node/TypeScript service (same stack as the proxy: Fastify + pino + ngeohash), with two components:
  - **Query engine** (§8): serves `/api/interpreter` from the index.
  - **Self-update loop** (§7): timer (hourly by default) → apply catch-up diffs; optionally, run a weekly drift re-extract (§6.5) as a subprocess/job, then atomically swap `data/`.
- **Endpoints (Overpass-compatible):**
  - `POST/GET /api/interpreter` — in-scope (amenity filter + BBox + configured values) → engine, JSON or XML (§8); out of scope → **501** `{"error":"out of scope"}` (§17).
  - `GET /api/status` → Overpass-style response + `localEngine` block `{shards, elements, lastSeq, lastUpdate, lagSeconds, updateIntervalSeconds}`.
  - `GET /api/timestamp` → current data-sequence timestamp (standalone; proxy passes it through transparently).
  - `POST /api/kill_my_queries` → 200 no-op (no local query queue).
  - **HEAD** on base URL → 2xx (upstream recovery probe, §17).
- **Stats (own provider):** query count, p50/p95 latency, shard-cache hits/misses, update lag, batch sizes, errors → basis for `/api/status` and TTL tuning (§9).
- **Deployment (new repo):** `Dockerfile` (`node:20-alpine`, two stages like the proxy) + `docker-compose.yml.template` with `amenity-server` service + read-only data volume; extraction runs on the host, not in the serving container. Full-stack template: `proxy` + `redis` + `amenity-server`; proxy points to both local and remote instances.

## 11. Configuration surface (server environment variables)

Server runtime:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8081` | Server HTTP port (8080 is used by the proxy) |
| `OSM_AMENITY_DATA_DIR` | — | Path to `data/` (shards, indexes, manifest, `state.json`) |
| `OSM_AMENITY_AMENITIES` | `toilets` | Comma-separated values (normalized with `trim().toLowerCase()`) |
| `OSM_AMENITY_SHARD_PRECISION` | `5` | Geohash precision (= proxy tile precision) |
| `OSM_AMENITY_SHARD_CACHE_MB` | `256` | Engine LRU byte budget |
| `OSM_AMENITY_UPDATE_INTERVAL_SECONDS` | `3600` | 60 / 3600 / 86400 (selects granularity, confirmed R3) |
| `OSM_AMENITY_UPDATE_BASE_URL` | `https://planet.openstreetmap.org/replication` | Replication root |
| `OSM_AMENITY_REEXTRACT_EVERY_SECONDS` | `604800` | Drift-guard re-extract (0 = off, confirmed R3) |
| `OSM_AMENITY_REDIS_URL` | — (optional) | Access proxy Redis; directly invalidate tile keys for affected p5 cells after an update batch (§9) |

Extraction CLI (`scripts/extract.mjs`, offline tool; R3 confirmations incorporated):
`--workers N` (count, default auto = `min(Cores, floor(ram-mb/worker-ram-mb))`) · `--ram-mb` (total budget, default 8192) · `--worker-ram-mb` (per-worker limit, default 2048) · `--chunk-mb` (default 1024) · `--stages 0..3` · `--keep-chunks` (default true, R3-3) · `--all-amenity-values` (default true, can be disabled, R3-4) · `--data-dir` · `--amenities` · `--planet-source`.

## 12. Tests and verification

- **Unit:** geohash BBox→cells, binary reader/writer round-trip, osmchange parser, version guard, dedupe, BBox filter, ETag, XML renderer.
- **Integration:** fixture mini-planet → small pipeline → engine queries → compare with expected Overpass JSON/XML; own test harness in the new repo (patterned after `Overpass-Proxy/src/tests/integration/mock-overpass.ts`).
- **E2E against unchanged proxy:** Overpass-Proxy v1.5.0, unchanged, points `UPSTREAM_URLS` to the server + remote pool → tile queries are served locally, out-of-scope queries fall through to remote (§17).
- **Parity:** `scripts/parity.mjs` — N random BBoxes × configured values: local vs. live Overpass, expect no diff. **Note:** public Overpass instances are unreachable from this sandbox (Round 1: 406/timeout) → run parity on a network-enabled machine.
- **Performance benchmark:** shard loading, query p50/p95, update batch time with a real hourly diff → input for TTL decision (§9).
- **Extraction verification:** object counts (chunk sum == planet), `osmium check` on `work/out/*`, sample queries against completed shards.

## 13. Phases and milestones

| Phase | Work | Effort | Acceptance |
|---|---|---|---|
| 0 | Environment (`osmium-tool`), validate block splitting on a real planet (object counts, header behavior), `taginfo` counts (external), build fixture | ~0.5 day | Valid chunks, counts == planet, real size estimates |
| 1 | Pipeline Stages 0–3 + `scripts/extract.mjs` + resume protocol; **first worldwide run**; verification | 1–2 days coding + 1–2 h runtime | Complete `data/`, correct counts, `osmium check` passes, interruption/resume tested |
| 2 | Local engine + update pipeline + unit/integration tests | 2–3 days | All tests pass; hourly diff apply < 1 min; RAM budget respected |
| 3 | Deployment and E2E: Docker/compose templates, unchanged proxy points via `UPSTREAM_URLS` to server + remote, E2E tests (tile query, XML query, 501 failover, probes), docs (`README`, `specification.md`, `plans/`) | ~1 day | Proxy contract fulfilled; example query works locally in JSON + XML; out-of-scope failover tested |
| 4 | ~1 week of operation: latency/load measurement, TTL steps, parity run, first drift re-extract | 1 week | Final TTL decision documented; parity diff = 0 (or explained) |

**Status (R4, 2026-10-15):** Phase 0 ✅ (see §18.8). Phase 1 🔄 — Stages 1–4 are implemented and verified on **Japan** (rather than beginning with a planet-wide run, see §19.1); Stage 0 ✅. Phases 2–4 ⬜. See [`plans/TODO.md`](TODO.md) for detailed, ongoing status.

## 14. Risks

1. **89 GB download** (bandwidth/time) — verify md5 after completion; support resumable download; total disk use ~180–220 GB (user confirmed capacity).
2. **`osmium-tool` as offline tool** (install/build on the machine); a pure-TypeScript PBF reader would depend on the native Blosc codec → prefer osmium, retain it as a documented prerequisite.
3. **Stage 2c Lua throughput** (~12 billion nodes) — ~5–15 min in parallel (16 workers); fallback: osmium C++ plugin.
4. **Object vs. block boundaries during chunk split** — Phase 0 verification by object count; splitter handles the edge case where an object crosses a block boundary.
5. **Worst-case daily diff ~105 MB** — use daily granularity only intentionally; parser streams regardless.
6. **Cursor bases per granularity** — separate cursor per granularity + re-extract when changing granularity + version guard as a second defense.
7. **Public Overpass unreachable from sandbox** — run parity/remote-performance comparisons externally.
8. **Disk capacity ~200 GB** — verify in Phase 0 (user: sufficient capacity available).

## 15. Defaults — confirmed (Round 3)

1. **Update interval: hourly by default** (`minute` configurable for live operation) — confirmed.
2. **Shard precision 5** (matches proxy tile precision) — confirmed.
3. **Planet file + chunks kept on disk** (`--keep-chunks`, default true; unnecessary for routine operation, only needed for re-indexing) — confirmed, configurable.
4. **Intermediate stage with all `amenity` values** (~2–15 GB) → re-index new values in minutes (Stage 3 only) — confirmed, configurable/disableable (`--all-amenity-values`).
5. **Extraction RAM budget: 8 GB total, 2 GB/worker** — confirmed; `--workers` and `--worker-ram-mb` independently configurable.
6. **Drift-guard re-extract: weekly**, parity check before `data/` swap — confirmed (reason §7.4).

No defaults remain open.

## 16. New repository: `OSMAmenityOverpassServer` — project framework (R3)

Goal: `/home/bietiekay/code/OSMAmenityOverpassServer` (initially empty, `master`, no commits). The framework is created in the first implementation step (plan mode prohibits writing to the repo); implementation then follows §13:

```
OSMAmenityOverpassServer/
├── LICENSE                                # 1:1 copy of Overpass-Proxy/LICENSE (same license, R3)
├── README.md                              # Overview, endpoints, operations (extract/update/parity), config table, deployment
├── specification.md                      # Protocol + format specification: shard binary (OAM1, §5), osmchange contract (§7), QL subset (§8), Overpass response shapes
├── OSMAmenityOverpassServer-Prompt.md     # Agent setup brief (modeled on Overpass-Proxy/Overpass-Proxy-Prompt.md): purpose, architecture, invariants (no native runtime deps, RAM budgets, resume protocol, proxy contract §17), phase gates
├── plans/
│   ├── 2026-10-14-osm-amenity-overpass-server.md   # This plan (R3 + R4, 2026-10-15)
│   └── TODO.md                                    # Status tracking for all steps (living document)
├── package.json                           # name osm-amenity-overpass-server, 0.1.0, type module, node>=20
│                                          # deps: fastify, @fastify/formbody, ngeohash, pino
│                                          # devDeps: typescript, vitest, tsx, eslint suite (like proxy)
│                                          # scripts: build / dev / test / verify / extract / parity
├── tsconfig.json · vitest.config.ts · eslint.config.js · .gitignore
├── Dockerfile                             # node:20-alpine, two-stage build (like proxy Dockerfile)
├── docker-compose.yml.template            # amenity-server + data volume; full stack: proxy + redis + amenity-server (UPSTREAM_URLS: local + remote)
├── scripts/
│   ├── extract.mjs                        # Extraction CLI: Stages 0–3, worker pool, resume protocol (§6)
│   ├── extract/amenity-filter.lua         # osmium Lua: Stage 1 (keep amenity-*; collect member IDs)
│   ├── extract/member-scan.lua            # osmium Lua: Stage 2c (merge-scan against members.ids)
│   └── parity.mjs                         # local vs. live Overpass (network-enabled)
└── src/
    ├── index.ts                           # Entry point: config → index load → server + self-update loop
    ├── config.ts                          # OSM_AMENITY_* environment variables (§11)
    ├── server.ts                          # Fastify: /api/interpreter (POST+GET), /api/status, /api/timestamp, /api/kill_my_queries, HEAD
    ├── query.ts                           # QL subset parser: amenity filter + BBox + output forms (json|xml; out/body/skel/tags/geom, meta, `>` recursion)
    ├── output.ts                          # JSON renderer (OverpassResponse shape) + Overpass XML renderer
    ├── index/
    │   ├── geohash.ts                     # BBox → p5 cells (ngeohash), cell intersection for ways
    │   ├── shard.ts                       # OAM1 shard reader/writer (DataView, string pool, indexes)
    │   ├── engine.ts                      # LRU shard cache, filtering, dedupe, response assembly
    │   └── apply.ts                        # Apply osmchange: version guard, shard rewrite, LRU invalidation
    ├── replication.ts                     # Read state.txt, catch-up download (.osc.gz), apply batches
    └── stats.ts                           # Latency/lag/counts (basis for /api/status + TTL tuning §9)
tests/                                     # Unit + integration (fixture mini-planet through the pipeline)
```

- **Stack decision:** same as proxy (Node 20+, TypeScript, Fastify, vitest, eslint) → no new native runtime dependencies in the serving path; `osmium-tool` is **only** an offline extraction/verification tool (not a serving-image dependency).
- **Data files:** `data/` (live index: shards, indexes, manifest, `state.json`), `work/` (chunks + intermediate stages, `--keep-chunks`), `data.new/` (staging during re-extract → atomic swap).
- **Agent setup:** prompt file + plan + `TODO.md` in `plans/` are the starting point for the implementation session in this repo.
- **License:** identical to Overpass-Proxy (Miataru/BSD style, with the Daniel Kirstenpfad copyright header used there).

## 17. Overpass-Proxy contract (verified against v1.5.0 source, unchanged)

Sources: `src/upstream.ts` (`buildTileQuery` L18, `fetchTile` L1205, `proxyTransparent` L1247, `withUpstream` L1069, `shouldMarkFailure`, `probeUpstream`), `src/interpreter.ts` (transparent endpoints L749), `src/store.ts` (`OverpassResponse`, `filterElementsByBbox`), `src/tests/integration/mock-overpass.ts`.

**Tile fetch (main path):** `POST {upstream}/api/interpreter`, form body `data=<tile query>` (`Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`). Exact tile query (`buildTileQuery`):
`[out:json][timeout:120];(node["amenity"]="X"(s,w,n,e);way["amenity"]="X"(s,w,n,e);relation["amenity"]="X"(s,w,n,e););out body meta;\n >;\nout skel qt;`
The response must be **200 JSON with an `elements` array** (`parseUpstreamResponse` rejects anything else → upstream failure → failover). Retry the same upstream twice for 403/408/413/500/502/503/504 — **501 is not retried** (immediate failover).

**Transparent path (non-cacheable queries):** method/URL/headers/body are forwarded 1:1. Upstream **5xx or 429 → fail over** to the next upstream (mark failed upstream with backoff); **other 4xx → return directly to client** (no failover).

**New server out-of-scope contract:** in scope = amenity tag filter + BBox + configured values + json|xml output → serve from index (§8). Anything else (other keys, no BBox, exotic QL) → **HTTP 501** + `{"error":"out of scope"}` → proxy falls back to next upstream (remote pool, decision #5). Side effect: local upstream receives a failure mark/backoff — self-healing, and applies only to out-of-scope queries (rare in this application). Tile fetches are always in scope → the server should normally remain the preferred upstream (EWMA latency).

**Recovery probe:** `HEAD` the upstream base URL (`probeUpstream`); status < 500 and ≠ 429 marks the upstream available. The server must answer HEAD on the base URL (and all endpoints) with 2xx (Fastify automatically answers HEAD for GET routes).

**Deployment (proxy config only, no code):**
`UPSTREAM_URLS: http://amenity-server:8081/api/interpreter, https://overpass-api.de/api/interpreter, https://overpass.kumi.systems/api/interpreter`
Proxy cache/SWR/stats remain unchanged; tile payload format is identical (`OverpassResponse` shape, ETag, `expiresAt`).

---

# Round 3.1 — Additions (2026-10-14)

Secondary decisions from implementation work on 2026-10-14; valid alongside all sections above.

## 18.1 Diagnostic interface (answer to Q6)

- `GET /api/status` includes a **conforming Overpass block** with exact field names used by other Overpass implementations: `version`, `osm_osm_change`, `time_used`, `memory_used`, `output_format`.
- `osm_osm_change` = **minute sequence number** of the most recently applied update, as a string (`"0"` with no data). An external monitor fetches the live sequence from `minute/state.txt` (`sequenceNumber=`) at the update base URL and compares: `liveSeq − osm_osm_change` = number of missed minute diffs.
- An additional (non-standard) `localEngine` block: `shards, elements, amenities, shardPrecision, lastSeq, lastUpdate, dataTimestamp, updateIntervalSeconds, updateBaseUrl, stats{queries, errors, shardCacheHits, shardCacheMisses, latencyP50Ms, latencyP95Ms, lastQueryAt}`.
- Implemented for compatibility: `GET /api/timestamp` (text/plain, data-sequence timestamp, fallback = now), `POST /api/kill_my_queries` (200 no-op), and `HEAD` on the base URL → 2xx (proxy recovery probe).

## 18.2 Cursor = minute sequence; update source = minute files only

- The canonical freshness cursor is the **minute sequence number** (one counter; no hourly/daily bases); `state.json.lastSeq` stores it, and `/api/status` exposes it as `osm_osm_change`.
- The update source is **only** `minute/NNN/NNN/NNN.osc.gz` (7-digit sequence, split 3/3/1). The loop interval (`OSM_AMENITY_UPDATE_INTERVAL_SECONDS`, default 3600) controls how often catch-up runs — not which files are used.
- Hourly/daily file catch-up is a documented future optimization, not required for correctness (sequence bases cannot be converted → minute sequence remains canonical).

## 18.3 Planet source changed (measured 2026-10-14)

- planet.openstreetmap.org no longer serves **PBF**: `/planet/planet-latest.osm.pbf` → 404, `/planet/latest/` → 404, `/planet/2026/` lists only weekly `.bz2` dumps.
- Pipeline: download `planet-latest.osm.bz2` (~167 GB) (302 → `/planet/2026/planet-261005.osm.bz2`, 2026-10-05 dump, md5 `b8ae8035c85335bae7186059ab5fbeaf`) → `osmium cat` → PBF (~89 GB) → delete bz2. Resume download with `curl -C -`.

## 18.4 Disk placement (measured, target machine)

| Volume | Free (2026-10-14) | Usage |
|---|---|---|
| `/home` | ~133 GB | PBF (~89 GB) + final shards (~5 GB) |
| `/ssdbuffer` | ~183 GB | bz2 during download (peak ~167 GB), then `work/` + chunks (~90 GB) |
| `/hauswolke` | ~163 GB / 1 TB | overflow only |

Stage 0 remains a byte-copy chunk split (fits this placement).

## 18.5 PBF block format (measured with osmium 1.14 / libosmium 2.18)

> **Historical framing claims below were later corrected.** Standard OSM PBF framing is a four-byte big-endian BlobHeader length followed by the BlobHeader and Blob. The alleged legacy varint framing described here was not demonstrated for standard OSM PBF and was removed. See §20 and the acceptance documentation linked there.

- **“New framing” (osmium ≥ 1.14):** `[u32be BlobHeader length][BlobHeader bytes][datasize bytes Blob]`. BlobHeader (Protobuf): field 1 = type string (`"OSMHeader"`/`"OSMData"`), field 3 = varint `datasize`. EOF = length 0. Initially verified against reference files `test/formats/f1*.osm.pbf` from osmcode/libosmium; the fixture planet (966,678 B, 17 blocks) also parsed.
- **“Classic framing” (OSM planet PBF 2016+):** `[varint BlobHeader length][BlobHeader][blobSize bytes]`, BlobHeader field 1 = varint blob size, field 2 = varint type enum (1=OSMHeader, 2=OSMData). Initially retained as a fallback, detected on the first block; this was an unsupported assumption and was later removed.
- Stage 0 consequence: scanner reads only header bytes (does not decompress payload); chunk boundaries align to block boundaries → chunks can be verified as PBF files by counting their objects.

## 18.6 npm/Arborist note

- Fresh resolution of the **vitest 4.1.11** peer tree crashes npm 10.8.2 Arborist (`Cannot read properties of null (reading 'edgesOut')`) without a lockfile; workaround was `--legacy-peer-deps`.
- vitest is now pinned **exactly to `4.0.16`** (proxy reference version); fresh resolution with 4.0.16 works without `--legacy-peer-deps`. Lockfile is committed → always use plain `npm install` from the lockfile afterward.

## 18.7 Test note (supertest/Fastify)

- supertest `.type('form')` + `.field(...)` returns HTTP 415 against the Fastify server (content-type parser binding); solution: string body via `new URLSearchParams({ data: q }).toString()` — same as the Overpass-Proxy integration tests (`formBody` helper).
- `app.inject()` responses have `statusCode` (not `status`) — keep this in mind in injection-based tests.

## 18.8 Phase 0 acceptance (completed 2026-10-14)

- `make-fixture --verify`: fixture planet (100k nodes / 10k ways / 1k relations, 17 PBF blocks) → Stage 0 split (1 chunk, 1 MB target) → `osmium show` count for chunks equals planet count → `VERIFY OK`.
- Repo: 80/80 tests pass, lint + build pass, lockfile uses vitest 4.0.16.

---

# Round 4 — 2026-10-15: Japan as development/test target, osmium findings, revised stage design

## 19.1 User decision (2026-10-15): develop and test on Japan

> “can you do the develoment and testing with a smaller map like japan and make it configurable so that peoduction deployments can use the full planet?”

- **Development/test target is now the Geofabrik Japan extract**, not the planet. Source PBF: `/ssdbuffer/osm-amenity/planet/japan-latest.osm.pbf` (2.55 GB; 302 → `japan-261014.osm.pbf`, 2026-10-14 dump, Geofabrik).
- **The planet bz2 (167 GB) was deleted from `/ssdbuffer` on 2026-10-15.** (The 2026-10-14 download, md5 `b8ae8035c85335bae7186059ab5fbeaf`, was verified and valid, but is not needed for development.)
- **Production remains the planet** — same pipeline, only `--source` points to the planet PBF. No Japan-specific code path and no region hardcoding: the pipeline is source-agnostic (`--source <any.pbf>`).
- **Reason for the change:** disk capacity. On this machine, bz2 (167 GB) + planet PBF (89 GB) + chunks (~90 GB) do not fit simultaneously (measured: `/home` 131 GB, `/ssdbuffer` only ~9 GB free after the bz2 download). Japan (2.4 GB) can be kept locally, and exercises the full pipeline logic (chunking, parallelism, resume, atomic writes) 1:1.
- CLI consequence: `--planet-source` becomes `--source` (the alias remains accepted).

## 19.2 osmium 1.14 findings (measured 2026-10-15, osmium 1.14.0 / libosmium 2.18.0)

| Command | Result | Consequence |
|---|---|---|
| `osmium run` (Lua) | **Not present** in this build | No Lua filter — original Stage 1/2c design (Lua) is dropped; stages redesigned (§19.3). |
| `osmium tags-filter` | **Bug in this build:** passes through ~2–4% non-matches once the file contains ways/relations. Fixture: 14,489 objects instead of the expected 10,540 for `amenity=toilets` (3,030 untagged nodes + 525 `drinking_water` + remainder). Reproduced with **XML and PBF input**; pure node files (200k) filter correctly. True matches are never lost (superset behavior). | **Do not use `tags-filter` for Stage 1.** Instead, `osmium cat` → OSM XML + pure Node filter (deterministic, testable with vitest). |
| `osmium getid` | Reliable (node and way lookup verified). ID file format: `n<id>` / `w<id>` / `r<id>` per line (one-character prefix, **no slash** — `node/7` → error “illegal id: 'ode/7'”), **or** bare IDs + `--default-type node\|way\|relation`. `--verbose-ids` reports found/missing IDs. Output = OSM XML with full metadata (version/timestamp/changeset, lat/lon, tags, `nd` refs). **Peak RAM ~1.2–1.3 GB per process**, even for tiny input files (libosmium baseline) → strictly control worker count through RAM budget. | Stage 2 (ways) and Stage 3 (nodes) based on `getid`. **Stage 3 was later changed to a bounded streaming merge because `getid` allocates an ID bitmap proportional to the largest ID; see §20.** |
| `osmium cat` | Reliable PBF→XML passthrough (fixture counts match) | Stage 1 XML source |
| `osmium show` | Output contains ANSI color codes → strip before counting (`osmiumNumObjects` in `extract.mjs` initially did this with awk-gsub) | Verification routines remain as before; later count validation uses `osmium fileinfo -e` where appropriate (§20). |
| `osmium fileinfo -e` | Provides object counts (nodes/ways/relations) | Verification helper |
| `osmium tags-count` | Reliable (key counts; fixture: `amenity`=23,397 = 22,857 nodes + 500 ways + 40 relations) | Cross-check helper |
| CLI notes | `osmium cat INPUT -o OUTPUT --overwrite` (positional input, **no** `-i`); no `--num-objects` flag; object counting via `osmium show FILE \| awk` (ANSI strip) | — |

**Verification of the bug diagnosis (2026-10-15):**

- Fixture (100k nodes + 10k ways + 1k relations): `tags-filter "amenity=toilets"` → 13,791 nodes (expected 10,000); `getid` confirms the “extra” nodes have the reported tags → PBF intact, reader correct, only the filter path over-matches.
- Synthetic 200k nodes, no ways/relations: correct (20,000/20,000).
- Synthetic 60k nodes + 6k ways + 600 relations: **incorrect** (8,240 instead of 6,000; same with XML and PBF input) → trigger = ways/relations present in file.
- Conclusion at the time: not reliable regardless of input format → omit it. **Later acceptance clarified that passthrough references are expected behavior, not a proven filter defect; see §20.**

## 19.3 Revised stage design (replaces §6 Stages 1–3; Stage 4 added)

```
<source>.pbf (Japan dev / planet prod — source-agnostic)
        │ Stage 0: block split (byte copy, unchanged, ✅)
        ▼
work/chunks/cNNNN.pbf  (each chunk includes OSMHeader → independently readable)
        │ Stage 1 (per chunk, parallel): osmium cat → OSM XML (temporary, then delete)
        │   + streaming Node filter (pure Node, tested with vitest)
        ▼
work/stage1/amen_cNNNN.lines   (amenity objects, line format §19.4)
work/stage1/ids_cNNNN.lines    (W <wayId> + N <nodeId> IDs, §19.4)
        │ Merge (sort -u): stage2/way-ids.lines, stage3/node-ids.lines
        ▼
Stage 2 (per chunk, parallel): osmium getid -i way-ids.lines --default-type way
        → work/stage2/ways_cNNNN.xml  (member ways + nd refs + tags)
        │  (nd refs from ways_*.xml → merge into node-ids.lines)
        ▼
Stage 3 (per chunk, parallel): osmium getid -i node-ids.lines --default-type node
        → work/stage3/nodes_cNNNN.xml  (id → lat/lon)
        ▼
Stage 4 (one process, pure Node): all .lines + nodes → cells → records
        → OAM1 shards (writeShard from dist/index/shard.js) → data/shards/*.bin
        + data/manifest.json + data/state.json
```

- **Required sequence:** Stage 1 (all chunks) → Stage 2 (all chunks) → Stage 3 (all chunks) → Stage 4. Stage 3 needs `nd` refs from Stage 2 (member ways); Stage 2 needs relation members from Stage 1.
- **Stage 1:** `osmium cat chunk.pbf -f osm -o work/tmp/cNNNN.xml` (C++, fast), then Node filter reads XML line by line (no DOM): detect object start/end, collect tags + member refs, match amenity (`amenity` ∈ configured values; with `--all-amenity-values`, key presence). On a match, write a line per §19.4 and `W`/`N` IDs to the IDs file. Delete temporary XML afterward. Work unit = chunk; done marker `stage1/cNNNN.done`, like Stage 0.
- **Stage 2:** create global way-ID set from all `ids_*.lines` (only `W` rows, `sort -u`). Per chunk run `osmium getid -i way-ids.lines chunk.pbf --default-type way -o stage2/ways_cNNNN.xml`. Parse output into way lines (id, ver, ts, cs, `nd` refs, tags); those `nd` refs extend the node-ID set (hence Stage 3 follows).
- **Stage 3:** global node-ID set (Stage 1 `N` rows + `nd` refs from Stage 2 ways). Per chunk, `osmium getid --default-type node` → `stage3/nodes_cNNNN.xml` (id → lat/lon). A node exists in exactly one chunk → each ID should occur exactly once across all chunks (otherwise warn). **Superseded in the accepted implementation:** the native ID bitmap exceeds the worker budget for real OSM IDs above 14 billion; Stage 3 now performs a sorted OPL/ID streaming merge (§20).
- **Stage 4:** pure Node module. Load node map (id → [lat7,lon7]); stream all amenity lines + way lines; compute cells (§19.5); write records (u32le length + record bytes) to `stage4/cells/<geohash>.rec` (LRU open-file cache, e.g. 256 files); per cell, read records → `ShardElement[]` → `writeShard(geohash, elements, buildSequence=0, configHash)` → atomically promote to `data/shards/<geohash>.bin`. Then write `manifest.json` (counts, source, config) + `state.json` (`lastSeq: 0`, `lastUpdate`, `dataTimestamp` = source mtime). `dist/index/shard.js` must exist → the CLI initially triggers `npm run build` automatically.
- **Re-index update (§6.5, renumbered):** new value → rerun **Stage 4** (minutes, all values are in `stage1/*.lines`); new key → Stages 1–4; drift re-extract → Stages 0–4.

## 19.4 Line format (Stage 1/2 output, ID files)

One line per object, fields separated by spaces, tags URL-encoded (`encodeURIComponent` → no spaces remain inside a field); `-` separates geometry/members from tags (always present, including when there are 0 tags):

```
N <id> <ver> <ts> <cs> <lat7> <lon7> - [k=v ...]
W <id> <ver> <ts> <cs> <nd1> <nd2> ... - [k=v ...]
R <id> <ver> <ts> <cs> [t:ref:role ...] - [k=v ...]
```

- `ts` = Unix seconds (XML ISO string → epoch; empty/missing timestamp → 0). `lat7/lon7` = coordinates × 1e7 as i32 (as in OAM1).
- `t` ∈ {`n`,`w`,`r`}; role may be empty (`w:123:`).
- ID files (`ids_cNNNN.lines`): `W <id>` (way member of an amenity relation) or `N <id>` (`nd` ref of an amenity way or node member of an amenity relation). Reformat for `getid` as `<id>` + `--default-type` (or prefix `n`/`w` — both verified, §19.2).
- Parser is pure Node and tested with vitest (round-trip + edge cases: empty role, encoded keys/values, 0 tags, missing timestamp).

## 19.5 Shard content contract (what Stage 4 must provide — derived from engine.ts)

- **Amenity node** → exactly one cell (cell of its own point, `pointToCell`); `bbox = [lat,lon,lat,lon]` (the point itself).
- **Amenity way** → **all** cells whose BBox intersects the way BBox; each copy carries **all member coordinates inline** (`memberCoords`). The engine serves `out geom` and `>;` member nodes exclusively from this data, without loading extra shards. Way BBox = min/max over member coordinates.
- **Amenity relation** → all cells covered by the **union BBox** (direct member-node points ∪ member-way BBoxes); member list preserved 1:1 (type/ref/role) — the engine does not render member relations themselves, but their refs must be in the response skeleton.
- **Member ways** (without an amenity tag themselves) → **only** in cells of relations that reference them (never a main element → no independent BBox cells needed). The engine finds them with `shard.elements.find(...)` **in the same shard** as the relation. Include `nd` refs + tags (skeleton output and future use); **no coordinates needed** (engine emits member ways only as `skel`).
- **Direct relation member nodes** → must exist as **node elements** in the same cells as the relation (engine lookup in `shard.elements`; otherwise the `>` node is missing from response).
- **Deduplicate** within a cell by id (for example, an amenity way that is also a member way): the version with `memberCoords` or the higher version wins; merge `memberCoords` maps.
- **buildSequence = 0** in initial build (Geofabrik snapshot has no minute sequence); `configHash = buildConfigHash({amenities, shardPrecision})` — engine currently does not validate it; the update path (Phase 2) will.
- **Known limitation (v1):** relation→relation members are not resolved (their ways are not placed in the cells; BBox uses direct members only). Low relevance for amenity use cases; retain as documented.

## 19.6 RAM/disk budgets (Japan development on this machine, 2026-10-15)

| Item | Path | Size |
|---|---|---|
| Source PBF | `/ssdbuffer/osm-amenity/planet/japan-latest.osm.pbf` | 2.55 GB (unchanged) |
| Work directory | `/home/osm-amenity/japan/work/` | chunks ~2.5 GB + transient per-chunk temp XML |
| Data directory | `/home/osm-amenity/japan/data/` | shards + manifest (estimated <1 GB, ~1.43M amenity objects across all values) |

- **Development run with `--chunk-mb 256`** (~10 chunks instead of 3): temporary XML per chunk ~4–6 GB instead of ~17 GB (fixture ratio ~17×), better worker utilization (24 cores). Set `--workers` accordingly (default formula remains `min(Cores, floor(ram-mb/worker-ram-mb))`).
- **Stage 4 RAM:** ~1.43M objects in maps ≈ 0.5–1 GB → below 2 GB/worker.
- **Planet production (later, on another machine):** ~17 GB temp XML per 1-GB chunk (process chunks sequentially, then delete); need ≥ ~200 GB free (bz2/PBF placement in §18.3/§18.4, re-measure).

## 19.7 Fixture status (action before first commit)

- `fixtures/` on disk (`fixture.osm.xml` + `.pbf`, 2026-10-14 17:22) came from an **older** `make-fixture` version: building tag count 8,571 instead of 7,143 produced by the current generator (XML and PBF are internally consistent: counts 100k/10k/1k, `getid` samples pass — only non-amenity noise is stale).
- **Action:** regenerate fixture before first commit: `npm run make-fixture -- --verify` (LCG seed 20261014 fixed → deterministic; `fixtures/` is in `.gitignore` and is not committed).

## 19.8 Next steps (exact order)

1. **Regenerate fixture** + get `make-fixture --verify` green (§19.7).
2. **Implement Stages 1–4** in `scripts/extract.mjs` (+ line-format parser, `--source` alias, auto-`npm run build` for Stage 4).
3. **vitest tests** for XML stream filter, line-format parser/writer, Stage 4 assembly (cell assignment, dedupe, member placement, manifest/state); meet coverage gates 0.9/0.85/0.9/0.9.
4. **Full Japan run:**
   `node scripts/extract.mjs --source /ssdbuffer/osm-amenity/planet/japan-latest.osm.pbf --data-dir /home/osm-amenity/japan --stages 0-4 --chunk-mb 256 --all-amenity-values true`
5. **Verification:** independent osmium count (`show`-based, strip ANSI) vs `manifest.json` counts (all amenity values + member objects); Tokyo sample (known high toilet density, e.g. station area 35.681/139.767) via `osmium show` sample against shard contents.
6. **Start server** on Japan data (`OSM_AMENITY_DATA_DIR=/home/osm-amenity/japan/data`); E2E: JSON query, XML query, `>;` recursion, out-of-scope → 501, `/api/status` sanity (shards/elements/lastUpdate).
7. **Initial Git commit** (everything, including `plans/` + `TODO.md`; `master` still has 0 commits at the time of this note).
8. **(Network required)** Parity against public Overpass — sandbox blocks it (406/timeout, §14 risk 7); run on a network-enabled machine.
9. **(Network + proxy checkout)** Proxy E2E: unchanged Overpass-Proxy, `UPSTREAM_URLS: http://amenity-server:8081/api/interpreter, <remote>`; failover/probes/tile query (§17).
10. **Phase 2:** wire the server update loop (timer → `state.txt` → stream-apply minute diffs → atomic shard rewrites → persist `state.json`) + re-extract job; E2E with real planet minute diffs against the Japan index (region acts as natural filter) or synthetic osmchange against fixture.
11. **TTL measurement phase (§9):** after ~1 week of Japan operation, evaluate p50/p95 latency + cache-hit rate; try TTL steps 24h → 6h → 1h → 15min.
12. **(Deferred by user decision)** Planet production run.

## 19.9 Long-term goals and open items

- **Planet index (production)** via the same pipeline (`--source planet-latest.osm.pbf`) — only after Japan E2E passes and a machine with ≥ 200 GB free is available.
- **Self-updating server:** minute catch-up, freshness ≤ 1 h (hourly default, `OSM_AMENITY_UPDATE_INTERVAL_SECONDS`); canonical cursor = minute sequence in `state.json` → `/api/status.osm_osm_change` (§18.2).
- **Proxy uses amenity-server as preferred upstream** (EWMA latency); remote pool remains fallback for out-of-scope queries (501 failover, §17).
- **Tune cache TTL based on data**, starting from 24 h (§9, after measurement phase).
- **Optional/refinements:** Redis invalidation (`OSM_AMENITY_REDIS_URL`), hourly/daily diff catch-up (cursor bases cannot be converted → optimization only), more keys (only Stages 1–4 needed; final-index core unchanged, §1 scope), relation→relation resolution (§19.5 limitation).
- **Worldwide amenity counts** (`taginfo`) were unreachable from the sandbox → measure on a network-enabled machine (Japan reference: 1,432,136 objects, all values, Round 1).

## 19.10 Development environment inventory (2026-10-15)

- Machine: 24 CPU, ~89 GB RAM (~26 GB free at measurement), Ubuntu 22.04.5, root. node v22.23.3, npm 10.8.2, osmium-tool 1.14.0 (libosmium 2.18.0; zlib/lz4/none). Git user “Daniel Kirstenpfad” <bietiekay@gmail.com>.
- Disk (after bz2 deletion): `/home` ~131 GB free (Japan work/data dirs), `/ssdbuffer` ~178 GB free (only Japan PBF 2.4 GB + logs), `/hauswolke` ~163 GB / 1 TB (overflow only).
- **npm:** always install from committed lockfile (plain `npm install`). Vitest pinned exactly to **4.0.16** — fresh resolution ≥4.1.11 crashes npm 10.8.2 Arborist (peer tree, null `edgesOut`) without a lockfile (§18.6).
- **Test note:** supertest `.type('form')` + `.field()` → 415 against Fastify; instead use string body via `new URLSearchParams({data: q}).toString()` (§18.7). `app.inject()` responses expose `statusCode`.

## 19.11 Test infrastructure / coverage (2026-10-15)

- Added `@vitest/coverage-v8` **@4.0.16** as a dev dependency, exactly matching vitest 4.0.16 (§18.6; plain `npm install` from lockfile; avoids the npm 10.8.2 Arborist crash). Before this, `npm run test:ci` could not run (“MISSING DEPENDENCY @vitest/coverage-v8”).
- **Baseline `test:ci`: 80/80 tests passed, but coverage gates (0.9/0.85/0.9/0.9) failed:** statements 88.66%, branches 70.1%, functions 88.79%, lines 88.84%. Weakest files: `engine.ts` (72.9% statements: `emptyResult` path + corrupt-shard path), `config.ts` (71.4%: `readInt`/`readBool` error cases, `redisInvalidationEnabled`), `replication.ts` (73.9%: state edge cases), `shard.ts` (error cases), `server.ts` (interpreter 500 path).
- **Action before first commit:** add error-path tests until `test:ci` passes the gates (list in `TODO.md` §1/§4).
- Note: `vitest.config.ts` has **no `coverage.include` limit** → new `scripts/extract/*.mjs` modules loaded in tests also count (their tests must satisfy the gates too).

## 20. Verified completion status (2026-10-15)

The historical plan above is made concrete by [ZIEL-PROMPT.md](ZIEL-PROMPT.md), [TODO.md](TODO.md), and [local acceptance](2026-10-15-abnahme.md). Stages 0–4, persistent updates, and coordinated weekly rebuild are implemented. Japan and 260 tests, including active coverage gates, are green. Docker and a full planet run remain external evidence items.

Corrections to historical assumptions:

- The extra objects from `osmium tags-filter` are normally added references, not a demonstrated filter defect (§19.2).
- Stage 3 uses a sorted OPL/ID streaming comparison. Native `getid` allocated more than the 2 GiB worker budget for real node IDs above 14 billion. Stage 2 still uses native way resolution.
- PBF blocks use the standard four-byte big-endian header-length prefix; the earlier varint-framing fallback was removed.
- Data timestamps come from source/replication metadata, not file mtime. Regional daily sequences are not global minute cursors.
- OAM1 writer version 2 uses typed identity and explicit missing member coordinates; the reader still supports version 1.
- The original coverage thresholds were represented incorrectly as fractions in the configuration. Explicit production includes and `coverage.thresholds` now enforce 90/85/90/90 percent; the gate has been verified active.
