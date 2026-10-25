# Architecture

The service answers the constrained amenity/Bounding-Box Overpass QL subset
used by Overpass-Proxy. Fresh indexes use **OAM-SQLITE-1**. See
[SQLite storage](SQLITE-STORAGE.md) for the schema, consistency model, update
algorithm, budgets, backups and restart behavior. The API contract is in
[the specification](../specification.md).

## Module map

| Module | Responsibility |
|---|---|
| `src/config.ts` | Environment configuration and validation |
| `src/query.ts` | Strict supported QL parser |
| `src/index/database.ts` | SQLite schema, raw/geometry storage, RTree, counters, metadata |
| `src/index/engine.ts` | Consistent query snapshots, precise filtering, member expansion |
| `src/index/shard.ts` | Legacy OAM1 compatibility and configuration hashing |
| `src/output.ts` | Overpass-compatible JSON/XML and ETags |
| `src/server.ts` | HTTP endpoints and authoritative persisted status |
| `src/updater.ts` | Isolated update worker process and shutdown |
| `scripts/extract.mjs` | Pipeline orchestration and input provenance |
| `scripts/extract/stages.mjs` | Streaming amenity/reference extraction |
| `scripts/extract/assembly.mjs` | Resumable fresh database import and baseline activation |
| `scripts/database/geometry.mjs` | Geometry with exact transitive dependency recording |
| `scripts/database/update.mjs` | Atomic in-place SQLite diff batches |
| `scripts/database/metadata.mjs` | Authoritative metadata and diagnostic sidecars |
| `scripts/extract/source-index.mjs` | Compact retained-PBF block lookup |
| `scripts/update/coalesce-diffs.mjs` | Bounded external sort and latest-event reduction |
| `scripts/update/generation.mjs` | Filesystem writer lock and full-baseline activation |
| `scripts/update/reextract.mjs` | Isolated full rebuild and feed catch-up |
| `scripts/update/cleanup.mjs` | Diff/work cleanup and baseline retention |

## Data flow

```text
Immutable planet PBF
  -> PBF chunks -> amenity/reference streams
  -> resumable private SQLite baseline
  -> integrity/configuration/cursor validation -> atomic data/ symlink switch

Ordered planet diffs
  -> parse/coalesce -> disk-backed temporary changes table
  -> indexed affected-object discovery -> current raw delta objects
  -> affected geometry/dependency rebuild -> data + cursor transaction commit

HTTP QL
  -> parser -> pinned baseline/read transaction
  -> RTree candidates + helpers -> precise bbox/type/amenity filter
  -> existing JSON/XML output
```

The new path avoids per-cell files, duplicated main records, complete file-tree
cloning, full recounts and per-file syncing during ordinary updates. Download,
parsing, sorting, needed PBF lookups, changed-page writes and WAL checkpoints
remain. Throughput on the complete planet must be measured separately.

The original OAM1 read/update path is retained for compatibility and its tests;
there is no migration and fresh builds always choose SQLite. Historic Japan
acceptance measurements under `plans/` describe the previous format and do not
establish SQLite planet performance.
