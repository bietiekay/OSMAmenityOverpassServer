# Easy setup: planet data with Docker Compose

This guide installs OSMAmenityOverpassServer on a Linux root server that already
has Docker and Docker Compose. Docker manages the running service; no systemd
unit, host Node.js installation, host osmium installation, or separate update
scheduler is needed.

The result serves worldwide `amenity=toilets` queries to your existing
Overpass-Proxy. This is a specialized amenity backend with a limited Overpass QL
subset. Unsupported requests return HTTP 501 and require another upstream if
you want the proxy to answer them.

**Current verification limit:** Japan extraction and HTTP behavior have been
tested in this repository. A complete planet import, planet replication
throughput, and this Docker deployment have not yet been verified. Treat the
first planet deployment as a commissioning run and keep your existing upstreams
available until the checks below pass.

## Interactive setup script (recommended)

After checking out this repository on the Docker host, run the wizard in Bash:

```bash
cd /opt/osm-amenity-server
bash scripts/easy-setup.sh
```

For a new checkout, first run
`git clone https://github.com/bietiekay/OSMAmenityOverpassServer.git /opt/osm-amenity-server`.
Use root or an account with Docker access and write permissions for your chosen
storage paths. The host needs Bash 4+, GNU coreutils, and Docker Compose; a
download also needs `curl`. No host Node.js, osmium, or systemd setup is needed.
Run the wizard on the host, outside a container, so bind-mount paths refer to the
correct filesystem. Use `tmux`/`screen` during a long download.

The wizard asks for:

- The application checkout, deployment configuration directory, pipeline storage,
  and retained source location. Paths must be absolute; spaces are supported.
- A new planet download URL and matching MD5 URL, or an existing immutable PBF.
- Compose project/service names, shared network, DNS alias, host IPv4 binding,
  and port.
- The existing proxy's location and service name, its reachable backend URL when
  remote, and optional fallback upstreams.
- Served amenity values, shard precision/cache, update/rebuild intervals, and
  logging verbosity.
- Initial extraction RAM/worker/chunk budgets, retention of intermediate amenity
  values and chunks, and source/chunk verification.

“Keep every amenity value” applies to temporary extraction data. **Yes** keeps
OSM objects with any `amenity=*` tag, which uses more disk and lets you build a
different served amenity set later without scanning the PBF again. **No** keeps
only the values selected for this setup (for example, `toilets`) and saves
space; serving a new value later requires rerunning extraction from the PBF.
Either choice serves only the amenity values configured for the active index
and server. It does not turn on every amenity automatically.

**Shard precision** controls how the geographic index is divided into cells;
it does not set shard file size in megabytes. A higher number creates smaller
geographic cells and more shard files, while a lower number creates fewer,
larger shards. Large shards can take longer to read and may exceed the build's
per-cell memory budget. The default is `5`; keep it unless you have a specific
reason to tune it. The server's configured precision must match the imported
index.

Approximate cell dimensions for the supported values (width × height at the
equator):

| Precision | Approximate cell dimensions |
|---:|---:|
| 3 | 156 × 156 km |
| 4 | 39 × 19.5 km |
| 5 | 4.9 × 4.9 km |
| 6 | 1.2 km × 610 m |
| 7 | 153 × 153 m |

At Germany's latitude, east-west width is about 60% of the equatorial value;
north-south height stays nearly the same. These are geographic cell dimensions,
not the size of the corresponding shard file.

For a query, the server finds the cells touched by its bounding box and loads
those shards. With higher precision, a small-area query usually reads less
unrelated nearby data, but may need to open more small shard files, especially
for larger query areas. With lower precision, it opens fewer shards, but each
can contain more unrelated nearby objects to inspect. Precision therefore
affects query work and storage layout, not the geographic accuracy of the
returned results. The default `5` balances these costs; changing it requires
rebuilding the index and matching the server setting.

