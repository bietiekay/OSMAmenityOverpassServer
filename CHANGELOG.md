# Changelog

## Unreleased

- Add a shared SQLite commissioning/startup checker used by Easy Setup, Docker
  and systemd; verify authoritative metadata, cursor, configuration and retained
  source readability, with opt-in full database integrity checking.
- Refresh planet deployment examples, setup prompts, healthchecks, restart,
  backup and retention instructions for OAM-SQLITE-1. Refuse legacy setup resume
  without importing over existing data.

- Build fresh indexes as OAM-SQLITE-1 databases with central typed OSM objects,
  an RTree spatial index and exact amenity-to-object dependencies. No migration.
- Replace Stage 4 per-cell spools, shards and JSONL helper partitions with
  resumable SQLite imports and geometry assembly.
- Apply database diffs atomically in place with incremental counters and cursor
  publication; remove per-diff generation cloning, full recount and shard sync.
- Serve consistent WAL snapshots and read replication metadata from SQLite.
  Keep JSON sidecars for diagnostics and full rebuild generations for retention.

- Preserve complete replication changes while externally sorting the update
  spool by Base64-encoding each JSON payload. OSM tags can contain line breaks,
  which must not be interpreted as spool-record boundaries.
- Read JSONL and TSV records using LF-only framing. Unicode U+2028 and U+2029
  are valid data inside JSON strings and must not be treated as line endings.
- Add regression coverage for line breaks in tags, Unicode line separators in
  persisted delta records, and the coalesce/import update path.
