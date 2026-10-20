# Installation, commissioning, and operations

This guide covers a native Linux installation, followed by optional Docker
packaging. Japan is the verified dataset. Use the same extraction pipeline for
a planet PBF, with a matching planet/minute feed and sufficient disk capacity;
planet throughput and Docker deployment have not been verified here.

For the implementation contract see [the specification](../specification.md).
For measured results and outstanding external checks see
[the acceptance report](../plans/2026-10-15-abnahme.md).

## 1. Prerequisites and filesystem layout

Use Linux with Node.js 22 and npm. The local acceptance used Node 22.23.3 and
osmium-tool 1.14.0. Install the native dependencies on Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install osmium-tool coreutils gawk util-linux ca-certificates curl git python3
node --version
npm --version
osmium --version
command -v sort awk flock
```

Node.js and npm must already be installed using your host's Node 22 installation
method. Redis is not required by this server; the separate Overpass-Proxy may
use Redis. Direct Redis invalidation by this server is reserved, not implemented.

The examples use these paths:

| Path | Purpose | Write access |
|---|---|---|
| `/opt/osm-amenity-server` | Repository, dependencies, compiled server | Deployment administrator |
| `/srv/osm-sources` | Immutable retained PBF snapshots | Download administrator; service reads |
| `/var/lib/osm-amenity/japan` | Pipeline root: generations, work, update caches | Service account |
| `/var/lib/osm-amenity/japan/data` | Symlink to the active immutable generation | Managed by the pipeline |
| `/etc/osm-amenity-server.env` | Server and updater configuration | Deployment administrator |

Extraction `--data-dir` means the **pipeline root**. Server
`OSM_AMENITY_DATA_DIR` means its **active `data/` generation**. Keep work and
generations on the same local filesystem for atomic publication and hardlinks.
Generation locking requires working Linux `flock` semantics. Leave disk space
for retained sources, extraction work, update indexes, candidates, and old
generations. There is no automatic generation garbage collector.

The successful Japan resume used a 2.55 GB source, about 4.32 GB of sampled
pipeline storage, and 1,096.40 MiB peak process-tree RSS. These are measurements
for the recorded run, not installation sizing guarantees. Reserve additional
space and RAM for the OS, HTTP server, concurrent rebuilding, and backups.

## 2. Install the application and service account

Check out this repository into `/opt/osm-amenity-server`, or substitute your
existing absolute checkout path throughout the examples. Then:

```bash
cd /opt/osm-amenity-server
npm ci
npm run build
npm run verify
npm run test:ci
```

Create the account once; skip `useradd` if it already exists:

```bash
sudo useradd --system --user-group --home-dir /var/lib/osm-amenity --shell /usr/sbin/nologin osm-amenity
sudo install -d -o osm-amenity -g osm-amenity /var/lib/osm-amenity/japan
sudo install -d -m 0755 /srv/osm-sources
```

The account needs read/execute access to the checkout and native executables.
It needs write access to the entire pipeline root, not just `data/shards`.

## 3. Obtain and inspect a source snapshot

For a new Japan download, use a new filename and keep it unchanged after
indexing. Download to a temporary file before exposing the completed snapshot:

```bash
SNAPSHOT=/srv/osm-sources/japan-$(date -u +%Y-%m-%d).osm.pbf
sudo curl --fail --location --retry 3 \
  --output "${SNAPSHOT}.part" \
  https://download.geofabrik.de/asia/japan-latest.osm.pbf
sudo mv --no-clobber "${SNAPSHOT}.part" "$SNAPSHOT"
sudo chmod 0644 "$SNAPSHOT"
osmium fileinfo --json "$SNAPSHOT"
sha256sum "$SNAPSHOT"
```

Choose another filename if the dated destination already exists; do not overwrite
the baseline used by a live generation. The filename's date is the download
date; the PBF header supplies the actual data timestamp. Record the hash and
header options `osmosis_replication_base_url`,
`osmosis_replication_sequence_number`, and `osmosis_replication_timestamp`.

The retained PBF is required after extraction: updates resolve unchanged member
objects from it. A snapshot with missing timestamp or replication provenance
can produce an initial index, but cannot establish a safe automatic update or
weekly-rebuild baseline. Do not invent a cursor or replace missing provenance
with file mtime/current time.

For the verified October 2026 Japan snapshot the feed is
`https://download.geofabrik.de/asia/japan-updates`, kind `regional`, cadence
`day`, sequence 4939. Later downloads have different counts and cursors.