For example, at precision `5`, a query around one neighborhood will usually
touch only a few cells of roughly 5 km across, while a country-wide query will
touch many. Increasing to precision `6` may reduce unrelated data for the
neighborhood query, but increases the number of separate shards loaded for a
country-wide query. Cell borders matter too: a small query can touch multiple
cells when it crosses a border.

### Storage and disk space

The three paths have different jobs:

- **Source directory** keeps the original planet `.osm.pbf` unchanged. The updater
  needs this baseline later, so do not delete or replace it. Allow at least the
  full downloaded file size, plus space for a partial download while one is in
  progress.
- **Pipeline directory** is the main data volume. It contains temporary PBF
  chunks, intermediate extraction and lookup files, the active shard index, and
  may retain old generations during rebuilds. The chunk set is roughly another
  source-sized copy; intermediate files and the index add more, and rebuilds
  can temporarily need space alongside the currently active generation.
- **Deployment directory** holds Compose and environment configuration and is
  small compared with the other two.

There is no measured full-planet disk requirement or total host RAM requirement
yet, so the wizard cannot promise a safe fixed amount of storage or memory.
However, a full-planet import has shown that **1024 MiB per extraction worker is
insufficient in practice**. Configure at least **2048 MiB per worker**; the
pipeline RAM budget must cover all workers plus a 512 MiB controller reserve.
Before starting, check free
space on the filesystems that contain both data paths (`df -h /srv`, replacing
`/srv` with the relevant mount point). Keep substantial headroom beyond the PBF
and chunk sizes; do not use the download size alone as your disk budget. The
wizard's RAM budget is for extraction workers and is not disk space or a total
container memory limit.

### What “proxy” means here

The **Overpass-Proxy** is the existing service your users or applications send
Overpass queries to. It chooses a backend and forwards the query. This setup
adds the Amenity Server as one backend; it does not install or replace the
proxy. The Amenity Server handles the supported amenity queries (such as
`amenity=toilets`). For unsupported query types it responds with HTTP 501, so
the proxy should have another Overpass upstream available as a fallback.

The wizard asks where that existing proxy runs so it can show the correct
backend URL: a shared Docker network for a proxy container on the same host, a
host address for a proxy process on that host, or a reachable URL for a remote
proxy. The generated proxy example is an integration hint; merge it into the
proxy's existing configuration and recreate that proxy yourself. The wizard
does not change the proxy deployment, DNS, TLS, or VPN routing.

It shows a review before writing files. It then offers image building, download
with checksum verification, source-header validation, detached import, startup,
HTTP checks, and a proxy integration example. The exact replication URL is read
from the PBF when available. For the official planet dump, it derives a safe
minute-feed start sequence with `pyosmium-get-changes`. Initial extraction
settings do not change the automatic weekly rebuild's resource defaults.

To generate configuration without downloading or using Docker:

```bash
bash scripts/easy-setup.sh --configure-only
```

The default generated deployment is `/srv/osm-amenity/deployment`. It contains
`docker-compose.yml`, `server.env`, saved wizard settings in `settings.tsv`, an
executable `compose.sh` wrapper, and `proxy.compose.example.yml`. The wrapper
selects `docker compose` or `docker-compose` automatically and always specifies
the saved Compose file and project, regardless of your current directory.
The script does not overwrite an existing deployment or adopt a pipeline that
already contains an import; use its original saved configuration to resume.
It also refuses to combine partial downloads with a different URL/checksum.

To resume after generating configuration or disconnecting during an import:

```bash
bash /opt/osm-amenity-server/scripts/easy-setup.sh \
  --resume /srv/osm-amenity/deployment
```

Substitute your selected deployment directory if different. Ctrl-C or TERM in
the Easy Setup wizard stops its own detached import container gracefully (up
to 120 seconds), then removes that stopped container. Completed pipeline work
is retained, so `--resume` starts a fresh container and reuses completed work.
A failed import must be resolved before startup. A successful import is not
launched again. If the source's `latest`
URL changes during an interrupted download, use a matching fixed dated URL or
move the old partial download aside before restarting that download.

