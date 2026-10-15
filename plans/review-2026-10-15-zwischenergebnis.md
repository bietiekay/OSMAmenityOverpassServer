# Interim Review: OSMAmenityOverpassServer — October 15, 2026

**Review scope:** Work by the second agent since the R4 state (checkpoint
October 15, 2026, approximately 11:20).
**Mode:** Strictly read-only against the repository. The only added file was
this report under `plans/`.
**Verification runs (no repository edits):** `npm run verify` and
`npm run test:ci` (writing only ignored `dist/` and `coverage/`); an independent
server on port 18099 against Japan data (update URL pointed at a dead port;
namespace guard correctly refused it, `state.json` stayed unchanged at sequence
4939, and no `update-diffs` appeared); an independent proxy E2E harness under
`/tmp/op`; independent osmium counts; and integrity scan of all 6,720 shards.

> **Historical interim assessment.** This report captures a review checkpoint,
> not the final acceptance state. Later findings and the final 260-test
> acceptance are recorded in [`2026-10-15-abnahme.md`](2026-10-15-abnahme.md)
> and [`TODO.md`](TODO.md). Do not treat interim open items below as current
> unless they also appear in the final acceptance limitations.

---

## 1. Overall finding

**Strong interim state.** The full extraction pipeline (Stages 0–4) was
implemented and completed on real Japan data (2.55 GB PBF). The server served
the Japan index correctly in direct HTTP E2E and through the unchanged
Overpass-Proxy. The update-pipeline skeleton (diff download, transactional
generation switch, delta store, dependency closure) was implemented and
unit-tested, but had not yet been verified end to end with real replication
diffs. The coverage gate had just become effective, but was failing. All work
after the initial commit was uncommitted at this checkpoint.

No blocking defect was found in the inspected data path. Counts were externally
reproducible with osmium and internally consistent (shard scan == manifest).

## 2. Git state at the checkpoint

- Commit `e6c9859` (`initial`, October 15, 2026 at 11:29:12) represented the R4
  state (scaffold + Stage 0 + plans).
- **46 uncommitted entries** (27 modified + 19 untracked): among them
  `scripts/extract.mjs` (implementation), new `scripts/extract/*` modules,
  `scripts/update.mjs` + `scripts/update/*`, `src/updater.ts`, changes in 10
  `src/` and 9 `tests/` files, `vitest.config.ts`, `README.md`,
  `specification.md`, `Dockerfile`, and `plans/TODO.md`; new files included 12
  test files, `plans/ZIEL-PROMPT.md`, `.dockerignore`, and
  `scripts/verify-http.mjs`.
- The canonical plan `plans/2026-10-14-osm-amenity-overpass-server.md` was not
  changed (mtime 11:02). At that point, `plans/TODO.md` (12:16) and
  `plans/ZIEL-PROMPT.md` (11:38) were the status documents in active use.
- A second commit was pending at the review checkpoint.

## 3. Implementation and deviations from Plan R4

**Extraction CLI** (`scripts/extract.mjs` and `scripts/extract/*`):

- All planned flags were present: `--source` (with `--planet-source` alias),
  `--stages 0-4`, `--amenities` (default `toilets`), `--shard-precision`
  (default 5), `--ram-mb` / `--worker-ram-mb` (worker count automatic),
  `--keep-chunks`, `--all-amenity-values`, and `--verify`.
- Stage 1: per chunk, `osmium cat -f osm` → pure Node streaming XML parser
  (`xml.mjs`, bounded buffers) → `amen_cNNNN.lines` + `ids_cNNNN.lines`;
  worker processes with heap limits and RSS supervision; done marker with
  fingerprint, size, and SHA-256; resume verification (SIGINT test left no
  orphan processes and preserved markers).
- Stage 2: sorted unique way IDs → `osmium getid` per chunk → `ways_*.xml/.lines`
  + `node-ids.txt` (exit 1 for chunk-local missing IDs is accepted when XML is
  valid).
- **Stage 3 — justified deviation:** OPL/ID streaming merge
  (`osmium cat --object-type=node -f opl | awk Merge | osmium cat -F opl`)
  instead of `getid`. Measurements showed `getid` exceeded the 2 GiB worker
  budget for modern IDs (>14 billion), with 6.2 GB peak process-tree RSS
  (`verification/extract-rss-limit-metrics.json`). A sort guard (exit 42)
  detects unsorted OPL streams.
- Stage 4: single-process assembly; hash-partitioned JSONL lookups (bounded
  cache); **per-cell JSONL spools instead of the planned binary `.rec` codec**
  (functionally equivalent, transient, deleted after build); per-cell
  deduplication (main before support, highest version wins); missing reference
  is a hard error; atomic symlink swap of `data/`; at the checkpoint, replacing
  a generation that already had updates (`lastSeq > 0`) was refused as a
  re-extract guard.
