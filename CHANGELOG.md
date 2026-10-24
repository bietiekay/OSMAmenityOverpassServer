# Changelog

## Unreleased

- Preserve complete replication changes while externally sorting the update
  spool by Base64-encoding each JSON payload. OSM tags can contain line breaks,
  which must not be interpreted as spool-record boundaries.
- Read JSONL and TSV records using LF-only framing. Unicode U+2028 and U+2029
  are valid data inside JSON strings and must not be treated as line endings.
- Add regression coverage for line breaks in tags, Unicode line separators in
  persisted delta records, and the coalesce/import update path.