## 4. Build the initial index

From the repository root, with `SNAPSHOT` still set:

```bash
sudo -u osm-amenity node /opt/osm-amenity-server/scripts/extract.mjs \
  --source "$SNAPSHOT" \
  --data-dir /var/lib/osm-amenity/japan \
  --stages 0-4 \
  --amenities toilets --shard-precision 5 \
  --chunk-mb 256 --ram-mb 8192 --worker-ram-mb 2048 --workers 3 \
  --all-amenity-values true --keep-chunks true --verify
```

Stage 0 copies complete PBF blocks into self-contained chunks. Stage 1 streams
amenity records. Stage 2 resolves referenced ways across chunks. Stage 3 uses
a sorted streaming merge to resolve nodes without a high-ID bitmap. Stage 4
assembles shards using disk-backed lookups, validates the candidate, and
atomically switches `data/` under the generation lock.

The CLI defaults to **stage 0 only**; specify `--stages 0-4` for a full build.
The default chunk size is 1024 MB; this example deliberately uses 256 MB.
Worker concurrency is capped by CPU count and the RAM budget with a 512 MB
controller reserve. Linux process-tree RSS monitoring includes native tools.
These controls are not a host-wide cgroup memory limit.

`--verify` independently compares source and chunk node/way/relation counts.
It keeps chunks available for that check even when `--keep-chunks false` is
supplied. It does **not** prove complete semantic parity with public Overpass.

Inspect publication:

```bash
readlink -f /var/lib/osm-amenity/japan/data
python3 -m json.tool /var/lib/osm-amenity/japan/data/manifest.json
python3 -m json.tool /var/lib/osm-amenity/japan/data/state.json
```

`manifest.counts` distinguishes unique main objects, helper objects, duplicate
spatial records, and total shard records. `manifest.shards` is authoritative.
For the exact accepted snapshot, main objects total 32,293 in 6,720 shards.

### Resume and additional amenity values

After SIGINT/SIGTERM, Easy Setup asks how to resume when stage 0 is complete;
it defaults to trusting manifests and per-unit done markers, skipping completed
stages/chunks and continuing with unfinished work. Choosing verification runs
the full source, chunk, and output hash checks. For direct CLI use, trust mode
must be selected explicitly. If stage 0 is complete, skip it; if stage 0 is
partial, include it to rescan PBF block headers while reusing completed chunks:

```bash
node scripts/extract.mjs --source /source/planet.osm.pbf --data-dir /osm \
  --stages 1-4 --resume-mode trust
```

For an interrupted stage 0, use `--stages 0-4 --resume-mode trust`.

The CLI defaults to verify mode. If stage 0 was interrupted or its source or
chunk settings changed, rerun it with `--stages 0-4 --resume-mode verify`. If
chunks were deleted after stage 3, rerun stage 0 as part of the full command to
recreate them. Stage 4 alone can
reuse valid stages 1–3 without chunks:

```bash
sudo -u osm-amenity node /opt/osm-amenity-server/scripts/extract.mjs \
  --data-dir /var/lib/osm-amenity/japan --stages 4 \
  --amenities toilets,drinking_water --shard-precision 5
```

That requires stage 1 to have retained those values, for example through
`--all-amenity-values true`. Stop the service before deliberately changing
the served amenity set or precision, and update its environment to match.