- Line format matched plan §19.4 (checked form:
  `N <id> <ver> <ts> <cs> <lat7> <lon7> - [k=v]`, tags via
  `encodeURIComponent`, `-` marker).

**OAM1 v2** (`src/index/shard.ts`): typed ID index (u8 type; eliminates
Node/Way ID collisions, matching `apply.ts`), CRC over header excluding the
checksum plus payload, strict validation (value bounds, sorting, duplicates,
record end == ID-index start, cross-checking member references), and **v1 read
compatibility**.

**Engine/server** (`engine.ts`, `server.ts`, `replication.ts`, `config.ts`):

- Request pins a generation (one `realpath`), validates expected and manifest
  config hashes, fails strictly on corrupt/missing shards rather than silently
  continuing, resolves relation-to-relation members (fixing an R4 limitation),
  matches way bboxes through member coordinates, and sorts deterministically
  by type and ID.
- `/api/status`: compatible block plus `localEngine` (shards, elements,
  amenities, `lastSeq`, `dataTimestamp`, replication, stats).
  `osm_osm_change` is emitted only for planet/minute cursors; regional/day
  cursor stays under `localEngine.replication`, appropriate for Japan
  development while retaining diagnostics.
- HEAD probe route returns 200; GET `data` query parameter is accepted; minute
  URLs now use nine digits in 3/3/3 groups (the initial commit incorrectly used
  seven digits, e.g. `.../751/8` instead of `.../751/008`).

**Update pipeline** (new Phase 2): `src/updater.ts` (out-of-process child,
auto-restart, clean stop); `scripts/update.mjs` (watch loop, namespace guard on
baseUrl/kind/interval vs `state.json`, 100,000-diff gap limit, MD5 check for the
last diff); `scripts/update/*` (streaming osmChange parser, append-only overlay
`DeltaObjectStore`, copy-on-write for hardlinked files, version guard,
generation transaction, dependency closure through `reverse-parents` index,
budgets MAX_AFFECTED 50,000 / MAX_CELLS 5,000 / 64 MB, incremental manifest
counts). Tracked indexes live under `generation/update-indexes` and are built
on the first update.

**Tests/coverage:** 22 test files / 156 tests at this checkpoint (previously
10/80). `vitest.config.ts` was corrected: R4 thresholds were misplaced and
expressed as fractions, making the gate ineffective. They now live under
`coverage.thresholds` and include `src/`, `scripts/extract*`, and
`scripts/update*`. A negative test proves enforcement.

**Documentation/Docker:** `README.md`, `specification.md`, and
`OSMAmenityOverpassServer-Prompt.md` were rewritten to match implementation.
`Dockerfile` changed to node:22-bookworm-slim + `osmium-tool` + `coreutils` +
`gawk` (`gawk` is needed for the Stage 3 merge; Debian's default `mawk` would
not suffice). Compose template included a Japan example.

## 4. Review verification at the checkpoint (October 15, 2026, 13:30–14:20)

**Test suite:**

- `npm run verify` (lint + build + tests): **passed**, 22 files / 156 tests.
- `npm run test:ci`: tests passed, but coverage gate **failed**: lines 90.59%
  (threshold 90 ✓), statements 83.76% (90 ✗), branches 74.84% (85 ✗), functions
  83.26% (90 ✗). Weak areas: `src/index.ts` 0%, `src/updater.ts` 0%, entry
  points in `scripts/update.mjs` 0%, `scripts/update/replication.mjs` download
  path ~46%, `scripts/extract/storage.mjs` 77.5/62.2/83.3/83.0%, and
  `process.mjs` 65.6%. TODO correctly listed these as open at that time.

**Japan pipeline (independent recounts against `work/`):**

| Stage | Result | Check |
|---|---|---|
| 1 (main) | N 678,906 / W 745,991 / R 7,988 | Exactly equals native `tags-filter -R` count for all amenity values ✓ |
| 1 (IDs) | N 5,951,973 / W 26,798 member references | — |
| 2 | `way-ids.txt`: 22,425 unique | Equals way records found; all member ways resolved ✓ |
| 3 | `node-ids.txt`: 5,192,772 unique | Equals node records found; lossless, raw 5.95m N IDs include cross-chunk duplicates ✓ |
| 4 | 6,720 shards; 32,293 main + 187 support + 61 duplicates = 32,541 | Equals `manifest.counts.shardRecords`; toilet subset in Stage 1: N 19,828 / W 12,407 / R 58 = 32,293 = `manifest.mainUnique` ✓ |
| Scan | all 6,720 shards | `verifyShard` OK, configHash == manifest, buildSequence 0, 32,541 elements ✓ |

