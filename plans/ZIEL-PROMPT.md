# Project Work Brief: Complete OSMAmenityOverpassServer

## Assignment and goal

Continue the existing repository at `/home/bietiekay/code/OSMAmenityOverpassServer`
as a self-contained, self-updating OSM amenity server. It serves configured
`amenity` values, initially `toilets`, from a local geohash index through the
required Overpass interface. The existing `Overpass-Proxy` must be able to use
it solely through `UPSTREAM_URLS`; do not change the proxy source.

Development and full local acceptance use Japan data. Production should be able
to use the same code for the full OSM planet. Docker is unavailable for this
local work: implementation, tests, server, and any proxy E2E run as local
processes. Keep Docker files as deployment artifacts; a Docker test is not a
local prerequisite.

## Starting point and required working practices

Read `OSMAmenityOverpassServer-Prompt.md`,
`plans/2026-10-14-osm-amenity-overpass-server.md`, `plans/TODO.md`,
`specification.md`, `README.md`, existing tests, and affected source code.
Plan section 19 replaces the old extraction design with Stages 0–4. This brief
clarifies the current requirements. Verify historical status and technical
assumptions before relying on them. Correct evidenced inconsistencies across
code, tests, and documentation together.

Build on the existing implementation. The server, parser, OAM1 format, engine,
cache, and replication helpers exist; at the time this brief was written,
extraction only had Stage 0 and the server had no update loop. Work in verifiable
steps and keep `plans/TODO.md` current with results, commands, measurements, and
actual limitations. Complete the acceptance work; a green unit-test run alone
does not constitute completion.

## 1. Secure the current state and interface contracts

- Check local tools, source data, free disk, Git state, and dependencies. Use
  the existing lockfile and avoid unnecessary version changes.
- Determine the real contract from the unchanged proxy checkout at
  `/home/bietiekay/code/Overpass-Proxy`, especially tile queries, response
  handling, 501 failover, and HEAD recovery probes.
- Run `npm run verify` and `npm run test:ci` as a baseline. Fix the coverage
  gate: Vitest requires `coverage.thresholds` with percentage values
  `lines: 90`, `branches: 85`, `functions: 90`, and `statements: 90`. Explicitly
  include productive server and pipeline code in coverage. Demonstrate once
  that falling below a threshold fails the command.
- Check known gaps: GET must read `data` from query parameters; `query.types`
  must restrict results; identity, lookup, and deduplication must use
  `(type, id)` because OSM IDs are only unique within an object type.
- Enforce the actually supported QL subset. Unknown trailing syntax, extra
  filters, different bounding boxes, and unsupported operations must not be
  accidentally treated as locally answerable.
- Check JSON/XML, metadata, geometry, `out` variants, and `>;` against the
  required Overpass contract. Distinguish project diagnostic extensions from
  verified standard compatibility. Corrupt or unreadable present shards must
  never produce a misleading successful, apparently complete response.

## 2. Fully implement extraction Stages 0–4

Implement a source-independent CLI accepting `--source <file.pbf>`; retain
`--planet-source` as an alias. Support individual stages and `--stages 0-4`.
Use one convention: `--data-dir` is the pipeline root, containing `work/` and
the completed server index under `data/`.

1. **Stage 0:** Copy PBF blocks into independently readable chunks. Verify the
   asserted PBF framing against the format specification and real files.
   `--verify` must compare independent node/way/relation counts for the source
   and sum of chunks, and fail on mismatch.
2. **Stage 1:** For each chunk, use `osmium cat` and a robust Node.js streaming
   XML parser to extract amenity objects with metadata, tags, and references.
   Write `amen_cNNNN.lines` and `ids_cNNNN.lines` as described in plan §19.4.
   With `--all-amenity-values true`, retain every value as an intermediate;
   the final index contains only configured values and required helper objects.
3. **Stage 2:** Deduplicate referenced way IDs globally with bounded RAM, resolve
   ways from all chunks using `osmium getid`, and collect their node references.
   References may cross chunk boundaries.
4. **Stage 3:** Merge required node IDs and resolve node coordinates and
   required member data from chunks. Handle and report missing references and
   conflicting duplicates deliberately.
5. **Stage 4:** Assign configured amenities spatially and write OAM1 shards
   using the existing writer: nodes to their point cells, ways/relations to all
   required cells according to the spatial contract. Inline coordinates and
   helper objects must support the promised member output, including nodes of
   referenced ways. Helper objects must not appear accidentally as main hits.
   Deduplicate each cell by `(type, id)`. Write
   `data/shards/<geohash>.bin`, `manifest.json`, a configuration hash, and a
   consistent `state.json`.

The line format needs round-trip tests for XML entities, Unicode, encoded
tags/roles, empty roles, missing metadata, and empty tag sets. Parsing must not
depend on a particular XML line split.

Use the revised streaming design without a Lua dependency. Recheck the
historical `tags-filter` bug diagnosis: by default the tool adds referenced
objects; `--omit-referenced` disables that behavior. Document a reproducible
result without making progress on the planned pipeline depend on this check.

## 3. Make resource limits, cancellation, and resume reliable

- Configurable total budget `--ram-mb` (default 8192), per-worker budget
  `--worker-ram-mb` (default 2048), `--workers`, chunk size, `--keep-chunks`,
  and `--all-amenity-values`.
- Bound concurrency by CPU and total budget, including native osmium processes.
  Measure RSS and temporary disk use on the Japan run.
- Avoid unbounded global node/object maps and ID lists. Use partitioned
  processing, external sorting, or disk-backed lookups for planet-scale data.
  A successful Japan run does not prove planet scalability.
