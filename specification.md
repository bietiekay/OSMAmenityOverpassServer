# OSMAmenityOverpassServer — Specification

Normative contracts for the wire interface (Overpass compatibility), the on-disk
index format (OAM1), and the replication/update bookkeeping. Implementations in
this repository are the source of truth; this document describes them.

---

## 1. Tile query wire contract (proxy → this server)

The unmodified Overpass-Proxy sends one request per geohash tile
(`buildTileQuery` in `Overpass-Proxy/src/upstream.ts`):

- `POST /api/interpreter`
- `Content-Type: application/x-www-form-urlencoded`
- body: `data=<urlencoded tile query>`
- `Accept: application/json`

The tile query (verbatim wire format, value **inside** the brackets):

```
[out:json][timeout:120];
(
  node["amenity"="toilets"](35.04,135.04,35.07,135.07);
  way["amenity"="toilets"](35.04,135.04,35.07,135.07);
  relation["amenity"="toilets"](35.04,135.04,35.07,135.07);
);
out body meta;
>;
out skel qt;
```

BBox tuple order is `(south, west, north, east)`.

Accepted amenity spellings: `["amenity"="X"]`, `[amenity=X]`, `[amenity='X']`.
The value is normalised with `trim().toLowerCase()`.

### 1.1 In-scope decision

A request is **in scope** iff **all** of the following hold (see `query.ts`):

1. Exactly one distinct normalised `amenity` value appears in set commands, and
   it is one of the configured `OSM_AMENITY_AMENITIES` values.
2. All set-command bbox tuples normalise to the same valid bbox
   (`south < north`, `|west|,|north| <= 90` etc.); the query is tile-shaped
   (no `[range]`, no `[maxdate]/[mindate]/[adiff]` filters, no `area` blocks).
3. Set commands address only `node`, `way`, and/or `relation` with the
   amenity equality filter; any other tag filter (`[highway=...]`, `[name~...]`,
   ...) makes the query out of scope.
4. `out` clauses are only `out`, `out body`, `out skel`, `out tags`,
   `out geom`, optionally combined with `meta` and/or `qt`; anything else
   (e.g. `out centre`, `out verbatim`) is out of scope.
5. The recursive member operator `>;` is the only relation expansion used.

Anything else (including unparseable queries) is out of scope.

### 1.2 Response codes

| Condition | Status | Body |
|---|---|---|
| In-scope query answered | `200` | Overpass JSON or XML (see §2), with `ETag` header |
| Out-of-scope query | `501` | `{"error":"out of scope"}` (`application/json`) |
| Missing/blank `data` field | `400` | `{"error":"missing query in form field \"data\""}` |
| Internal error | `500` | `{"error":"internal error"}` |

The proxy treats 5xx and 429 as upstream failures (retry/failover); `501` is a
deliberate "not served here" answer and triggers failover to the next upstream
without retry. This is the load-shifting contract: everything the server cannot
answer cheaply is handed back to the remote pool.

### 1.3 Other conformant endpoints

| Endpoint | Contract |
|---|---|
| `GET /api/status` | JSON, §3 |
| `GET /api/timestamp` | `text/plain`, the data-sequence timestamp (ISO 8601); falls back to current time when no data has been applied |
| `POST /api/kill_my_queries` | `200` empty body (no local query queue) |
| `HEAD` on base URL | `2xx` — the proxy's `probeUpstream` sends `HEAD` to the base URL; must not be redirected or proxied |

---

## 2. Response payload format

### 2.1 JSON (`out:json`)

Exactly the shape the proxy's cache expects:

```json
{
  "version": 0.6,
  "generator": "osm-amenity-overpass-server",
  "osm3s": { "timestamp_osm_base": "<ISO 8601 data timestamp>" },
  "elements": [ /* Overpass elements */ ]
}
```

Elements (matching Overpass semantics):

- **node**: `{ "type":"node", "id":1, "lat":35.68, "lon":139.69,
  "tags":{...}, "meta":{ "version":1, "timestamp":"...", "changeset":123 } }`
  — `meta` only when `out meta` was requested.
- **way**: `{ "type":"way", "id":1, "nodes":[...], "tags":{...}, "meta":{...} }`
  — `nodes` always present (`out body`), absent under `out skel`.
- **relation**: `{ "type":"relation", "id":1, "members":[{"type":"node","ref":1,"role":""}], "tags":{...} }`.

Member nodes requested via `>;` are served **skel/quiet** (coordinates only,
no tags) from the shard's inline member-coordinate index, deduplicated against
the main result set.

### 2.2 XML (default)

Standard Overpass XML document: `<osm version="0.6" generator="...">` with
`<node>/<way>/<relation>` elements; `meta` adds `version`/`timestamp`/`changeset`
attributes; tags are sorted by key.