**Japan server E2E** (independent instance, port 18099):

- `/api/status`: 6,720 shards, 32,293 elements, `dataTimestamp`
  `2026-10-14T20:21:12Z` (dump time), replication `{geofabrik japan-updates,
  regional, day, sequence 4939}`, `osm_osm_change` “0” — all correct.
- `scripts/verify-http.mjs` + `tokyo-expected-nodes.json`: **20/20 nodes**
  field-exact (type/ID/lat/lon/tags/version/timestamp/changeset), stable ETag,
  XML output, HEAD 200, 400 (empty `data`), 501 (out of scope),
  `kill_my_queries` 200.
- Way/relation recursion in Tokyo bbox 35.66–35.70 / 139.74–139.80: 334
  elements = 54 ways + 1 relation + 279 member nodes. Metadata was flattened
  into Overpass-compatible element root fields (way 134192225: version 2,
  timestamp 2021-05-03T19:57:16Z == Stage 1 source; changeset omitted because
  source value was 0).
- `out geom`: 52 ways with complete geometry.
- 501 behavior: `amenity=fuel` (not configured) → 501; `highway=…` (foreign
  key) → 501; `HEAD /` → 200.

**Proxy E2E against Japan data** (actual unchanged Overpass-Proxy `dist`):

- Tokyo tile: 200, 139 elements, generator `osm-amenity-overpass-server`.
- Tokyo way geometry: 200, 565 elements.
- 501 failover reached fallback (`controlled-fallback`, one fallback request).
- Recovery HEAD: 200.

The unchanged proxy worked against real Japan data through `UPSTREAM_URLS`
alone. See finding 9 for the proxy stats worker detail.

**Fixture (regenerated 11:45):** Stage 1 all-values output 22,857 N / 500 W /
40 R == `tags-filter -R` exactly (independent run); full fixture run: 144
shards, 10,540 toilet main, 158 support, 66,499 duplicates, 77,197 shard
records — arithmetic is consistent. The agent's Osaka tile fixture smoke
(55 elements, 501 failover, HEAD) was reproducible.

**Updater safety:** The namespace guard rejected the dotted update URL
(`configured update source does not match the active generation replication
namespace`); `state.json` was unchanged (sequence 4939), and there was no
`update-diffs/`. The review did **not** modify Japan data.

## 5. Correction to the R4 `tags-filter` diagnosis

R4 §19.2 called `osmium tags-filter` “unreliable/buggy (over-selects ~2–4%)”
and excluded it from the pipeline. The behavior was reproduced and corrected:
by default, `tags-filter` **adds referenced objects** (members of matched
relations); `-R` (`--omit-referenced`) produces an exact filter result.

The regenerated fixture confirmed:

- `tags-filter 'amenity=*' -R` → 22,857 N / 500 W / 40 R == Stage 1 lines ==
  `tags-count` (23,397 amenity objects), exactly, with no non-matches.
- Without `-R` → 26,114 N = 3,257 additional member references (expected
  completion behavior, not a bug).

Therefore the R4 bug diagnosis was incorrect; the observed excess count was
documented default behavior. The pipeline design (`osmium cat` → Node filter)
was retained; it is conservative, though native `tags-filter -R` would be
faster. Plan §19.2 is outdated on this point.

## 6. Deviations from Plan R4 (with rationale)

1. **Stage 3:** OPL streaming merge instead of `getid` (RAM measurements,
   §3); plan §§19.2/19.3 still said `getid` at this checkpoint.
2. **Stage 4 spool:** per-cell JSONL instead of binary `.rec` codec (§19.5),
   functionally equivalent and transient.
3. **Data layout:** `data-generations/build-<fingerprint>-<uuid>` + `data`
   symlink + `objects/` lookup instead of flat `data/` (shards + manifest +
   state). README/Specification had been updated; generation names explained
   the unusual directory names.
4. **`--verify` did not cover Stage 4** (plan §19.8 step 5: manifest counts vs
   osmium + sample shard verification); it covered Stage 0 chunk counts only
   at this checkpoint. Index verification was manual (verify-http and
   independent recounts). **Gap at review time.**
5. **Replication model:** regional/day state alongside planet/minute;
   `osm_osm_change` only for planet/minute — documented adaptation for Japan
   development while retaining compatible diagnostics.
6. **Stage 1 architecture:** one Node worker per chunk instead of in-process
   pool (RSS-supervised; considered acceptable).
7. **Plan document itself had not been updated:** it still described `getid`,
   `.rec`, and the `tags-filter` “bug”. TODO and ZIEL-PROMPT were the practical
   current documents at that review checkpoint.

## 7. Findings, risks, and open items at the interim checkpoint