In trust mode, Stage 4 saves progress per amenity input chunk and per output
shard. A restart reuses completed mappings and shards and repeats the first
unfinished unit. An interrupted node or way lookup build is rebuilt as a
whole; the final unique-object counting step also runs again if it had not
finished.
Direct stage activation rejects a snapshot older than an updated active
generation. For a production configuration change after updates, build a
separate pipeline from a suitable current source, validate it and its cursor,
then switch the service to it; do not bypass the cursor guard.

## 5. Configure Japan replication and start in the foreground

Copy [the environment example](../deploy/osm-amenity-server.env.example) to
`/etc/osm-amenity-server.env` and replace the source filename with `SNAPSHOT`:

```bash
sudo install -m 0644 deploy/osm-amenity-server.env.example /etc/osm-amenity-server.env
sudoedit /etc/osm-amenity-server.env
```

For a foreground commissioning run, export the same values in the shell:

```bash
export PORT=8081
export OSM_AMENITY_DATA_DIR=/var/lib/osm-amenity/japan/data
export OSM_AMENITY_SOURCE_PBF="$SNAPSHOT"
export OSM_AMENITY_AMENITIES=toilets
export OSM_AMENITY_SHARD_PRECISION=5
export OSM_AMENITY_UPDATE_BASE_URL=https://download.geofabrik.de/asia/japan-updates
node /opt/osm-amenity-server/dist/index.js
```

Run as the service account or another account with the pipeline permissions.
The application listens on `0.0.0.0`; use your host firewall/private network or
reverse proxy to control exposure. There is no built-in authentication or TLS.

The HTTP server starts an updater subprocess automatically after listening.
There is no configuration switch to disable this worker. It catches up at
startup, then wakes every 3600 seconds by default, and checks the weekly rebuild
schedule after each update cycle. HTTP service can remain available while an
update fails, so an open port is not evidence of current data.

The configured replication **base URL must match the persisted descriptor** in
`state.json`, including a `/minute` suffix if the source recorded it. The
regional/day mode is inferred from a Geofabrik hostname; other configured hosts
default to planet/minute. Arbitrary regional mirror hosts and hour feeds have
no explicit mode override. Do not use global diffs for a Japan-only index.
Regional sequence numbers are not converted to global minute numbers.

## 6. Commission the HTTP and proxy contracts

In another shell:

```bash
curl --fail http://127.0.0.1:8081/api/status
curl --fail http://127.0.0.1:8081/api/timestamp
curl --head --fail http://127.0.0.1:8081/api/interpreter
curl --fail --get http://127.0.0.1:8081/api/interpreter \
  --data-urlencode 'data=[out:json][timeout:120];node["amenity"="toilets"](35.678,139.763,35.684,139.771);out body meta;'
node scripts/verify-http.mjs --url http://127.0.0.1:8081
```

The HTTP verifier tests GET/POST, JSON/XML, ETag, 400/501, status, HEAD, and the
kill-query no-op. An optional `--expected-nodes /path/to/reference.json` checks
known node fields. The acceptance machine's reference files under
`/home/osm-amenity/japan/verification/` are **not shipped with the repository**.
Do not expect a fixed Tokyo result count from a newer snapshot.

Readiness requires a successful in-scope query and valid generation metadata.
HEAD intentionally returns 200 for recovery probing even without a ready index;
an interpreter request with missing/corrupt data returns 500. A blank query
returns 400; unsupported QL returns 501.

Set the unmodified Overpass-Proxy's `UPSTREAM_URLS` to your local interpreter
followed by its remote fallback interpreter(s), as a comma-separated list:

```text
http://127.0.0.1:8081/api/interpreter,https://overpass-api.de/api/interpreter
```

Use the actual reachable service hostname across hosts/containers; `127.0.0.1`
refers to the proxy's own network namespace. Exercise a supported tile query,
an unsupported query that falls back after 501, and a successful HEAD recovery
probe. Configure the proxy's Redis independently. This server does not directly
purge proxy Redis keys.

## 7. Install the systemd service

Stop the foreground server with Ctrl-C first. Check that the unit's Node path
matches `command -v node`; a per-user version manager path may not be accessible
to the service account. The supplied unit assumes `/usr/bin/node`.