### 2.3 ETag

`ETag: "<sha1-of-payload, first 32 hex chars>"` — weakly stable per content;
the proxy passes it through.

---

## 3. `/api/status` contract

Conformant block (identical field names to other Overpass implementations,
readable by external monitors):

```json
{
  "version": "osm-amenity-overpass-server",
  "osm_osm_change": "7327518",
  "time_used": 0.0,
  "memory_used": 123456784,
  "output_format": "JSON"
}
```

- `osm_osm_change` — the **minute replication sequence number** of the last
  applied data, as a string; `"0"` when no data has been applied. An external
  monitor fetches the live `minute/state.txt` (`sequenceNumber=`) from
  `OSM_AMENITY_UPDATE_BASE_URL` and compares: `liveSeq − osm_osm_change` is the
  number of minute files of staleness.
- `memory_used` — `process.memoryUsage().rss` (bytes).

Non-standard extension `localEngine` (for monitoring this server specifically):

```json
{
  "localEngine": {
    "shards": 3,
    "elements": 1432136,
    "amenities": ["toilets"],
    "shardPrecision": 5,
    "lastSeq": 7327518,
    "lastUpdate": "2026-10-14T12:01:02.000Z",
    "dataTimestamp": "2026-10-05T12:00:00Z",
    "updateIntervalSeconds": 3600,
    "updateBaseUrl": "https://planet.openstreetmap.org/replication",
    "stats": {
      "queries": 100, "errors": 0,
      "shardCacheHits": 42, "shardCacheMisses": 12,
      "latencyP50Ms": 1.2, "latencyP95Ms": 4.7,
      "lastQueryAt": "2026-10-14T12:00:00.000Z"
    }
  }
}
```

---

## 4. OAM1 shard binary format

One shard per geohash cell at the configured precision (default 5 — the same
size as one proxy tile). Little-endian. Pure `Buffer`/`DataView`, no native
deps.

### 4.1 Header (78 bytes)

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `OAM1` (`4F 41 4D 31`) |
| 4 | 2 | format version (`1`) |
| 6 | 16 | geohash of the shard (UTF-8, zero-padded to 16) |
| 22 | 4 | element count `u32` |
| 26 | 8 | `dataOffset` `u64` (start of string pool) |
| 34 | 8 | `idIndexOffset` `u64` |
| 42 | 8 | `nodeRefIndexOffset` `u64` |
| 50 | 8 | `buildSequence` `u64` (minute sequence of the build; 0 = unknown) |
| 58 | 16 | `configHash` (first 16 bytes of SHA-256 over the effective config) |
| 74 | 4 | `crc32` over bytes `[dataOffset, fileSize)` |

### 4.2 Data section (from `dataOffset`, offsets relative)

String pool: `u16 count`, then `count × (u16 len + bytes)` — UTF-8, unique
strings (tag keys, tag values, member roles).

Element records, file order. Base record (51 bytes):

| Size | Field |
|---|---|
| 1 | type (`1` node, `2` way, `3` relation) |
| 8 | id `u64` |
| 4 | version `u32` |
| 4 | timestamp (unix seconds) `u32` |
| 8 | changeset `u64` |
| 4 | lat `i32` ×1e-7 (0 for way/relation) |
| 4 | lon `i32` ×1e-7 |
| 16 | bbox `i32` ×4 (s,w,n,e) ×1e-7 — node bbox = own point; way/relation = bounding box of the element (way: from member node coords) |
| 2 | tagCount `u16` |

Then, per type:

- way: `u16 nodeCount` + `nodeCount × (u64 nodeId, i32 lat, i32 lon)` —
  member node ids **with inline coordinates** (16 bytes each). The engine
  serves `>;` member nodes straight from here (skel/quiet, no tags).
- relation: `u16 memberCount` + `memberCount × (u8 memberType, u64 refId,
  u16 roleIdx)` (11 bytes each).

Tag pairs: `tagCount × (u16 keyIdx, u16 valueIdx)` — indices into the string
pool.

### 4.3 Id index

`u32 count` + `count × (u64 id, u32 recordOffset)`, sorted by id; binary
search for point lookups (update apply: upsert/delete).

### 4.4 Node-ref index

`u32 count` + `count × (u64 nodeId, u16 refCount, refCount × u32 recordOffset)` —
node id → all record offsets referencing that node (ways that reference it,
as member). Used to update way records when a member node moves/disappears.

### 4.5 Invariants

- A **node** exists in exactly one shard (the cell of its coordinates).
- A **way** is duplicated into every shard its bounding box intersects (bbox
  from member node coordinates); member nodes are referenced by id with inline
  coordinates, so no cross-shard fetch is needed for `>;`.