1. **Coverage gate failed** (lines passed; statements/branches/functions
   failed; entry points `src/index.ts`, `src/updater.ts`, `scripts/update.mjs`
   at 0%; `replication.mjs` download path ~46%). TODO recorded this as open.
2. **All work since `e6c9859` was uncommitted** (46 entries); a second commit
   was pending.
3. **No generation retention/GC:** `data-generations/` grew on every update
   (hardlink clone is disk-cheap for unchanged files, but directory entries
   accumulate); the `previous-<ts>` rename only applied to the first
   non-symlink `data` directory.
4. The published generation's **`objects/` lookup** (Japan: 246 MB, 257 node
   and 65 way partitions) was not read by the update pipeline (baseline was
   Source-PBF block index + `delta-objects/` overlay). It was a build artifact
   and not described in Specification §3 layout; planet disk impact would
   matter. Decide whether to delete it after build or document it as baseline.
5. Four stale zero-byte temp files remained in `japan/work/stage1/`
   (`ids_c000{0,1,2,3}.lines.tmp-207144`) after SIGINT test; resume did not
   clean stale temp files (done-marker validation remained authoritative, so
   harmless).
6. **Stage 3:** `--worker-ram-mb` could not be enforced for the
   `osmium | awk | osmium` pipeline (log warning: “RSS supervision unavailable
   for pipeline osmium | awk | osmium”); worker budget enforcement was
   incomplete.
7. The plan was outdated (`getid`, `.rec` spool, `tags-filter` “bug”, Stage 4
   filter wording); it needed an R5 appendix or supersession note. TODO/ZIEL
   were practical current docs at that time.
8. **Update pipeline:** implemented and unit-tested, but no E2E with real diffs
   yet. The 100,000-diff gap threshold required periodic rebuilds. Coordinated
   re-extract without losing applied updates was still open; the Stage 4
   refusal when `lastSeq > 0` was a useful building block.
9. **Proxy-side finding (not an amenity-server defect):** proxy stats worker
   required reachable `REDIS_URL` (first E2E without env hung at
   `statistics.ready()` with `ENOTFOUND redis`; setting
   `REDIS_URL=redis://127.0.0.1:18079` let Japan E2E complete). Proxy Node
   process did not exit cleanly after `app.close()` because the stats worker/
   ioredis kept the event loop alive; relevant to Docker deployment.

## 8. Recommendations at the interim checkpoint

1. Commit the current state (second commit) to stabilize the review baseline;
   this was the only repository action the reviewer was not authorized to take.
2. Close coverage gaps (entry points `src/index.ts`, `src/updater.ts`,
   `scripts/update.mjs`; `replication.mjs` download path; `storage.mjs`) or
   renegotiate thresholds explicitly.
3. Extend `--verify` through Stage 4 (plan §19.8 step 5): manifest counts vs
   osmium counts (all amenity values + member objects) and sample shard checks.
   This was the remaining CLI verification gap at the checkpoint.
4. Add a Plan R5 appendix for the Stage 3 OPL merge, data layout,
   `tags-filter` correction, and JSONL spool (or a supersession note pointing
   to TODO/ZIEL).
5. Run update E2E with one real Geofabrik daily diff against the Japan index,
   then recheck using `verify-http.mjs`; also exercise first-build
   `update-indexes` and symlink swap.
6. Decide generation retention (e.g. keep last N) and the `objects/` policy
   (delete after build or document as baseline) before a planet run.
7. Optional: clean stale temp files and document Stage 3 RSS limit gap.
8. Then run public Overpass parity and TTL measurement (requires network or
   roughly one week of operation), and a planet run on a machine with at least
   approximately 200 GB free.

## 9. Environment at the interim review time

- Free disk: 127 GB on `/home`, 186 GB on `/ssdbuffer`; the earlier ~160 GB
  reduction was transient (planet PBF conversion running during measurement,
  later finished; no planet data remained).
- `/ssdbuffer/osm-amenity/planet/` contained only
  `japan-latest.osm.pbf` (2.55 GB) and its download log.
- Japan layout: `work/` 2.7 GB (chunks retained with `--keep-chunks`), data
  generation 307 MB (shards 62 MB + objects 246 MB), `verification/` ~1.1 MB.
- **Agent processes still running intentionally:** fixture server on port 18081
  (PID 206932) and Redis at 127.0.0.1:18079 (PID 208253). The reviewer's test
  processes (Japan server 18099 + updater child) were stopped after review.
- Review scratch artifacts were under `/tmp/op/` (logs, proxy smoke harness,
  and `tags-filter` XML files).

*Review ended October 15, 2026, approximately 14:25 CEST. The repository was
left untouched; only this report was added.*