- Done markers must validate the source, relevant configuration, and outputs.
  A changed source/configuration must not reuse stale results. Resume must retain
  complete manifest information.
- SIGINT/SIGTERM must stop processing and child processes cleanly. No later
  stages may start after cancellation, and incomplete output must not be marked
  complete. A restart should resume valid work packages.
- Build index generations separately and activate them only after validation.
  Removed shards must not survive a re-index as stale files. A published index
  must remain recoverable after a crash.

## 4. Accept the fixture and Japan end to end

First regenerate the deterministic fixture and verify Stage 0. Add targeted
cases for identical numeric IDs of different types, chunk/cell boundaries,
member recursion, missing references, and resume. Document the limits on nested
relations; do not promise full Overpass parity for unsupported cases.

Then run the complete local pipeline:

```bash
node scripts/extract.mjs \
  --source /ssdbuffer/osm-amenity/planet/japan-latest.osm.pbf \
  --data-dir /home/osm-amenity/japan \
  --stages 0-4 \
  --chunk-mb 256 \
  --ram-mb 8192 \
  --worker-ram-mb 2048 \
  --all-amenity-values true \
  --verify
```

Compare independent source counts with the manifest. Report separately all
extracted amenities, configured unique main objects, helper objects, and
spatially duplicated shard records. Check known Japan samples, including Tokyo,
against the source file.

Start the server with `OSM_AMENITY_DATA_DIR=/home/osm-amenity/japan/data` and
exercise GET/POST, JSON/XML, nodes/ways/relations, metadata, members, ETag
stability, 400, 501, status, timestamp, kill no-op, and HEAD probes over real
local HTTP. Check cancellation/resume and re-indexing with additional amenity
values. Test the unchanged proxy against local upstreams, including a controlled
fallback. Public Overpass parity is an additional network check; report it as
open if the service is unreachable.

## 5. Complete self-updating behavior correctly

After successful initial extraction, implement the update loop with a default
interval of 3600 seconds. The source remains minute replication; never convert
hour/day sequence numbers into minute sequence numbers.

- Correct the URL layout to nine digits in three groups:
  `7327518` → `minute/007/327/518.osc.gz`. Also parse escaped `state.txt`
  timestamps actually used by the source.
- Define a reliable baseline from source metadata and matching replication
  state. Unknown sequence `0` is not an instruction to fetch every diff since
  the beginning. Filesystem mtime is not a reliable data timestamp. Record
  provenance and cursor namespace.
- Define regional mode explicitly. Global diffs must not gradually add
  worldwide amenities to the Japan index. Use a consistent regional update
  source or an explicit regional model that handles boundaries and objects
  moving into/out of the region correctly. A regional snapshot alone does not
  spatially filter global diffs.
- Download and process missing diffs in ascending order with bounded resources.
  Support create/modify/delete, amenity changes, coordinate changes, member
  additions/removals, and dependent ways/relations. Specify how complete
  reference data is obtained when a diff omits it.
- Add persistent object/reference lookups, version guards, and crash-safe shard
  updates. Advance cursor, manifest, and timestamp only after a consistent
  commit; invalidate affected cache entries. Restart/retry must neither lose
  nor duplicate changes.
- Test failures, retries, gaps, restart, and idempotency deterministically with
  synthetic osmchange data. Add a suitable real update run once the baseline and
  replication source are unambiguous.
- Connect data timestamps to JSON/XML and diagnostics. Never make unknown data
  freshness look current by substituting the wall clock.

Implement weekly re-extraction as a drift guard with validated source
generation, catch-up, and consistent activation. Rebuilding the same old
snapshot must not discard current updates. Define coordination for concurrent
update/rebuild work.

## 6. Completion criteria and limits

The work is complete when full Japan extraction, local HTTP E2E, cancellation/
resume, re-index, proxy contract, and update/recovery tests are evidenced, and
`npm run lint`, `npm run build`, `npm test`, and `npm run test:ci` pass with
effective coverage thresholds.

README, specification, original prompt, and TODO must agree on stage numbers,
paths, file extensions, timestamp/cursor rules, and implemented capabilities.
Report changes, checks, Japan runtime, resource use, and remaining external
evidence.

Planet capability means a configurable source, the same pipeline, and
well-founded resource limits. Do not claim a full-planet run was tested on this
machine. Docker E2E also remains open until run in an environment with Docker.
Redis invalidation, additional tag keys, and long-term TTL tuning are optional
follow-up work. Distinguish index freshness from client freshness delayed by
proxy TTL: an hourly updater does not guarantee hourly client freshness with a
24-hour proxy TTL.

## Historical baseline for this brief (October 15, 2026)

The following captures the state when this brief was written; it is not the
current acceptance result. See [the local acceptance report](2026-10-15-abnahme.md)
and [TODO/status tracking](TODO.md) for the completed result.

- `npm run verify` passed: 10 test files, 80 tests.
- `npm run test:ci` returned 0 despite 88.66% statements, 70.10% branches,
  88.79% functions, and 88.84% lines; the then-current coverage gate was
  ineffective.
- Git already contained commit `e6c9859` (`initial`); the old plan's claim of
  “0 commits” was obsolete.
- Japan PBF, Node.js, and osmium were available locally. No full Japan run had
  started for that baseline assessment.
- Technical references: [Vitest coverage thresholds](https://vitest.dev/config/coverage#coverage-thresholds),
  [osmium tags-filter](https://docs.osmcode.org/osmium/latest/osmium-tags-filter.html),
  [Pyosmium replication URL construction](https://github.com/osmcode/pyosmium/blob/master/src/osmium/replication/server.py).