- A **relation** is duplicated into every shard its members' combined bbox
  intersects.
- Updates rewrite the affected shards atomically (tmp file + rename).
- `verifyShard` re-checks magic, version, config hash, crc32, and record
  walkability before the engine serves a shard.

---

## 5. Data-directory bookkeeping

Layout under `OSM_AMENITY_DATA_DIR`:

```
<data-dir>/
├── shards/<geohash>.oam1        # one file per geohash cell
├── state.json                   # { lastSeq, lastUpdate, dataTimestamp }
├── manifest.json                # { totalElements } (written by the pipeline)
└── work/                        # pipeline scratch (chunks, state markers)
```

### 5.1 `state.json`

```json
{ "lastSeq": 7327518,
  "lastUpdate": "2026-10-14T12:01:02.000Z",
  "dataTimestamp": "2026-10-05T12:00:00Z" }
```

- `lastSeq` — minute sequence number of the last applied update (the canonical
  cursor; surfaced as `osm_osm_change`).
- `lastUpdate` — wall-clock time the update was applied.
- `dataTimestamp` — data-sequence timestamp of the applied minute file
  (feeds `osm3s.timestamp_osm_base` and `/api/timestamp`).

### 5.2 `manifest.json`

```json
{ "totalElements": 1432136 }
```

Written by the extraction pipeline; the engine reads it for `/api/status`
until shards are counted explicitly.

---

## 6. Minute replication (update source)

- Base URL: `OSM_AMENITY_UPDATE_BASE_URL`
  (default `https://planet.openstreetmap.org/replication`).
- State: `GET <base>/minute/state.txt`

  ```
  #version=2
  sequenceNumber=7327518
  timestamp=2026-10-14T12:00:02Z
  md5sum=<32 hex>
  ```

- Minute file URL: `<base>/minute/<AAA>/<BBB>/<CCC>.osc.gz` where the 7-digit
  zero-padded sequence is split 3/3/1 (`7327518` → `minute/732/751/8.osc.gz`).
- Catch-up from `lastSeq` (exclusive) to `sequenceNumber` (inclusive); empty
  list when up to date. Minute diffs are small (measured 20–130 KB); larger
  catch-ups (hours/days worth) download minute by minute — hour/day file
  catch-up is a documented future optimisation, not required for correctness.
- Applied updates touch only the geohash cells affected by each change and
  invalidate those cells in the shard cache.

---

## 7. PBF block framing (stage-0 scanner)

Stage 0 copies whole PBF blocks into chunk files, so it must understand block
boundaries without decompressing payloads. Two framings are supported:

- **osmium ≥ 1.14 / libosmium ≥ 2.18 ("new")** — verified against the
  `test/formats/f1*.osm.pbf` reference files:
  `[u32be blobHeaderLength][BlobHeader][datasize bytes of blob]`, where
  `BlobHeader` is a protobuf message with field 1 = type string
  (`"OSMHeader"` / `"OSMData"`) and field 3 = varint `datasize`. An all-zero
  length marks EOF.
- **classic OSM PBF (2016+ planet files)**:
  `[varint blobHeaderLength][BlobHeader][blobSize bytes of blob]`, `BlobHeader`
  field 1 = varint blob size, field 2 = varint type enum (1 OSMHeader,
  2 OSMData).

Detection runs on the first block only; all pipeline input in this project is
produced by osmium 1.14, so the new framing is the primary path.

---

## 8. Extraction pipeline stage contract

`scripts/extract.mjs` stages (each idempotent and resumable via `work/state/`
done-markers, abortable via SIGINT/SIGTERM):

| Stage | Input | Output | Notes |
|---|---|---|---|
| 0 | `planet.pbf` | `work/chunks/cNNNN.pbf` + `work/chunks/manifest.json` | pure-TS block scanner + byte copy, parallel workers; `--verify` re-counts objects with osmium and requires equality with the planet |
| 1 | chunk PBFs | amenity-filtered object files | osmium + Lua filter on the configured amenity values (parallel per chunk) |
| 2 | stage-1 files | node→parent (way/relation) membership + member coordinates | osmium `getparents`/`add-locations` passes (parallel per chunk) |
| 3 | stage-2 files | `shards/*.oam1` | pure-TS shard assembly (parallel per shard group) |

Chunk manifest (`work/chunks/manifest.json`):

```json
{ "planetSource": "<abs path>", "chunkMb": 1024,
  "totalBlocks": 923, "dataBlocks": 922,
  "chunks": [ { "id":"c0001", "firstBlock": 1, "lastBlock": 1000,
                 "blocks":[1,2,3], "bytes": 1024123456 } ] }
```
