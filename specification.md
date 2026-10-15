# OSMAmenityOverpassServer specification

This document describes the implemented contracts at this revision. See
`plans/ZIEL-PROMPT.md` for the overall completion objective and `plans/TODO.md`
for current measured progress.

## 1. Interpreter request scope

`POST /api/interpreter` accepts form field `data`; `GET` accepts query parameter
`data`. Supported QL is deliberately narrow: one configured amenity equality,
valid common bbox shared by all selectors, selectors from node/way/relation,
optional union wrapper for multiple selectors, one supported output clause,
and optional `>; out <member-clause>;`. Directives are limited to supported
`[out:json|xml]` and positive timeout forms. Unknown syntax, filters, output
modes, misplaced commands, and unconsumed text return 501. Blank/missing data
returns 400.

Supported outputs are `out`, `body`, `skel`, `tags`, and `geom`, optionally
with `meta` and/or `qt` where meaningful. JSON element metadata fields are at
the element root (`version`, `timestamp`, optional `changeset`), matching
Overpass JSON; XML uses element attributes. Missing source metadata is omitted,
not fabricated. JSON/XML geometry and relation members are emitted when the
indexed member data supports them. `>;` member outputs are deduplicated by
`(type,id)` against main results. Nested relation closure is not a promise of
full Overpass parity.

Errors: 200 successful in-scope result with ETag; 400 missing/blank query; 501
out of scope; 500 on an unavailable/corrupt/mismatched generation or shard.
The base URL, interpreter endpoint, and status endpoint answer HEAD successfully
for proxy recovery probing.

## 2. Payloads and monitoring

JSON has `version: 0.6`, `generator`, optional `osm3s.timestamp_osm_base`, and
`elements`. `out meta` fields are flattened onto each JSON element. XML uses a
standard `<osm version="0.6" generator="…">` wrapper and omits unavailable
coordinates/metadata attributes.

`GET /api/status` exposes the usual `version`, `osm_osm_change`, `time_used`,
`memory_used`, and `output_format`, plus `localEngine`. The global
`osm_osm_change` field is set only when persisted replication provenance says
the cursor is planet/minute. Regional daily sequence values remain in
`localEngine.replication` with their kind, cadence, sequence, base URL, and
optional original minute provenance. Unknown cursor data is not guessed.
`GET /api/timestamp` returns the data timestamp or an empty string if unknown.

## 3. Generation layout and consistency

Pipeline root layout:

```text
<root>/work/                 resumable stage intermediates
<root>/data -> data-generations/<id>  active immutable generation
<root>/data-generations/<id>/manifest.json
<root>/data-generations/<id>/state.json
<root>/data-generations/<id>/shards/<geohash>.bin
```

The engine resolves the active directory once per query, then reads generation
metadata and shard files from that pinned real path. `manifest.shards` is the
authoritative shard inventory: undeclared stale files are ignored, while a
missing declared shard fails the query. Manifest configuration hash must match
the engine's `{ amenities, precision }` hash. `manifest.shards: []` is a valid
empty generation; missing metadata is not a ready index.

## 4. OAM1 binary shards

OAM1 keeps its magic and 78-byte header. Current writer format version 2 uses a
type-qualified `(type,id)` sorted index, preventing node/way/relation ID
collisions. The reader supports v1 indexes for compatibility. In v2 way member
coordinates encode missing values with paired `INT32_MIN` sentinels, so a real
coordinate `(0,0)` round-trips. The v1 representation used zero/zero for
missing coordinates, so the ambiguity for a v1 way at `(0,0)` cannot be
recovered. Current v2 CRC verification protects the header except its checksum
field and the data/index payload. Legacy v1 and early v2 payload-only checksums
remain readable. The configuration
hash includes effective amenities and shard precision.

Nodes are stored in their point shard; ways/relations are stored in the cells
selected by stage 4. Ways retain node IDs and inline coordinates for geometry
and member output. Relation member records retain type, ref, and role; helper
records are stored where available. Data with unavailable source metadata does
not receive invented metadata.

## 5. Pipeline and replication

`node scripts/extract.mjs` supports stages 0–4 with `--data-dir` as pipeline
root. Stage 0 splits PBF blocks into `work/chunks`; stage 1 extracts amenity
records; stage 2 resolves referenced ways and node IDs; stage 3 resolves needed
node records; stage 4 assembles and atomically activates a generation. Main
options are `--source` (alias `--planet-source`), `--stages`, `--chunk-mb`,
`--ram-mb`, `--worker-ram-mb`, `--workers`, `--keep-chunks`,
`--all-amenity-values`, `--amenities`, `--shard-precision`, and `--verify`.
Stages 1–3 require `osmium-tool`; source fingerprints and stage manifests
validate resumable artifacts.

Replication helpers support minute and day namespace URL construction, escaped
state timestamps, optional original planet sequence provenance, and a bounded
sequence iterator. A source descriptor uses `{baseUrl, kind, interval,
sequenceNumber, originalMinuteSeq?}`. The server's base URL defaults to the OSM
planet replication root. Geofabrik regional hosts are inferred as regional/day;
other configured hosts default to planet/minute.

The weekly candidate rebuild implementation is in
`scripts/update/reextract.mjs`. It requires a positive replication cursor and
timestamp on the candidate PBF, builds without publishing, catches up in the
same namespace to the latest feed or active cursor under the generation lock,
and activates once. Failure leaves the serving generation active. The first
scheduled check establishes its timer baseline; later checks use
`OSM_AMENITY_REEXTRACT_EVERY_SECONDS` (default 604800). Source selection is
`OSM_AMENITY_REEXTRACT_SOURCE_PBF`, falling back to
`OSM_AMENITY_SOURCE_PBF`, then the active generation's recorded PBF path. The
update watch loop checks this schedule after each
replication catch-up cycle. Candidate catch-up holds the generation lock while
downloading and applying its remaining diffs, so long gaps delay other updates;
the active generation continues serving queries during this work.

The implementation currently clones the full generation using hardlinks and
scans all declared shards for validation and exact unique counts per batch.
Before activation it fsyncs the files and nested directories. Only changed shard
contents are rewritten, but metadata work and verification remain proportional
to the whole generation. Update dependency closure is limited to 50,000 tracked
objects, 5,000 cells and 64 MiB of estimated rebuilt rows; source resolution has
a separate 64 MiB per-invocation resolved-object limit and adaptively splits
candidate-block batches. The shared geometry member cache has no aggregate
byte cap; this remains a production memory-limit follow-up. Failure
preserves the previous generation and cursor. Old generations are retained;
automatic garbage collection is not implemented.