```bash
sudo install -m 0644 deploy/osm-amenity-server.service /etc/systemd/system/osm-amenity-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now osm-amenity-server
sudo systemctl status osm-amenity-server
sudo journalctl -u osm-amenity-server -f
```

The unit starts the compiled server, which owns the updater; do not install a
second update timer. SIGTERM closes Fastify and stops the worker, with escalation
after a five-second grace period. systemd also terminates the service control
group. Environment-file changes take effect after `systemctl restart`.

To run a manual one-shot catch-up, stop the service first and run with the same
configuration as the service account:

```bash
sudo systemctl stop osm-amenity-server
sudo -u osm-amenity sh -c '
  set -a
  . /etc/osm-amenity-server.env
  set +a
  cd /opt/osm-amenity-server
  exec /usr/bin/node scripts/update.mjs --data-dir /var/lib/osm-amenity/japan
'
sudo systemctl start osm-amenity-server
```

The example environment file uses assignments compatible with both systemd and
POSIX shell sourcing. If catch-up fails, inspect the error before restarting;
do not edit a cursor to skip the missing sequence.

## 8. Weekly source refresh and routine monitoring

The first scheduled check establishes a persistent weekly timer baseline when
no successful rebuild time exists. Subsequent checks use 604800 seconds by
default. The server does **not** download a newer source PBF itself. Download
and inspect a new, separate immutable file as in step 3, set
`OSM_AMENITY_REEXTRACT_SOURCE_PBF` to that path in the service environment, and
restart. This selects the source for the next due rebuild; restart alone does
not force an immediate rebuild.

A candidate must carry a valid source timestamp and positive cursor in the
same namespace. It is built separately, caught up to the latest/active cursor,
then activated under the shared lock. Updates resume using the new generation's
matching retained source, even if the original configured source still names
the older PBF. Keep both snapshots until backup/rollback retention allows their
removal. Never overwrite the active baseline in place.

Monitor these together:

- `localEngine.dataTimestamp`, `localEngine.replication.sequenceNumber`, and
  `localEngine.lastUpdate` in `/api/status`; compare with the matching feed's
  `state.txt`, not wall-clock assumptions about a daily feed.
- Journal messages for catch-up, successful weekly activation, and errors.
- Free space and inode availability in the pipeline/source filesystems.
- HTTP error rate, process RSS, extraction/rebuild duration, and proxy fallback.

During a catch-up, look for `update progress:` heartbeat entries about every 30
seconds. They report the current phase, phase throughput, and ETA when the phase
has a known total. The updater processes contiguous diffs as one atomic batch,
so `/api/status` keeps the old cursor until validation and publication finish.
Before applying a batch, it now reads every diff in sequence order and coalesces
repeated changes for each typed OSM ID to the final event in that batch. A
sequence ending in a deletion remains a deletion. This avoids doing baseline
lookups and geometry work repeatedly for intermediate versions; it does not
skip any replication diff or sequence. The coalescing stage writes a TSV spool
and externally sorts it with GNU `sort` (configured for 32 MiB sort memory),
then streams the final per-object events into the update. Temporary spool data
is capped at 128 GiB in `work/update-diffs`; the sort also needs room for its
sorted output and temporary files, so check free space before a large catch-up.
The cap is a safety limit, not a disk-space reservation. Coalescing may reduce
later work substantially when many diffs touch the same objects, but reading,
sorting, and reducing a planet backlog still costs time and disk I/O. It does
not establish that the updater will catch up with a live planet feed.
Set `OSM_AMENITY_UPDATE_WORKERS` in `server.env` to select 1–16 concurrent
update tasks (default 1). The updater distributes baseline PBF lookups and
geometry builds after coalescing, resolves each task's dependencies against the
same final object overlay, and merges results in stable ID order. A coordinator
writes each affected shard once before validation and atomic publication. This
setting is independent of extraction `--workers`. Higher values increase
simultaneous `osmium cat` processes, temporary candidate PBFs, RAM use, and
disk traffic. Start with 2–3 only if resources permit, then measure completed
batch throughput and backlog reduction. Changing `server.env` takes effect
when the updater process is restarted.
The large coalesced-object import groups changes by delta partition and writes
each partition once, with distinct partitions processed concurrently. A bounded
filter built from the tracked-object indexes avoids reading both indexes for
every untracked object. All changed objects remain in the delta overlay so
later references and update cycles can resolve their latest versions. The
partitioning and grouped-write phases report continuous object counts and ETAs.
The temporary grouped spool is limited to 128 GiB and needs additional space
for its sorted output; check the pipeline filesystem before a large catch-up.
After a batch publishes, `update catch-up assessment:` reports its end-to-end
rate, how far the feed advanced during the run, and whether the remaining
backlog shrank or grew. For a planet/minute feed, the backlog must shrink over
successive runs; if it grows, processing is slower than the feed. Individual
phase ETAs do not include later phases such as recount, validation, and disk
sync. When the assessment finds remaining diffs, the updater now starts another
catch-up cycle immediately instead of waiting an hour. If the backlog still
grows across cycles, a newer correctly timestamped and replication-seeded
baseline is needed; adding extraction workers will not make the updater catch
up.

