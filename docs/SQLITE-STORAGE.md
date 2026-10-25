# SQLite storage and fresh planet imports

Fresh Stage 4 builds use **OAM-SQLITE-1**. No old-index migration is provided.
Existing OAM1 readers remain for compatibility, but fresh extraction never writes
shards or partitioned helper indexes. Start with a new pipeline directory.

## Layout

```text
pipeline/
  data -> data-generations/build-sqlite-.../
  data-generations/build-sqlite-.../
    index.sqlite
    index.sqlite-wal             # present while WAL pages remain
    index.sqlite-shm             # shared-memory WAL index when in use
    manifest.json               # diagnostic snapshot
    state.json                  # diagnostic snapshot
  work/                         # chunk extraction, resumable import, diff sort
  update-cache/source-.../       # compact PBF ranges, metadata, temporary lookups
```

Use a local filesystem supporting SQLite WAL, symlinks, atomic renames, and
Linux `flock`. The complete pipeline is writable by the importer/updater. Do not
put the database on NFS. Retain the unchanged source PBF and its fingerprint.
Node's built-in `node:sqlite` supplies the database; no external database service
or npm native addon is needed. Use the repository's supported Node version.

## Import and restart

Run the usual full pipeline with `--stages 0-4 --amenities toilets`. Stages 0–3
still produce a bounded set of PBF chunks and per-chunk intermediate products.
Stage 4 loads support nodes, ways, and main objects directly into SQLite in that
order. Typed identity prevents node/way/relation ID collisions. Duplicate objects
are stored once. Each input chunk and its completion marker commit together.

Geometry assembly pages through object keys and commits every 256 objects,
including its resume cursor. The importer uses a bounded SQLite page cache and
on-disk temporary storage. A restart verifies input fingerprints (or trusts file
identity with `--resume-mode trust`) and reuses committed chunks and geometries.
An interrupted chunk/geometry batch is repeated. Input changes select a different
private staging database. A filesystem lock excludes competing builders.

Before publishing, the importer checks database integrity, helper presence,
configuration, and spatial counts, checkpoints the WAL, closes the database,
and atomically switches the `data` symlink under the generation lock. A failed
build leaves the previous serving database available. Snapshot/namespace guards
prevent replacing a live database with a regressed baseline.

## Commissioning and service startup

After setting the server environment, run:

```bash
node scripts/check-index.mjs --data-dir /path/to/pipeline/data --integrity --require-elements
```

The directory argument is the active `data/` path, not the pipeline root. The
checker reads authoritative SQLite metadata, verifies server configuration,
positive replication state, timestamp, counters and readable retained-source
paths, and optionally runs integrity validation. A nonempty main-object count
is required only with `--require-elements`. It never migrates data or hashes the
source. The updater independently checks the source fingerprint before lookups.

The Docker default command and systemd `ExecStartPre` use the same checker
without `--integrity`, keeping routine restarts inexpensive. Explicit import
commands override the Docker launcher and work before `data/` exists. Easy Setup
runs the full commissioning check after import and before service startup.
A legacy active pipeline is rejected on wizard resume; choose a new pipeline
and deployment directory and retain the old files separately.

## Tables and query consistency

- `raw_objects`: latest raw OSM object or deletion tombstone, keyed by `type:id`.
- `baseline_versions`: known baseline versions (including known absence).
- `geometry`: one rendered object per typed identity, including helpers.
- `spatial`: RTree bounding boxes for main amenity objects.
- `dependencies`: each main amenity and all raw objects used for its geometry,
  indexed in reverse for targeted updates.
- `helpers`: main amenity to supporting rendered object associations.
- `metadata`: format, build provenance, manifest, replication state, import cursor.
- `counters`: trigger-maintained exact main/helper counts.

Queries pin a baseline directory and collect metadata, spatial candidates and
helpers in one read transaction. Existing exact node/way bbox filtering and the
supported relation-bounds predicate remain. Geometry is rendered through the
existing JSON/XML output code. SQLite queries bypass geohash cell enumeration,
so large boxes do not create huge cell lists. `SHARD_PRECISION` is retained in
configuration hashes for compatibility; it no longer controls file count.
`SHARD_CACHE_MB` controls the SQLite page-cache budget per query connection.
The legacy cache hit/miss status fields remain but do not measure SQLite caching.
`localEngine.storageFormat` reports the format; `shards` is zero for SQLite.

## Diff processing

1. Download, parse, and externally coalesce all ordered planet diffs. This work
   still depends on the complete incoming diff volume.
2. Stage coalesced rows in a temporary database table without modifying live data.
3. Acquire the sole writer transaction and check the namespace, sequence range,
   configuration and retained PBF provenance.
4. Find affected main objects with indexed dependency lookups. Compare relevant
   changes against known versions, resolving baseline misses through the retained
   PBF block index. Creating that block index requires one initial source scan.
5. Store all current delta objects, including unrelated ones, so future toilets
   can resolve geometry changed after the baseline. The overlay therefore grows
   with distinct changed objects globally, rather than only the toilet count.
6. Rebuild affected amenities against the final batch state. Replace their exact
   dependencies and helper associations, remove obsolete helper geometry, and
   update spatial entries. No full-index recount or validation scan runs here.
7. Commit data, counters, timestamp and replication sequence together. An error
   before commit rolls everything back; an empty/stale batch still advances its
   valid sequence. Diagnostic JSON sidecars are refreshed after commit.

The baseline directory stays stable across ordinary diffs. One update writer and
many consistent readers can operate concurrently through WAL. A passive
checkpoint follows each batch; reader snapshots can defer it. Large transactions
need WAL disk headroom, and long readers can prolong WAL retention. Completed
updates remain valid if diagnostic sidecar refresh fails. The database remains
authoritative after a crash, even when JSON sidecars are stale.

Baseline lookups run in batches of up to 400 requests with adaptive splitting;
`UPDATE_WORKERS` permits 1–16 concurrent lookup batches. Geometry assembly runs
one amenity at a time and limits dependencies to 50,000, estimated raw cache to
64 MiB, and relation depth to 16. A diff batch may affect at most 50,000 amenities.
These checks are not a host-wide memory limit. Missing nested members during initial assembly are resolved through the retained
PBF index. Full Overpass semantics are not claimed.

## Rebuilds, backups and rollback

A full re-extract builds a separate database, catches it up under the generation
lock, validates it and switches `data` once. Normal diffs never copy a database
or create a new physical generation. Retention therefore keeps baseline/rebuild
generations, not previous individual diff states.

Stop the server and updater before copying the whole pipeline, or use SQLite's
online backup API for a consistent live database backup. Do not copy only
`index.sqlite` while a writer is running: committed pages can still be in the WAL.
Keep the matching immutable PBF and application/configuration provenance.
Rollback uses a verified backup or retained full baseline through the existing
`activateGeneration` validator. Restarting will resume catch-up from that cursor.

No full-planet timing or database-size estimate has been measured for this
format. Tests cover fresh imports, spatial queries, version guards, future
references to unrelated deltas, parent geometry updates, reader snapshots,
transaction rollback, candidate catch-up and metadata authority.