When stage 0 has a complete manifest, the wizard shows its completion date and
the most recently completed work unit. The default resume choice trusts that
manifest and the per-chunk done markers, skips the full planet and output
hashes, and continues at the first incomplete stage or chunk. This is quickest
when the retained source and pipeline have not been changed. Choose **no** to
run the previous full verification, which rechecks the source, chunks, and
completed outputs and may take hours. If Stage 0 itself was interrupted, the
wizard offers the same choice when a partial manifest exists. Trust mode still
scans PBF block headers to reconstruct the chunk plan, then reuses completed
chunk markers without hashing their contents. Stages 1–3 skip completed
chunks and reuse completed intermediate results. Stage 4 reuses completed
amenity-chunk mappings and finished shards. If interrupted while building a
node or way lookup, that lookup is rebuilt; if interrupted while counting
unique objects, the counts are calculated again. The last unfinished mapping,
shard, or counting step is repeated.

For later operation, use the generated wrapper:

```bash
/srv/osm-amenity/deployment/compose.sh ps
/srv/osm-amenity/deployment/compose.sh logs --tail=100 -f amenity-server
/srv/osm-amenity/deployment/compose.sh stop amenity-server
/srv/osm-amenity/deployment/compose.sh up -d amenity-server
```

Use your selected service name in place of `amenity-server`. Merge the generated
proxy example into the existing proxy Compose file and recreate that proxy from
its own project directory. The wizard does not edit your proxy stack or create
public DNS/TLS/VPN routes. It leaves source snapshots and old generations intact;
monitor disk usage and apply the retention procedures below.

The following sections provide the equivalent manual installation and explain
commissioning and operation. Choose the wizard or the manual installation; do
not run both initial setup paths against the same pipeline.

## 1. Prepare the host and select your Compose command

Run the commands on the root server in Bash as `root` (or first run `sudo -i`).
The host needs `git`, `curl`, and the standard checksum tools. On Debian/Ubuntu,
install these if necessary:

```bash
apt-get update
apt-get install -y git curl ca-certificates coreutils
```

Select the installed Compose command. Run this block again whenever you open a
new SSH session, before using any `dc` commands in this guide:

```bash
set -euo pipefail
if docker compose version >/dev/null 2>&1; then
  dc() { docker compose "$@"; }
else
  dc() { docker-compose "$@"; }
fi
docker info >/dev/null
dc version
```

The commands support both `docker compose` and a `docker-compose` installation
that supports Compose file version 3.3 and `run --no-deps`. Upgrade Compose if it
rejects the file below.

Use local SSD/NVMe storage. Before downloading, check available RAM, disk space,
and inodes:

```bash
free -h
df -h /srv
df -i /srv
```

Plan space for the retained planet PBF, another approximately source-sized set
of PBF chunks, intermediate extraction files, source lookup indexes, the active
index, rebuild candidates, and old generations. Weekly rebuilds overlap with
the active index. **The PBF download size alone is not a disk-space budget.**
There is no measured planet RAM/disk requirement or import duration yet.

The import below requests an 8 GiB pipeline budget with up to three 2 GiB
workers. Do not lower the per-worker budget to 1024 MiB for a planet import; a
worker can exceed that limit and fail. Leave additional host RAM for Docker, the
OS, the proxy, and Redis.
Those extraction settings are not a total container memory limit, and do not
carry over to the automatic weekly rebuild, which uses pipeline defaults.
Monitor actual usage throughout commissioning.

## 2. Check out the application and create persistent directories

For a new checkout:

```bash
git clone https://github.com/bietiekay/OSMAmenityOverpassServer.git /opt/osm-amenity-server
cd /opt/osm-amenity-server
git rev-parse HEAD
install -d /srv/osm-amenity/sources /srv/osm-amenity/pipeline
```