For Japan, `osm_osm_change: "0"` is intentional; use the regional cursor in
`localEngine.replication`. Unknown metadata is omitted rather than fabricated.
The first update may scan/hash the full retained PBF to construct source lookup
indexes. Unchanged file identities reuse attestations on later cycles.

Update limits currently include 100,000 missing diffs, 2 GiB compressed catch-up
data per batch, 512 MiB per downloaded/decompressed diff, 50,000 tracked affected
objects, 128 MiB of possibly affected object records, 5,000 affected cells,
64 MiB rebuilt rows, and a 64 MiB resolved-object
limit per lookup invocation. The geometry rebuild's shared member-object cache
has no aggregate byte cap; these limits are not a total update-process memory
guarantee. A single source-block lookup must also fit its budget. Checked limits
fail closed.
Large routine batches may require a shorter wake interval; an already large
backlog needs a newer baseline rather than merely changing the wake interval.
Each commit still clones, verifies, recounts, and syncs the whole generation
tree. See the specification for these planet-scale cost limits.

## 9. Backup, restore, rollback, and retention

Stop the service to obtain a consistent offline backup of the complete pipeline
root, its retained source files, the environment file, and the application
revision. Preserve relative symlinks and hardlinks. For example, with an existing
backup directory on another filesystem:

```bash
sudo systemctl stop osm-amenity-server
sudo tar -cpf /backup/osm-amenity-japan.tar -C /var/lib/osm-amenity japan
sudo cp /etc/osm-amenity-server.env /backup/osm-amenity-server.env
git -C /opt/osm-amenity-server rev-parse HEAD | sudo tee /backup/osm-amenity-revision.txt
```

Back up the immutable PBFs separately and record their SHA256 hashes. Verify the
archive and restore on a separate path before relying on the backup. Restore
while stopped, with the recorded application revision and correct ownership;
make the matching PBF readable at its recorded path or through a validated
source override. Keep shard files, manifest, state, and delta objects from the
same generation. Caches may be rebuilt but can incur full-source scans.

For an intentional rollback to a retained, verified generation, stop the service
and activate it through the existing validator/lock, from the repository root:

```bash
sudo -u osm-amenity node --input-type=module - \
  /var/lib/osm-amenity/japan \
  /var/lib/osm-amenity/japan/data-generations/YOUR_VERIFIED_GENERATION <<'JS'
import { activateGeneration } from './scripts/update/generation.mjs';
await activateGeneration(process.argv[2], process.argv[3]);
JS
```

Match the service's amenity set/precision to that generation and retain its
source PBF. Restarting automatically attempts catch-up again. If investigating
an updater defect, keep the service stopped until the application problem is
resolved. Do not repair individual active files or hand-adjust sequence numbers.

