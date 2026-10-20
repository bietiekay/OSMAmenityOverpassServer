#!/usr/bin/env bash
# Interactive Docker Compose deployment. Requires Bash 4+ and GNU coreutils.
set -euo pipefail

fail() { printf '\nError: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash scripts/easy-setup.sh [--configure-only]
       bash scripts/easy-setup.sh --resume /absolute/deployment-directory

Asks for paths, names, source location, proxy connectivity, and resource settings.
Writes a dedicated Compose deployment without changing an existing proxy stack.
--configure-only  Generate and review configuration without Docker or downloading.
--resume DIR      Continue a generated deployment, including a detached import.
--help            Show this help.
HELP
}
ask() {
  local _ask_name=$1 _ask_label=$2 _ask_default=$3 _ask_input
  printf '%s [%s]: ' "$_ask_label" "$_ask_default" >&2
  IFS= read -r _ask_input || fail 'Input ended. No further setup steps were run.'
  printf -v "$_ask_name" '%s' "${_ask_input:-$_ask_default}"
}
confirm() {
  local reply
  while true; do
    ask reply "$1 (yes/no)" "${2:-yes}"
    case "$reply" in yes|y|Y) return 0 ;; no|n|N) return 1 ;; esac
    printf 'Please enter yes or no.\n' >&2
  done
}
path_ok() { [[ $1 == /* && $1 != *[!a-zA-Z0-9/._\ -]* ]]; }
name_ok() { [[ $1 =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; }
positive() { [[ $1 =~ ^[1-9][0-9]{0,8}$ ]]; }
url_ok() { [[ $1 =~ ^https?://[a-zA-Z0-9][a-zA-Z0-9./_:%?=+\&~-]*$ ]]; }
ask_path() {
  local variable=$1 label=$2 default=$3 value
  while true; do
    ask value "$label (absolute; spaces allowed)" "$default"
    if path_ok "$value"; then
      printf -v "$variable" '%s' "$(realpath -m -- "$value")"
      return
    fi
    printf 'Use an absolute path containing letters, digits, spaces, / . _ or -.\n' >&2
  done
}
ask_name() {
  local variable=$1 label=$2 default=$3 value
  while true; do
    ask value "$label" "$default"
    if name_ok "$value"; then printf -v "$variable" '%s' "$value"; return; fi
    printf 'Use 1-63 lowercase letters/digits, underscores or hyphens; start with a letter/digit.\n' >&2
  done
}
ask_int() {
  local variable=$1 label=$2 default=$3 minimum=$4 maximum=$5 value
  while true; do
    ask value "$label" "$default"
    if positive "$value" && (( value >= minimum && value <= maximum )); then
      printf -v "$variable" '%s' "$value"; return
    fi
    printf 'Enter an integer from %s to %s.\n' "$minimum" "$maximum" >&2
  done
}
ask_url() {
  local variable=$1 label=$2 default=$3 value
  while true; do
    ask value "$label" "$default"
    if url_ok "$value"; then printf -v "$variable" '%s' "$value"; return; fi
    printf 'Use an http:// or https:// URL without spaces, quotes or shell substitutions.\n' >&2
  done
}
ipv4_ok() {
  local a b c d part
  [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r a b c d <<< "$1"
  for part in "$a" "$b" "$c" "$d"; do
    [[ ${#part} -le 3 && ( $part == 0 || $part != 0* ) ]] || return 1
    (( 10#$part <= 255 )) || return 1
  done
}
contains_path() { [[ $2 == "$1" || $2 == "$1/"* || $1 == / ]]; }
configure_only=false
resume=false
deployment=''
while (( $# )); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --configure-only) configure_only=true; shift ;;
    --resume)
      (( $# >= 2 )) || fail '--resume requires an absolute deployment directory.'
      deployment=$2; resume=true; shift 2 ;;
    *) fail "Unknown argument: $1 (use --help)." ;;
  esac
done
[[ $configure_only == false || $resume == false ]] || fail 'Choose --configure-only or --resume.'
command -v realpath >/dev/null || fail 'GNU coreutils (realpath) is required.'
repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)

# Store plain tab-separated values, never executable shell configuration.
keys=(repository deployment pipeline sources source_file source_mode source_url checksum_url
  project service network dns_name host_ip host_port proxy_mode proxy_service proxy_url fallbacks
  amenities precision cache_mb update_seconds rebuild_seconds log_level chunk_mb ram_mb worker_mb
  workers update_workers all_values keep_chunks verify)
validate_settings() {
  local key value other
  for key in repository deployment pipeline sources; do
    value=${!key}; path_ok "$value" || fail "Invalid path in $key."
    [[ $value != / ]] || fail "$key cannot be the filesystem root."
  done
  for key in project service network dns_name proxy_service; do
    name_ok "${!key}" || fail "Invalid name in $key."
  done
  [[ $source_file =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*\.osm\.pbf$ ]] || fail 'Use a plain filename ending in .osm.pbf.'
  [[ $source_mode == download || $source_mode == existing ]] || fail 'Invalid source mode.'
  url_ok "$source_url" && url_ok "$checksum_url" || fail 'Invalid source/checksum URL.'
  [[ $proxy_mode == docker || $proxy_mode == host || $proxy_mode == remote ]] || fail 'Invalid proxy mode.'
  url_ok "$proxy_url" || fail 'Invalid proxy-facing URL.'
  IFS=, read -r -a urls <<< "$fallbacks"
  for value in "${urls[@]}"; do url_ok "$value" || fail 'Invalid fallback URL.'; done
  [[ $amenities =~ ^[a-z0-9_]+(,[a-z0-9_]+)*$ ]] || fail 'Use comma-separated lowercase amenity values, without spaces.'
  ipv4_ok "$host_ip" || fail 'Invalid host IPv4 binding.'
  for key in host_port precision cache_mb update_seconds rebuild_seconds chunk_mb ram_mb worker_mb workers update_workers; do
    positive "${!key}" || fail "Invalid integer in $key."
  done
  (( update_workers <= 16 )) || fail 'Update workers must be between 1 and 16.'
  (( host_port <= 65535 && precision >= 3 && precision <= 7 )) || fail 'Invalid port or shard precision.'
  (( worker_mb >= 2048 )) || fail 'Planet imports need at least 2048 MiB per worker; 1024 MiB is insufficient.'
  (( ram_mb >= worker_mb + 512 && workers * worker_mb + 512 <= ram_mb )) || fail 'RAM budget must cover all workers plus a 512 MiB controller reserve.'
  for key in all_values keep_chunks verify; do
    [[ ${!key} == true || ${!key} == false ]] || fail "Invalid boolean in $key."
  done
  for key in deployment pipeline sources; do
    for other in deployment pipeline sources; do
      [[ $key == "$other" ]] && continue
      contains_path "${!key}" "${!other}" && fail 'Deployment, pipeline and source directories must not overlap.'
    done
    contains_path "$repository" "${!key}" && fail 'Keep deployment, pipeline and source directories outside the repository build context.'
  done
  [[ $log_level == errors || $log_level == info || $log_level == debug ]] || fail 'Invalid log verbosity.'
  [[ -f $repository/Dockerfile && -f $repository/scripts/extract.mjs ]] || fail 'Repository path does not contain the application.'
}

if [[ $resume == true ]]; then
  path_ok "$deployment" || fail '--resume needs an absolute path.'
  deployment=$(realpath -m -- "$deployment")
  requested_deployment=$deployment
  [[ -f $deployment/settings.tsv ]] || fail 'No generated settings.tsv at this location.'
  declare -A loaded=()
  while IFS=$'\t' read -r key value; do
    allowed=false
    for known in "${keys[@]}"; do [[ $key != "$known" ]] || allowed=true; done
    [[ $allowed == true && ( -n $value || $key == fallbacks ) && ! -v loaded[$key] ]] || fail 'Invalid or duplicate saved setting.'
    printf -v "$key" '%s' "$value"
    loaded[$key]=1
  done < "$deployment/settings.tsv"
  if [[ ! -v loaded[update_workers] ]]; then update_workers=1; loaded[update_workers]=1; fi
  for key in "${keys[@]}"; do [[ -v loaded[$key] ]] || fail "Missing saved setting: $key"; done
  [[ $deployment == "$requested_deployment" ]] || fail 'Saved deployment location differs from --resume.'
  validate_settings
  for file in compose.sh docker-compose.yml server.env; do
    [[ -f $deployment/$file ]] || fail "Missing deployment file: $file"
  done
else
  printf '\nOSM Amenity Server — Docker Compose setup\n'
  printf 'Planet import and replication are not yet validated at planet scale. Keep existing proxy upstreams available.\n'
  printf 'Press Enter to accept defaults. Configuration is reviewed before it is written.\n\n'
  printf 'Storage overview (all paths below are on this host):\n'
  printf '  Source:   the original planet PBF download. It is kept unchanged for updates and recovery.\n'
  printf '  Pipeline: import chunks, intermediate files, indexes and the active served data. Old generations can remain here.\n'
  printf '  Config:   small text configuration files; this does not hold planet data.\n'
  printf 'Disk planning: reserve space for the source PBF, roughly another source-sized set of chunks, import/index working data,\n'
  printf 'and the new index while an old one is still active. Exact planet usage is not measured; leave substantial extra headroom.\n'
  printf 'Check free space on the filesystems containing source and pipeline paths with: df -h /srv\n\n'
  printf 'Step 1/5: Paths and source\n'
  ask_path repository 'Application checkout' "$repository"
  ask_path deployment 'Deployment configuration directory' /srv/osm-amenity/deployment
  ask_path pipeline 'Writable pipeline directory (chunks, work files and served indexes; needs most disk space)' /srv/osm-amenity/pipeline
  while true; do
    ask source_mode 'Source: download or existing' download
    [[ $source_mode == download || $source_mode == existing ]] && break
  done
  source_url=https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf
  checksum_url=$source_url.md5
  if [[ $source_mode == existing ]]; then
    ask_path source_path 'Existing immutable planet PBF' /srv/osm-amenity/sources/planet-initial.osm.pbf
    [[ -f $source_path ]] || fail "Source file does not exist: $source_path"
    sources=$(dirname -- "$source_path"); source_file=$(basename -- "$source_path")
  else
    ask_path sources 'Retained source directory (kept planet PBF; allow its full download size)' /srv/osm-amenity/sources
    ask source_file 'Retained source filename (never overwrite after importing)' planet-initial.osm.pbf
    ask_url source_url 'Planet PBF download URL (a dated URL is best for resuming)' "$source_url"
    ask_url checksum_url 'Matching MD5 checksum URL' "$source_url.md5"
  fi

  printf '\nStep 2/5: Docker and proxy connectivity\n'
  printf 'The proxy is your existing Overpass-Proxy: it receives client queries and forwards them to this amenity backend.\n'
  printf 'It can send other or unsupported queries to fallback Overpass servers. The proxy stays a separate deployment.\n'
  ask_name project 'Compose project name' osm-amenity
  ask_name service 'Backend Compose service name' amenity-server
  ask_name network 'Shared Docker network name' osm-overpass
  ask_name dns_name 'Backend DNS alias on the shared network' osm-amenity
  while true; do
    ask host_ip 'Host bind IPv4 (loopback recommended; no built-in TLS/auth)' 127.0.0.1
    ipv4_ok "$host_ip" && break
    printf 'Enter a valid IPv4 address.\n'
  done
  ask_int host_port 'Host HTTP port' 8081 1 65535
  while true; do
    ask proxy_mode 'Where does the existing query-forwarding proxy run: docker (same host), host, or remote?' docker
    [[ $proxy_mode == docker || $proxy_mode == host || $proxy_mode == remote ]] && break
  done
  ask_name proxy_service 'Existing proxy Compose service name (for integration example)' proxy
  case "$proxy_mode" in
    docker) proxy_url="http://$dns_name:8081/api/interpreter" ;;
    host)
      endpoint_ip=$host_ip; [[ $endpoint_ip != 0.0.0.0 ]] || endpoint_ip=127.0.0.1
      proxy_url="http://$endpoint_ip:$host_port/api/interpreter" ;;
    remote)
      ask_url proxy_url 'Reachable backend interpreter URL (configure your VPN/TLS route separately)' https://amenity.example.com/api/interpreter ;;
  esac
  ask fallbacks 'Fallback interpreter URL(s), comma-separated; enter none for no fallback' https://overpass-api.de/api/interpreter
  [[ $fallbacks != none ]] || fallbacks=''

  printf '\nStep 3/5: Served data and update settings\n'
  ask amenities 'Amenity values (lowercase, comma-separated, no spaces)' toilets
  printf 'Shard precision divides the map into geographic cells; it is not a file-size setting. Approximate cell dimensions:\n'
  printf '  3: 156 x 156 km; 4: 19.5 x 39 km; 5: 4.9 x 4.9 km; 6: 610 m x 1.2 km; 7: 153 x 153 m (at the equator).\n'
  printf 'At Germany latitudes, east-west cells are about 60%% as wide. Each query loads the cells its bounding box touches.\n'
  printf 'Higher precision means smaller cells and often less unrelated data per small query, but more cells/files to load;\n'
  printf 'lower precision means fewer, larger cells and can read more unrelated nearby data. Large cells can exceed build limits.\n'
  printf 'Example: precision 5 may touch only a few roughly 5 km cells for a neighborhood query; a country-wide query touches many.\n'
  printf 'Higher precision can narrow small queries but creates more shards for large-area queries. Cell borders can add cells.\n'
  printf 'Default 5 is a practical balance. Keep the same precision in the server and imported index.\n'
  ask_int precision 'Geographic shard precision (3-7; default 5)' 5 3 7
  ask_int cache_mb 'HTTP shard cache (MiB)' 256 1 1048576
  ask_int update_seconds 'Update-loop sleep interval (seconds)' 3600 1 31536000
  ask_int rebuild_seconds 'Weekly drift rebuild interval (seconds)' 604800 1 31536000
  while true; do
    ask log_level 'Log verbosity: errors, info, debug' info
    [[ $log_level == errors || $log_level == info || $log_level == debug ]] && break
  done

  printf '\nStep 4/5: Initial extraction resources\n'
  printf 'Leave RAM for the OS, Docker and the proxy. These budgets do not limit the whole container or future weekly rebuilds.\n'
  printf 'For a full-planet import, 1024 MiB per worker is insufficient in practice; use at least 2048 MiB per worker.\n'
  printf 'The total pipeline budget must cover workers x per-worker RAM plus a 512 MiB controller reserve.\n'
  ask_int chunk_mb 'PBF chunk size (MiB)' 256 1 1048576
  ask_int ram_mb 'Pipeline RAM budget (MiB)' 8192 2560 1048576
  ask_int worker_mb 'Per-worker RAM budget (MiB; at least 2048 for planet imports)' 2048 2048 "$((ram_mb - 512))"
  max_workers=$(((ram_mb - 512) / worker_mb))
  default_workers=3; (( max_workers >= 3 )) || default_workers=$max_workers
  ask_int workers 'Maximum extraction workers' "$default_workers" 1 "$max_workers"
  printf 'Update workers run independent PBF lookups and geometry builds after each diff batch is coalesced.\n'
  printf 'They are separate from extraction workers; more workers need additional RAM, CPU and disk throughput.\n'
  ask_int update_workers 'Concurrent update workers (1-16; default 1)' 1 1 16
  printf 'This controls temporary import data, not which values the server answers today. Yes keeps objects tagged with any amenity value\n'
  printf 'so you can build another served amenity set later without repeating the PBF scan; it uses more disk. No keeps only\n'
  printf 'the values selected above and saves space, but adding values later requires rerunning the import from the PBF.\n'
  all_values=false; confirm 'Keep every amenity value in temporary import data?' no && all_values=true
  keep_chunks=false; confirm 'Keep PBF chunks for resuming?' yes && keep_chunks=true
  verify=false; confirm 'Verify source/chunk object counts (extra full scans; retains chunks)?' yes && verify=true
  validate_settings
  [[ ! -e $deployment ]] || [[ -d $deployment && -z $(find "$deployment" -mindepth 1 -maxdepth 1 -print -quit) ]] ||
    fail 'Deployment directory is not empty. Use --resume for an existing setup, or choose a new directory.'
  [[ ! -e $pipeline/data && ! -L $pipeline/data && ! -e $pipeline/work/manifest.json ]] ||
    fail 'Pipeline already contains a generation or import. Resume its original deployment instead of replacing its settings.'

  printf '\nStep 5/5: Review\n'
  printf 'Checkout:    %s\nDeployment:  %s\nPipeline:    %s\nSource:      %s/%s (%s)\n' "$repository" "$deployment" "$pipeline" "$sources" "$source_file" "$source_mode"
  printf 'Project/service: %s / %s\nNetwork/alias:   %s / %s\nHost binding:    %s:%s\n' "$project" "$service" "$network" "$dns_name" "$host_ip" "$host_port"
  printf 'Proxy upstream: %s\nFallbacks: %s\nAmenities: %s; precision: %s\n' "$proxy_url" "${fallbacks:-none}" "$amenities" "$precision"
  printf 'Import: %s MiB RAM, %s workers x %s MiB; chunks %s MiB\n' "$ram_mb" "$workers" "$worker_mb" "$chunk_mb"
  printf 'Update workers: %s\n' "$update_workers"
  printf 'Cache: %s MiB; update sleep: %s s; rebuild interval: %s s; logs: %s\n' "$cache_mb" "$update_seconds" "$rebuild_seconds" "$log_level"
  printf 'Retain all values: %s; keep chunks: %s; verify counts: %s\n' "$all_values" "$keep_chunks" "$verify"
  if [[ $host_ip != 127.0.0.1 ]]; then
    printf 'The host binding is not loopback. Restrict access through your VPN/firewall/TLS proxy; Docker publishing can bypass UFW.\n'
  fi
  confirm 'Write this deployment configuration?' yes || exit 0
  install -d -- "$deployment" "$pipeline" "$sources"
  for key in "${keys[@]}"; do printf '%s\t%s\n' "$key" "${!key}"; done > "$deployment/settings.tsv"
  cat > "$deployment/server.env" <<ENV
PORT=8081
OSM_AMENITY_DATA_DIR=/osm/data
OSM_AMENITY_SOURCE_PBF=/source/$source_file
OSM_AMENITY_AMENITIES=$amenities
OSM_AMENITY_SHARD_PRECISION=$precision
OSM_AMENITY_SHARD_CACHE_MB=$cache_mb
OSM_AMENITY_UPDATE_INTERVAL_SECONDS=$update_seconds
OSM_AMENITY_UPDATE_WORKERS=$update_workers
OSM_AMENITY_REEXTRACT_EVERY_SECONDS=$rebuild_seconds
LOG_VERBOSITY=$log_level
ENV
  cat > "$deployment/docker-compose.yml" <<YAML
version: '3.3'
services:
  $service:
    build: '$repository'
    restart: unless-stopped
    stop_grace_period: 30s
    env_file:
      - '$deployment/server.env'
    ports:
      - '$host_ip:$host_port:8081'
    volumes:
      - '$pipeline:/osm:rw'
      - '$sources:/source:ro'
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '5'
    networks:
      default: {}
      $network:
        aliases: ['$dns_name']
networks:
  $network:
    external: true
YAML
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'if docker compose version >/dev/null 2>&1; then\n  command=(docker compose)\nelse\n  command=(docker-compose)\nfi\n'
    printf 'exec "${command[@]}" --project-name %q --file %q "$@"\n' "$project" "$deployment/docker-compose.yml"
  } > "$deployment/compose.sh"
  chmod 0755 "$deployment/compose.sh"
  upstreams=$proxy_url; [[ -z $fallbacks ]] || upstreams+=",$fallbacks"
  {
    printf '# Merge into the existing proxy Compose file; do not replace the stack.\n'
    printf 'services:\n  %s:\n    environment:\n      UPSTREAM_URLS: "%s"\n' "$proxy_service" "$upstreams"
    if [[ $proxy_mode == docker ]]; then
      printf '    networks: [default, %s]\nnetworks:\n  %s:\n    external: true\n' "$network" "$network"
    fi
  } > "$deployment/proxy.compose.example.yml"
fi

# All future commands use the saved, explicit project/file rather than the CWD.
dc() { "$deployment/compose.sh" "$@"; }
resume_hint() {
  printf '\nTo continue: bash %q --resume %q\n' "$repository/scripts/easy-setup.sh" "$deployment"
}
on_interrupt() {
  local signal=$1 owner running
  trap - INT TERM
  printf '\nSetup interrupted (%s).\n' "$signal"
  if [[ -n ${import_name:-} ]] && command -v docker >/dev/null && docker inspect "$import_name" >/dev/null 2>&1; then
    owner=$(docker inspect --format '{{index .Config.Labels "io.osm-amenity.setup"}}' "$import_name" 2>/dev/null || true)
    running=$(docker inspect --format '{{.State.Running}}' "$import_name" 2>/dev/null || true)
    if [[ $owner == "$deployment" && $running == true ]]; then
      printf 'Stopping this deployment’s detached import (%s); waiting up to 120 seconds for a graceful stop...\n' "$import_name"
      if docker stop --time 120 "$import_name" >/dev/null; then
        docker rm "$import_name" >/dev/null 2>&1 || true
        printf 'Detached import stopped and its container removed. Completed work is retained; --resume will continue from it.\n'
      else
        printf 'Could not stop the import automatically. Check it with: docker ps --filter name=%q\n' "$import_name" >&2
      fi
    fi
  fi
  resume_hint
  exit 130
}
trap 'on_interrupt INT' INT
trap 'on_interrupt TERM' TERM
printf '\nConfiguration: %s\nCompose wrapper: %s/compose.sh\n' "$deployment" "$deployment"
if [[ $configure_only == true ]]; then resume_hint; exit 0; fi
command -v docker >/dev/null || fail 'Docker is required. Configuration is saved; use --resume after installing Docker.'
if ! docker compose version >/dev/null 2>&1; then
  command -v docker-compose >/dev/null || fail 'Install Docker Compose, then use --resume.'
fi
docker info >/dev/null || fail 'Cannot access the Docker daemon. Use an account with Docker access, then --resume.'
dc config >/dev/null
if ! docker network inspect "$network" >/dev/null 2>&1; then docker network create "$network"; fi
if confirm 'Build/rebuild the application image now? (skip only if already built)' yes; then dc build "$service"; fi

source_path=$sources/$source_file
active=false
[[ ! -e $pipeline/data && ! -L $pipeline/data ]] || active=true
if [[ ! -f $source_path ]]; then
  [[ $active == false ]] || fail 'Active pipeline has lost its retained baseline. Restore the original bytes; do not download a new snapshot over that path.'
  [[ $source_mode == download ]] || fail "Retained source is missing: $source_path"
  confirm 'Download and checksum the planet now (keep this shell in tmux/screen)?' yes || { resume_hint; exit 0; }
  command -v curl >/dev/null || fail 'Install curl and use --resume.'
  command -v md5sum >/dev/null || fail 'GNU coreutils (md5sum) is required.'
  curl --fail --location --retry 3 --output "$deployment/source.md5" "$checksum_url"
  expected_md5=$(awk 'NR == 1 {print $1}' "$deployment/source.md5")
  [[ $expected_md5 =~ ^[a-fA-F0-9]{32}$ ]] || fail 'Checksum URL did not provide an MD5 checksum.'
  # Tie a partial file to this URL and checksum; never resume mixed snapshots.
  partial=$source_path.part
  identity=$(printf '%s\n%s' "$source_url" "$expected_md5")
  if [[ -e $partial ]]; then
    [[ -f $partial.identity && $(cat "$partial.identity") == "$identity" ]] ||
      fail "Partial download belongs to another snapshot. Move it aside before retrying: $partial"
  fi
  printf '%s\n' "$identity" > "$partial.identity"
  curl --fail --location --retry 3 --continue-at - --output "$partial" "$source_url"
  actual_md5=$(md5sum -- "$partial"); actual_md5=${actual_md5%% *}
  [[ ${actual_md5,,} == ${expected_md5,,} ]] || fail "Download checksum failed. Keep the pipeline unchanged; inspect or move aside $partial before retrying."
  [[ ! -e $source_path ]] || fail 'Source appeared during download; refusing to overwrite it.'
  mv -n -- "$partial" "$source_path"
  [[ ! -e $partial ]] || fail 'Source was not published; refusing to continue.'
  chmod 0444 "$source_path"
  rm -- "$partial.identity"
fi

if [[ $active == false ]]; then
  printf '\nChecking source timestamp and planet/minute replication provenance...\n'
  if [[ -f $deployment/replication.env ]]; then
    mapfile -t replication_settings < "$deployment/replication.env"
    (( ${#replication_settings[@]} == 2 )) || fail 'Saved replication.env is invalid; inspect it before continuing.'
    feed_setting=${replication_settings[0]}
    sequence_setting=${replication_settings[1]}
    [[ $feed_setting == OSM_AMENITY_UPDATE_BASE_URL=* && $sequence_setting == OSM_AMENITY_REPLICATION_SEQUENCE_NUMBER=* ]] || fail 'Saved replication.env is invalid; inspect it before continuing.'
    url_ok "${feed_setting#*=}" && positive "${sequence_setting#*=}" || fail 'Saved replication.env contains invalid values.'
  else
    dc run --rm --no-deps -T "$service" node --input-type=module -e '
import { sourceMetadata } from "./scripts/extract.mjs";
import { spawnSync } from "node:child_process";
const m = sourceMetadata(process.env.OSM_AMENITY_SOURCE_PBF);
if (!m.timestamp || !Number.isFinite(Date.parse(m.timestamp))) {
  throw new Error("Snapshot needs a valid timestamp in its PBF header");
}
let r = m.replication;
if (!r || r.kind !== "planet" || r.interval !== "minute" ||
    !Number.isSafeInteger(r.sequenceNumber) || r.sequenceNumber <= 0) {
  console.error("Planet PBF has no usable minute cursor; finding a safe start sequence...");
  const found = spawnSync("pyosmium-get-changes", ["-O", process.env.OSM_AMENITY_SOURCE_PBF], { encoding: "utf8" });
  if (found.status !== 0) throw new Error(`pyosmium-get-changes failed: ${found.stderr || found.error || "unknown error"}`);
  const nextSequence = Number(found.stdout.trim());
  if (!Number.isSafeInteger(nextSequence) || nextSequence <= 1) {
    throw new Error(`pyosmium-get-changes returned an invalid starting sequence: ${found.stdout.trim()}`);
  }
  // pyosmium reports the first diff to apply; this server stores the last applied sequence.
  r = { baseUrl: "https://planet.openstreetmap.org/replication/minute", sequenceNumber: nextSequence - 1, kind: "planet", interval: "minute" };
}
console.log("OSM_AMENITY_UPDATE_BASE_URL=" + r.baseUrl);
console.log("OSM_AMENITY_REPLICATION_SEQUENCE_NUMBER=" + r.sequenceNumber);
' > "$deployment/replication.env.tmp"
    mapfile -t replication_settings < "$deployment/replication.env.tmp"
    (( ${#replication_settings[@]} == 2 )) || fail 'Invalid source metadata output.'
    feed_setting=${replication_settings[0]}
    sequence_setting=${replication_settings[1]}
    [[ $feed_setting == OSM_AMENITY_UPDATE_BASE_URL=* && $sequence_setting == OSM_AMENITY_REPLICATION_SEQUENCE_NUMBER=* ]] || fail 'Invalid source metadata output.'
    url_ok "${feed_setting#*=}" || fail 'Unsupported replication URL in source header.'
    positive "${sequence_setting#*=}" || fail 'Invalid replication sequence from source metadata.'
    mv -- "$deployment/replication.env.tmp" "$deployment/replication.env"
  fi
  replication_base=${feed_setting#*=}
  replication_sequence=${sequence_setting#*=}
  sed -e '/^OSM_AMENITY_UPDATE_BASE_URL=/d' -e '/^OSM_AMENITY_REPLICATION_SEQUENCE_NUMBER=/d' "$deployment/server.env" > "$deployment/server.env.tmp"
  printf '%s\n' "$feed_setting" >> "$deployment/server.env.tmp"
  mv -- "$deployment/server.env.tmp" "$deployment/server.env"
fi

import_name=$project-import
has_import=false
if docker inspect "$import_name" >/dev/null 2>&1; then
  owner=$(docker inspect --format '{{index .Config.Labels "io.osm-amenity.setup"}}' "$import_name")
  [[ $owner == "$deployment" ]] || fail "Container $import_name belongs to another deployment; choose another project name."
  has_import=true
  running=$(docker inspect --format '{{.State.Running}}' "$import_name")
  if [[ $running == false ]]; then
    import_exit=$(docker inspect --format '{{.State.ExitCode}}' "$import_name")
    if [[ $import_exit != 0 ]]; then
      docker logs --tail=60 "$import_name"
      confirm 'Previous import failed. After resolving the cause, remove its stopped container and retry?' no || { resume_hint; exit 1; }
      docker rm "$import_name"
      has_import=false
      # Stage 4 may have published before a later count verification failed.
      active=false
    fi
  fi
fi
if [[ $active == false && $has_import == false ]]; then
  stage_range=0-4
  resume_mode=verify
  stage0_manifest=$pipeline/work/manifest.json
  if [[ -f $stage0_manifest ]] && grep -Eq '"complete"[[:space:]]*:[[:space:]]*true' "$stage0_manifest"; then
    stage0_date=$(sed -nE 's/.*"completedAt"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$stage0_manifest" | head -n 1)
    [[ -n $stage0_date ]] || stage0_date=$(sed -nE 's/.*"createdAt"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$stage0_manifest" | head -n 1)
    printf '\nStage 0 is marked complete%s.\n' "${stage0_date:+ (manifest date: $stage0_date)}"
    latest_marker=$(find "$pipeline/work/state" -type f -name '*.done' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 || true)
    if [[ -n $latest_marker ]]; then
      latest_marker_time=${latest_marker%% *}
      latest_marker_path=${latest_marker#* }
      latest_marker_date=$(date -d "@${latest_marker_time%%.*}" '+%Y-%m-%d %H:%M:%S %Z')
      printf 'Last completed work unit: %s (%s).\n' "$(basename "$latest_marker_path" .done)" "$latest_marker_date"
    fi
    if confirm 'Trust the saved manifest and completed work markers, and resume at the first incomplete stage/chunk? This skips full-file hashes and trusts existing data. Choose no to verify everything as before.' yes; then
      stage_range=1-4
      resume_mode=trust
      printf 'Resume mode: trust existing progress; only incomplete work units will be processed.\n'
    else
      printf 'Resume mode: verify source, chunks and completed outputs before continuing; this can take hours.\n'
    fi
  elif [[ -f $stage0_manifest ]] && grep -Eq '"complete"[[:space:]]*:[[:space:]]*false' "$stage0_manifest" && grep -Eq '"sourceFingerprint"[[:space:]]*:[[:space:]]*"[[:xdigit:]]+"' "$stage0_manifest"; then
    stage0_date=$(sed -nE 's/.*"createdAt"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$stage0_manifest" | head -n 1)
    printf '\nStage 0 was interrupted%s.\n' "${stage0_date:+ (manifest started: $stage0_date)}"
    latest_marker=$(find "$pipeline/work/state" -type f -name '*.done' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 || true)
    if [[ -n $latest_marker ]]; then
      latest_marker_time=${latest_marker%% *}
      latest_marker_path=${latest_marker#* }
      latest_marker_date=$(date -d "@${latest_marker_time%%.*}" '+%Y-%m-%d %H:%M:%S %Z')
      printf 'Last completed work unit: %s (%s).\n' "$(basename "$latest_marker_path" .done)" "$latest_marker_date"
    fi
    if confirm 'Trust the partial stage 0 manifest and completed chunk markers, and continue at the first incomplete chunk? Choose no to verify the source and completed chunks again.' yes; then
      resume_mode=trust
      printf 'Resume mode: trust saved progress; stage 0 will scan block headers and repeat only incomplete chunks.\n'
    else
      printf 'Resume mode: verify source, chunks and completed outputs before continuing; this can take hours.\n'
    fi
  else
    printf '\nStage 0 has no complete manifest; it must run and verify the source before continuing.\n'
  fi
  confirm "Launch/resume extraction stages $stage_range in a detached container?" yes || { resume_hint; exit 0; }
  # Avoid any concurrent automatic updater writing this pipeline.
  dc stop "$service"
  dc run -d --no-deps \
    -e "OSM_AMENITY_BOOTSTRAP_REPLICATION_BASE_URL=$replication_base" \
    -e "OSM_AMENITY_BOOTSTRAP_REPLICATION_SEQUENCE_NUMBER=$replication_sequence" \
    --name "$import_name" --label "io.osm-amenity.setup=$deployment" "$service" \
    node scripts/extract.mjs --source "/source/$source_file" --data-dir /osm --stages "$stage_range" --resume-mode "$resume_mode" \
    --amenities "$amenities" --shard-precision "$precision" \
    --chunk-mb "$chunk_mb" --ram-mb "$ram_mb" --worker-ram-mb "$worker_mb" --workers "$workers" \
    --all-amenity-values "$all_values" --keep-chunks "$keep_chunks" --verify "$verify"
  has_import=true
fi
if [[ $has_import == true ]]; then
  printf '\nDetached import: %s\nYou can disconnect SSH; the container keeps running.\n' "$import_name"
  printf 'Resource monitoring: docker stats %q\n' "$import_name"
  confirm 'Follow import logs and wait for completion now? (Ctrl-C stops the import)' yes || { resume_hint; exit 0; }
  docker logs --follow "$import_name"
  import_exit=$(docker wait "$import_name")
  [[ $import_exit == 0 ]] || fail "Import exited with code $import_exit. Resolve the logged error, then use --resume."
fi

printf '\nValidating the published generation against the server configuration...\n'
dc run --rm --no-deps -T "$service" node --input-type=module -e '
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { loadConfig } from "./dist/config.js";
const c = loadConfig();
const m = JSON.parse(await readFile("/osm/data/manifest.json", "utf8"));
const s = JSON.parse(await readFile("/osm/data/state.json", "utf8"));
assert.ok(Array.isArray(m.shards) && m.shards.length > 0, "No populated shard inventory");
assert.deepEqual([...m.amenities].sort(), [...c.amenities].sort(), "Amenity configuration mismatch");
assert.equal(m.shardPrecision, c.shardPrecision, "Shard precision mismatch");
assert.equal(s.replication?.baseUrl, c.updateBaseUrl, "Replication URL mismatch");
assert.equal(s.replication?.kind, "planet");
assert.equal(s.replication?.interval, "minute");
assert.ok(Number.isSafeInteger(s.replication.sequenceNumber) && s.replication.sequenceNumber > 0);
console.log(JSON.stringify({ generation: m.generation, timestamp: s.dataTimestamp, replication: s.replication }));
'
confirm 'Start the HTTP server and its automatic updater now?' yes || { resume_hint; exit 0; }
dc up -d "$service"
ready=false
for attempt in {1..15}; do
  if dc exec -T "$service" node --input-type=module -e '
const r = await fetch("http://127.0.0.1:8081/api/status");
if (!r.ok) process.exit(1);
' >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
[[ $ready == true ]] || fail 'Server did not become reachable. Inspect service logs; configuration is saved.'
dc exec -T "$service" node scripts/verify-http.mjs --url http://127.0.0.1:8081 --amenity "${amenities%%,*}"
dc ps
printf '\nHTTP checks passed. Backend interpreter for your proxy:\n  %s\n' "$proxy_url"
printf 'Merge the example into your existing proxy Compose file, then recreate that proxy:\n  %s/proxy.compose.example.yml\n' "$deployment"
printf 'The wizard does not edit/restart your proxy or configure public TLS/VPN routing.\n'
printf 'Check updater logs and timestamps before calling the planet current. A successful HTTP check does not prove catch-up.\n'
printf 'Logs: %q logs --tail=100 -f %q\n' "$deployment/compose.sh" "$service"
printf 'Status: %q ps\nStop: %q stop %q\nStart: %q up -d %q\n' \
  "$deployment/compose.sh" "$deployment/compose.sh" "$service" "$deployment/compose.sh" "$service"
printf 'Retain all baseline PBFs. Old generations require operator-managed cleanup.\n'
