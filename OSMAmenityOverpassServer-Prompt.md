# OSMAmenityOverpassServer — working goal and implementation guide

This repository is an existing implementation, not a new-project scaffold.
Continue the completion work in `plans/ZIEL-PROMPT.md`; use
`plans/2026-10-14-osm-amenity-overpass-server.md` for historical planning and
`plans/TODO.md` for current verified progress. Do not treat historical claims
or old design details as current without checking source and tests.

## Goal

Finish a standalone local OSM amenity server, initially configured for
`amenity=toilets`, that can run behind the existing unmodified Overpass-Proxy
through `UPSTREAM_URLS`. It should answer only the verified local Overpass QL
subset, return 501 for unsupported queries so the proxy can fail over, build
immutable geohash-sharded data from a retained PBF source, and safely apply
replication updates. Japan is the development/acceptance dataset. A full planet
run and planet resource scalability are not established merely by Japan tests.

## Current contracts

- Interpreter requests use `data` in POST form or GET query parameters. In-scope
  responses are Overpass JSON/XML with ETag; blank queries return 400,
  unsupported syntax returns 501, and corrupt/unready generations return 500.
- JSON `out meta` fields are at element root. Do not nest them under `meta`.
  Missing metadata is omitted rather than invented.
- Index format is OAM1 version 2: typed `(type,id)` identity index, real `(0,0)`
  coordinate support, and v1 read compatibility. Manifest shard inventory and
  config hash are authoritative.
- Data root contains `work/`, active `data/`, and immutable
  `data-generations/<generation>/`. Stage 4 publishes a complete generation.
- Extraction CLI is `node scripts/extract.mjs` with stages 0–4 and
  `--data-dir` as the pipeline root. See README for actual options.
- Replication provenance distinguishes planet/minute from regional/day. Never
  report a regional daily sequence as the global Overpass minute cursor.
- The updater watch loop applies contiguous replication batches and checks a
  weekly candidate re-extract. Its schedule, cursor checks, candidate replay,
  and tiny-PBF worker flow have focused tests. This does not prove every crash
  recovery scenario, an unmodified proxy E2E, public Overpass parity, or
  planet-scale performance. Report only checks actually run.
- `OSM_AMENITY_REEXTRACT_SOURCE_PBF` can select a newer snapshot for the weekly
  rebuild; it falls back to `OSM_AMENITY_SOURCE_PBF`. Candidate sources must
  carry a valid timestamp and positive cursor in the active replication
  namespace. The update worker resolves the active generation's matching PBF
  first after a rebuild, even if the original configured source path remains.

## Working rules

1. Inspect source, plans, tests, proxy contract, and local tooling before making
   claims. Preserve the unmodified Overpass-Proxy checkout.
2. Use the source and explicit tests as the truth for supported behavior. Add a
   regression test for each correctness fix, especially fail-closed behavior,
   identity collisions, generation activation, and update recovery.
3. Keep PBF processing bounded and resumable. Do not replace external sort or
   partitioned lookups with planet-sized in-memory collections.
4. Activate only fully verified generations. A query must pin one generation
   for its lifetime and may not claim success if an expected shard is missing
   or unreadable.
5. Run `npm run lint`, `npm run build`, `npm test`, and `npm run test:ci`; keep
   measured results and limitations in the living TODO. Coverage thresholds
   are 90% statements, 85% branches, 90% functions, 90% lines.
6. Keep `README.md` and `specification.md` aligned with the real code. Record
   remaining limitations plainly: nested relation closure, stripped regional
   metadata, public parity, Docker, and planet-scale performance as applicable.

## Local verification

Use the tracked real-HTTP helper after starting the server:

```bash
node scripts/verify-http.mjs --url http://127.0.0.1:8081 \
  --expected-nodes /home/osm-amenity/japan/verification/tokyo-expected-nodes.json
```

It validates the local HTTP contract and checks source-record fields for the
supplied known nodes. It does not replace a complete Japan extraction, proxy
integration/fallback test, update/recovery test, or comparison against a live
public Overpass instance.