Remove old generations only during a maintenance stop after checking the active
symlink, backup retention, and rollback needs. Queries pin generation paths;
deleting an old directory while requests still use it can break those requests.
There is no provided online garbage collector. Never delete the active generation
or its source snapshot.

## 10. Troubleshooting

| Symptom | Check/action |
|---|---|
| Interpreter 500, HEAD 200 | Inspect manifest/state/shard inventory, permissions, CRC/config errors in logs; HEAD is a recovery probe, not data readiness. |
| Configuration hash mismatch | Use the same amenity values and precision for server and build; rebuild a separate pipeline for changes after updates. |
| Namespace mismatch or unknown baseline | Compare config with source and active replication descriptor; use a correctly seeded snapshot, never cursor 0 or manual sequence edits. |
| PBF fingerprint mismatch | Restore the exact baseline bytes or supply a matching mounted copy. New snapshots belong in the re-extract path. |
| Missing update/member reference, corrupt gzip, 404 | Keep the active generation; fix the feed/source problem and retry. Do not skip the diff. |
| Generation transaction already active | Let the other writer finish or stop it cleanly. `flock` releases after process death; the persistent lock filename is not evidence of a stale lock. |
| `flock` not found | Install `util-linux` and ensure its executable is in the service PATH. |
| Worker memory/batch limit | Read the specific bound; reduce extraction concurrency or use appropriate RAM/chunks; use a newer baseline for oversized catch-up. |
| Weekly rebuild has not run | Check persisted schedule/`lastReextractAt`, configured interval, source metadata, logs, and available disk. |
| Public parity fails | Compare source timestamps first; the reference endpoint may be unavailable. No general parity is promised for nested relations or missing metadata. |

## 11. Optional Docker deployment

This packaging path was not executed during local acceptance. On a Docker host,
copy the template and set its required host paths:

```bash
cp docker-compose.yml.template docker-compose.yml
export OSM_AMENITY_PIPELINE_DIR=/absolute/path/to/pipeline
export OSM_AMENITY_SOURCE_PBF_HOST=/absolute/path/to/retained-japan.osm.pbf
```

Uncomment/set the Japan `OSM_AMENITY_UPDATE_BASE_URL` in the compose file before
starting it. Build and, if the pipeline is not already populated, extract using
the image's native tools:

```bash
docker compose build
docker compose run --rm --no-deps amenity-server \
  node scripts/extract.mjs --source /source/region.osm.pbf --data-dir /osm \
  --stages 0-4 --amenities toilets --shard-precision 5 \
  --chunk-mb 256 --ram-mb 8192 --worker-ram-mb 2048 --workers 3 --verify
docker compose up -d
docker compose logs -f amenity-server
```

The writable `/osm` mount must contain the whole pipeline. Mounting only
`/osm/data` would prevent sibling generation/work publication. The retained
source bind mount is read-only. A host-built pipeline can be reused when its
config, provenance, and matching PBF are intact; the mounted PBF path is attested
against the stored fingerprint. For newer snapshots, add a separate read-only
mount and set `OSM_AMENITY_REEXTRACT_SOURCE_PBF` to its container path. Do not
replace the old source mount until it is no longer needed for active updates.

Within the compose network, point the proxy at
`http://amenity-server:8081/api/interpreter`. The host port in the template is
bound to loopback. Apply the same commissioning, monitoring, backup, and
retention checks as for the native service.

## 12. Before a planet production rollout

Use a planet PBF with a usable planet/minute header and retain it unchanged.
Set the exact persisted feed URL in the environment; use the same stages 0–4
and server APIs. Measure full-source disk/RAM/time, first-update lookup-index
cost, hourly update throughput, weekly candidate overlap, and backup/retention
capacity on the production hardware. Japan measurements do not establish these.
Add an aggregate bound for the shared update geometry cache before relying on
the lookup limits as a planet update-memory guarantee. Do not increase budgets
merely to hide unbounded data structures or claim
general Overpass support: nested relations, synthetic-member metadata, and
public parity retain the limitations recorded in the acceptance report.
