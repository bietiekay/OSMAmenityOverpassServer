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

Fresh imports create `data-generations/<id>/index.sqlite` in OAM-SQLITE-1 format
and publish it through the `data` symlink. Metadata inside SQLite is authoritative;
`manifest.json` and `state.json` are diagnostic sidecars. The engine pins the
baseline directory and reads query data and metadata in one SQLite transaction.
Ordinary updates commit into that database in place. Full rebuilds create and
activate a separate baseline. No migration is provided.

## 4. OAM-SQLITE-1

`raw_objects` stores current typed OSM identities and tombstones; `geometry`
stores deduplicated main and helper objects; `spatial` is an RTree of main
bounds. `dependencies` and `helpers` track exact main-object dependencies and
output members. `baseline_versions` records validated source versions.
Trigger-maintained counters and replication metadata commit with data changes.
The configuration hash retains amenities and the compatibility precision value.
Full details are in [SQLite storage](docs/SQLITE-STORAGE.md).

The legacy OAM1 reader remains compatible with its v1/v2 binary formats; fresh
imports do not produce those files. Missing source metadata is never fabricated.

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
`OSM_AMENITY_REEXTRACT_EVERY_SECONDS` (default 15552000, opt-in through `OSM_AMENITY_REEXTRACT_ENABLED`). Source selection is `OSM_AMENITY_REEXTRACT_SOURCE_PBF`, otherwise a newly
downloaded current planet PBF. The
update watch loop checks this schedule after each
replication catch-up cycle. Candidate catch-up holds the generation lock while
downloading and applying its remaining diffs, so long gaps delay other updates;
the active generation continues serving queries during this work.

SQLite diffs use a single writer transaction with consistent concurrent WAL
readers. The update path does not clone the baseline or scan the complete spatial
index. Any failure before commit preserves data and cursor. Geometry builds
limit dependency count to 50,000, estimated raw cache to 64 MiB and relation depth
to 16; a batch may affect at most 50,000 amenities. See the storage guide for
source lookup, checkpoint and backup requirements. Retention applies to full
baseline generations; individual diff rollback snapshots are not created.