If you already copied the repository to the server, use that checkout instead
and adjust `/opt/osm-amenity-server` in this guide. Deploy the revision containing
this guide and the current Dockerfile. Git credentials may be required for the
clone, depending on repository access.

Keep `/srv/osm-amenity/pipeline` on one local filesystem: publication uses
symlinks, hardlinks, atomic renames, and Linux `flock`. The whole pipeline must
be writable. The source directory is mounted read-only inside the containers.

## 3. Download the planet once and verify the download

Use the current-state PBF from the [official planet directory](https://planet.openstreetmap.org/pbf/),
not the full-history planet. These commands download to a temporary filename,
check the published MD5, and retain an immutable baseline:

```bash
cd /srv/osm-amenity/sources
test ! -e planet-initial.osm.pbf
curl --fail --location --retry 3 \
  --output planet-initial.md5 \
  https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf.md5
curl --fail --location --retry 3 --continue-at - \
  --output planet-initial.osm.pbf.part \
  https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf
EXPECTED_MD5=$(awk 'NR == 1 { print $1 }' planet-initial.md5)
printf '%s  %s\n' "$EXPECTED_MD5" planet-initial.osm.pbf.part | md5sum --check -
mv planet-initial.osm.pbf.part planet-initial.osm.pbf
chmod 0444 planet-initial.osm.pbf
sha256sum planet-initial.osm.pbf > planet-initial.sha256
cd /opt/osm-amenity-server
```

This may take hours. Keep the download shell open, or run it inside `tmux` or
`screen`. If interrupted, rerun the block to resume the `.part` file. If the
checksum fails, stop: `latest` may have changed during the download. Remove only
the incomplete `.part` file and retry, or select a fixed dated PBF and its
matching `.md5` from the directory. Do not import a failed checksum.

**Keep `planet-initial.osm.pbf` unchanged after importing it.** The updater still
needs unchanged OSM objects from that file; the initial index does not replace
it. Never download a newer planet over this path.

## 4. Create the Docker configuration and build the image

Create the container's environment file:

```bash
cat > /srv/osm-amenity/server.env <<'ENV'
PORT=8081
OSM_AMENITY_DATA_DIR=/osm/data
OSM_AMENITY_SOURCE_PBF=/source/planet-initial.osm.pbf
OSM_AMENITY_AMENITIES=toilets
OSM_AMENITY_SHARD_PRECISION=5
OSM_AMENITY_SHARD_CACHE_MB=256
OSM_AMENITY_UPDATE_INTERVAL_SECONDS=3600
OSM_AMENITY_GENERATIONS_TO_KEEP=2
OSM_AMENITY_REEXTRACT_EVERY_SECONDS=604800
LOG_VERBOSITY=info
ENV
```

Create a shared network once. It also lets a proxy in a separate Compose project
reach this backend on the same Docker host:

```bash
docker network inspect osm-overpass >/dev/null 2>&1 || docker network create osm-overpass
```

From `/opt/osm-amenity-server`, create `docker-compose.yml`:

```bash
cat > docker-compose.yml <<'YAML'
version: '3.3'
services:
  amenity-server:
    build: .
    restart: unless-stopped
    stop_grace_period: 30s
    env_file:
      - /srv/osm-amenity/server.env
    ports:
      - "127.0.0.1:8081:8081"
    volumes:
      - /srv/osm-amenity/pipeline:/osm:rw
      - /srv/osm-amenity/sources:/source:ro
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    networks:
      default: {}
      osm-overpass:
        aliases:
          - osm-amenity
networks:
  osm-overpass:
    external: true
YAML

dc config
dc build
```

The image includes Node.js 22, osmium, and PyOsmium's replication helper. Only port 8081 on the host's loopback
address is published. Requests from the proxy containers use the shared network.
The containers currently run as root, so the bind-mounted pipeline will contain
root-owned files.

## 5. Read the planet's replication metadata

Inspect the PBF header without scanning the whole file:

```bash
dc run --rm --no-deps -T amenity-server \
  osmium fileinfo --json /source/planet-initial.osm.pbf
```

The official `planet-latest.osm.pbf` can have a valid timestamp but no exact
replication sequence. The planet dump is not cut at a replication-diff
boundary, so that is expected. The setup script uses `pyosmium-get-changes` to
find a safe minute-feed start point from the PBF. It saves the cursor in
`replication.env`, puts the feed URL in `server.env`, then passes the cursor
through extraction into the active generation.

You can inspect the suggested start sequence manually with:

```bash
dc run --rm --no-deps -T amenity-server \
  pyosmium-get-changes -O /source/planet-initial.osm.pbf
```

The wizard does this automatically. Do not copy the suggested sequence into
`server.env` by hand: PyOsmium reports the first diff to apply, while this
server persists the last applied sequence. Do not infer the cursor from the
snapshot timestamp or substitute the latest sequence.

## 6. Import the planet in a background container

Do not start the HTTP service yet. Launch the complete stages 0–4 pipeline:

```bash
dc run -d --no-deps --name osm-amenity-import amenity-server \
  node scripts/extract.mjs \
  --source /source/planet-initial.osm.pbf \
  --data-dir /osm --stages 0-4 \
  --amenities toilets --shard-precision 5 \
  --chunk-mb 256 --ram-mb 8192 --worker-ram-mb 2048 --workers 3 \
  --all-amenity-values false --keep-chunks true --verify

docker logs --follow osm-amenity-import
```

Ctrl-C stops following the log; the detached import continues after you
disconnect SSH. In another session, monitor resources with:

```bash
docker stats osm-amenity-import
df -h /srv/osm-amenity
df -i /srv/osm-amenity
```

`--all-amenity-values false` retains only the configured amenity values during
the initial import. If you want more values, choose them **before importing**,
for example `toilets,drinking_water`, in both `server.env` and `--amenities`.
The server's amenity values and shard precision must match the imported index.
Keeping all values instead requires `--all-amenity-values true` and more working
storage; it does not automatically serve all values.

Wait for completion and inspect the exit code:

```bash
docker wait osm-amenity-import
docker inspect --format '{{.State.ExitCode}}' osm-amenity-import
```

**Both outputs must be `0`.** A successful `docker wait` command itself does not
mean the import succeeded: its printed number is the container's exit code.
`--verify` checks source/chunk object counts; it does not establish full public
Overpass parity.

If the import fails, inspect `docker logs osm-amenity-import` and
`docker inspect --format '{{.State.OOMKilled}}' osm-amenity-import`. Resolve the
cause first. Remove the stopped container with `docker rm osm-amenity-import`
and rerun the same import command to resume completed work. Keep the pipeline
and source file; do not run two imports or an import and updater concurrently.

After a successful import, inspect the published metadata:

```bash
readlink -f /srv/osm-amenity/pipeline/data
cat /srv/osm-amenity/pipeline/data/manifest.json
cat /srv/osm-amenity/pipeline/data/state.json
```

Expect an active generation with `manifest.json`, `state.json`, and `shards/`,
a nonempty shard inventory for planet toilets, and a positive planet/minute
replication cursor. `/osm` is the pipeline root; `/osm/data` is the published
generation used by the server.

## 7. Start the service and test it locally

```bash
cd /opt/osm-amenity-server
dc up -d amenity-server
dc ps
dc logs --tail=100 -f amenity-server
```

Docker's `restart: unless-stopped` restarts the service after failures and when
the Docker daemon returns after a host reboot, provided you did not explicitly
stop it. Ensure the Docker daemon itself starts at boot using your host's
existing Docker setup.

The server starts its own updater. In watch mode it collects small near-head
diffs for the configured update window (3600 seconds here). While a small
backlog is pending, it checks the feed every five minutes; when fully caught
up, it waits for the configured interval. A larger backlog starts immediately.
Set
`OSM_AMENITY_UPDATE_INTERVAL_SECONDS=7200` in the generated `server.env` for
roughly two-hour planet-minute batches. The setting bounds the wait since the
last successful publication; the update itself adds processing time. Do not
add a cron job or a second updater container. The first catch-up can take
substantial time and scan/hash the retained PBF to build source lookup indexes.

In another shell, run the included HTTP checks:

```bash
cd /opt/osm-amenity-server
dc exec -T amenity-server node scripts/verify-http.mjs --url http://127.0.0.1:8081
curl --fail http://127.0.0.1:8081/api/status
curl --fail http://127.0.0.1:8081/api/timestamp
curl --fail --get http://127.0.0.1:8081/api/interpreter \
  --data-urlencode 'data=[out:json][timeout:120];node["amenity"="toilets"](52.51,13.37,52.53,13.41);out body meta;'
```

Expect the verifier to report `"ok":true` and the supported query to return
HTTP 200 with Overpass JSON. Check that the timestamp is plausible and inspect
`localEngine.replication`, `localEngine.dataTimestamp`, and
`localEngine.lastUpdate` in status. A successful HEAD probe alone is not a
readiness test; it intentionally succeeds even without a usable index.

Check the updater logs for `applied planet/minute sequences ...` or
`up to date at ...`. The HTTP service can stay available while updates fail.
A planet baseline can already be several days old when downloaded; the first
catch-up may exceed the current batch limits (including 2 GiB of compressed
diffs, 50,000 affected objects, or 5,000 affected cells). Such a failure does not
advance the cursor. A shorter sleep interval only reduces future batch sizes;
it does not split an existing oversized backlog. See
[operations and current limits](docs/OPERATIONS.md#8-weekly-source-refresh-and-routine-monitoring).
If even the newest published planet cannot catch up within these limits,
planet replication needs implementation work before this deployment can be
considered current. Do not bypass the limits by editing `state.json`.

## 8. Connect your existing Overpass-Proxy

### Proxy in Docker on the same root server

In the proxy's existing Compose file, add the shared network to its `proxy`
service. Keep its existing settings, Redis service, volumes, and default
network. The relevant additions look like this:

```yaml
services:
  proxy:
    # Keep existing build/image, ports, depends_on, and other environment values.
    environment:
      UPSTREAM_URLS: "http://osm-amenity:8081/api/interpreter,https://overpass-api.de/api/interpreter"
    networks:
      - default
      - osm-overpass
networks:
  osm-overpass:
    external: true
```

If the proxy is in a separate Compose project, also add `osm-overpass` to its
`proxy` service's network list, alongside `default` as shown above.

Merge these keys into the existing file; do not replace the whole proxy stack
with this fragment. Recreate the proxy **from its own Compose directory**:

```bash
cd /path/to/your/Overpass-Proxy
dc config
dc up -d proxy
dc exec -T proxy node --input-type=module -e '
const r = await fetch("http://osm-amenity:8081/api/status");
if (!r.ok) throw new Error("Backend status: HTTP " + r.status);
console.log(await r.text());
'
```

Use `up -d`, not just `restart`, when changing Compose configuration. The proxy
container must resolve `osm-amenity` and reach port 8081. `127.0.0.1` inside that
container refers to the proxy container itself.

The proxy maintains an upstream pool with latency, affinity, and backoff;
listing this backend first does **not** guarantee strict local-first routing.
For a deliberate test of supported toilets queries, temporarily configure only
`http://osm-amenity:8081/api/interpreter`, recreate the proxy, and send a request
for an uncached area. Confirm activity in the backend's query statistics/logs,
then restore the fallback URL and recreate the proxy again. Existing cached
responses may hide upstream traffic. Do not clear production Redis to test it.

Also test a query outside this backend's scope with the fallback restored.
The backend returns 501; verify that your deployed proxy retries another
upstream and that its HEAD recovery probe succeeds. Use the proxy's existing
public endpoint and client authentication header, if configured.

### Proxy running directly on the same host

Use the following backend URL in its `UPSTREAM_URLS` setting:

```text
http://127.0.0.1:8081/api/interpreter
```

Add your existing fallback upstreams and restart/recreate the proxy with its
normal deployment method.

### Proxy on another machine

The loopback binding and Docker network above are local to this host. Prefer
connecting the hosts over your existing VPN/private network, and bind port 8081
to this server's VPN address instead of `127.0.0.1`. Allow access only from the
proxy, then use that reachable address in `UPSTREAM_URLS`.

For a public HTTPS hostname, put your existing TLS reverse proxy in front of
`127.0.0.1:8081` (host reverse proxy), or join its container to `osm-overpass` and
forward to `osm-amenity:8081`. Preserve `/api/*`, methods, query strings, form
bodies, ETags, HEAD responses, and HTTP 501. Restrict backend access to your
proxy's source addresses. Configure this route with the same TLS deployment
you already use for the public proxy.

Do not change the binding to `0.0.0.0:8081:8081` just to reach a local container.
The application has no built-in TLS or authentication, and Docker-published
ports can bypass UFW rules. See Docker's
[port publishing](https://docs.docker.com/engine/network/port-publishing/) and
[firewall documentation](https://docs.docker.com/engine/network/packet-filtering-firewalls/#docker-and-ufw).

## 9. Daily operation, newer snapshots, and backups

Run service commands from `/opt/osm-amenity-server`:

```bash
dc ps
dc logs --tail=200 amenity-server
dc stop amenity-server
dc up -d amenity-server
```

Monitor free disk space/inodes, container memory, update errors, and the data
timestamp. The updater retains at least two published generations by default,
including the active one. Older published generations are removed after a
one-hour grace period during successful updater cleanup. Set
`OSM_AMENITY_GENERATIONS_TO_KEEP` higher to retain more rollback points.
Keep backups separately; retention does not protect them.
The geometry member-object cache currently has no aggregate memory cap, and
updates validate/recount the full shard inventory. Japan results do not
establish planet memory bounds or sustained update throughput.

Weekly re-extraction is automatic, but downloading a newer PBF is not. The
first scheduled check initializes the weekly timer rather than immediately
rebuilding. To supply a newer baseline later:

1. Download it to a **new filename** in `/srv/osm-amenity/sources`, verify its
   checksum and planet/minute header as above, and keep the file immutable.
2. Add, for example,
   `OSM_AMENITY_REEXTRACT_SOURCE_PBF=/source/planet-new-YYYY-MM-DD.osm.pbf`
   to `/srv/osm-amenity/server.env`, using the real new filename.
3. Run `dc up -d --force-recreate amenity-server`. This loads the new environment;
   it does not force an immediate rebuild.
4. Watch for `weekly re-extract activated sequence ...` when the rebuild is due.
   The candidate is built and caught up before publication. Continue retaining
   the original baseline and any snapshot required by active/backup generations.

To update the application, deploy the desired Git revision, run `dc build`, then
`dc up -d amenity-server`. Keep your local Compose file and environment file.
Do not rerun the initial extraction against an already updated active pipeline.

For a consistent backup, stop the service and archive the entire pipeline,
retained source PBFs, `/srv/osm-amenity/server.env`, your Compose file, and the
application Git revision. Preserve symlinks and hardlinks, verify restoration,
then start the service again. The updater manages old published generations;
manual removal should be done only during a maintenance stop after checking
the active `data` symlink and backup/rollback requirements. Never remove the
active generation or a PBF it needs.

For detailed backup, rollback, and troubleshooting procedures, see
[OPERATIONS.md](docs/OPERATIONS.md). For supported query syntax, see
[specification.md](specification.md).
