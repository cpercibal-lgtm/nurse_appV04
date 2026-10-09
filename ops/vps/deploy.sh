#!/bin/bash
# ops/vps/deploy.sh — releases on the single VPS (decision D-57). Runs as root
# on the VPS: called over SSH by .github/workflows/deploy-vps.yml, or by an
# operator.
#
#   deploy.sh load <images.tar.gz>   load the release images (nurseapp/{api,migrate,web}:<tag>)
#   deploy.sh release <tag>          migrate → grants + verify → start the idle colour →
#                                    health → switch Caddy → stop the old colour
#   deploy.sh rollback               the previous release's colour back in front
#   deploy.sh restart                the live release again, in the other colour (after editing app.env)
#   deploy.sh status                 live colour and tag, containers
#   deploy.sh edge                   (re)start Caddy and ClamAV
#   deploy.sh bootstrap              first administrators, interactively (empty database only)
#   deploy.sh psql                   a superuser psql on the VPS (no network exposure)
#   deploy.sh exit-package "<reason>" the hospital exit package (spec §14.3), encrypted to the
#                                    backup public key → /srv/nurseapp/exit/ (README.md §8)
#
# Blue/green: the release starts beside the live colour and receives traffic
# only after its API and web answer healthy; Caddy's reload is graceful, so
# nobody's request is dropped. Migrations run first and are forward-only:
# a release's schema change must keep working for the previous version
# (expand, release, then contract in a later release) — see README.md §6.
#
# Files (README.md §4):
#   /etc/nurseapp/app.env      API + worker settings (DATABASE_URL = nurseapp_runtime)
#   /etc/nurseapp/migrate.env  MIGRATION_DATABASE_URL (+ DATABASE_URL) — the release step only
#   /etc/nurseapp/deploy.env   SITE_HOST, ACME_EMAIL, DB_NAME
#   /srv/nurseapp/             storage/, clamav/, caddy/, ACTIVE, PREVIOUS

set -euo pipefail

CMD="${1:-}"; ARG="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS="$(cd "$HERE/.." && pwd)"
CONF="${NURSEAPP_CONF:-/etc/nurseapp}"
STATE="${NURSEAPP_STATE:-/srv/nurseapp}"
# shellcheck disable=SC1091
[[ -f "$CONF/deploy.env" ]] && source "$CONF/deploy.env"
DB_NAME="${DB_NAME:-nurseapp_v04}"
DB_HOST_IP="${DB_HOST_IP:-host-gateway}"
# How the release step reaches PostgreSQL as a superuser (peer authentication over the local socket).
read -r -a PSQL <<< "${DB_SUPERUSER_PSQL:-sudo -u postgres psql}"
export NURSEAPP_CONF="$CONF" NURSEAPP_STATE="$STATE" DB_HOST_IP SITE_HOST ACME_EMAIL CADDY_GLOBAL_EXTRA

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
need_tag() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "usage: $0 $CMD <tag>"; }
edge() { docker compose -f "$HERE/docker-compose.edge.yml" "$@"; }
app() { local color="$1" tag="$2"; shift 2; COLOR="$color" TAG="$tag" docker compose -f "$HERE/docker-compose.app.yml" "$@"; }
other() { [[ "$1" == blue ]] && echo green || echo blue; }
read_state() { cat "$STATE/$1" 2>/dev/null || true; }   # "<colour> <tag>"

# While colours switch, ACTIVE still names the old colour whose containers are being
# stopped; monitor.sh would report them as failed and e-mail a false alarm. The marker
# tells it a switch is in progress; it is removed on every exit (and ignored if stale).
mark_deploying() { mkdir -p "$STATE"; date +%s > "$STATE/DEPLOYING"; trap 'rm -f "$STATE/DEPLOYING"' EXIT; }

# Every release loads three images (~1 GB); without this they piled up until the
# disk filled. Keeps the tags given (the live and the previous release, which a
# rollback needs) and removes every other nurseapp image. An image a container
# still uses is refused by Docker and kept.
prune_images() {
  local keep=" $* " img
  while IFS= read -r img; do
    [[ "$keep" == *" ${img##*:} "* ]] && continue
    docker image rm "$img" >/dev/null 2>&1 && log "removed old image $img"
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^nurseapp/(api|migrate|web):')
  docker image prune -f >/dev/null 2>&1 || true
}

# The container of a service in a colour, once it reports healthy (Docker HEALTHCHECK).
wait_healthy() {
  local color="$1" service="$2" id status
  for _ in $(seq 1 90); do
    id="$(docker ps -q --filter "label=com.docker.compose.project=nurseapp-$color" --filter "label=com.docker.compose.service=$service" | head -n1)"
    status="$( [[ -n "$id" ]] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo starting)"
    [[ "$status" == healthy ]] && { echo "$id"; return 0; }
    sleep 2
  done
  die "$service ($color) did not become healthy in 180 s — see: docker logs \$(docker ps -aq --filter label=com.docker.compose.project=nurseapp-$color)"
}

# The whole path a user takes, inside the colour: nginx → API → database.
check_colour() {
  local color="$1" web
  web="$(wait_healthy "$color" web)"
  docker exec "$web" wget -qO- http://127.0.0.1:8080/api/v1/health | grep -q '"database":"up"' \
    || die "$color answers, but its API cannot reach the database"
}

# The images must be the ones the release's manifest (ops/RELEASE_IMAGES, written by
# make-image-manifest.sh after the tests) names: same sha256 of images.tar.gz.
verify_images() {
  local file="$1" manifest="$OPS/RELEASE_IMAGES" want got
  [[ -f "$manifest" ]] || die "$manifest is missing — a release must name its images"
  want="$(awk '$1 == "sha256" { print $2 }' "$manifest")"
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "$manifest has no sha256 line"
  got="$(sha256sum "$file" | cut -d' ' -f1)"
  [[ "$got" == "$want" ]] || die "the images are not the ones the manifest names (manifest $want, file $got)"
  mkdir -p "$STATE"
  { date -u +'%FT%TZ'; sed 's/^/  /' "$manifest"; } >> "$STATE/image-manifests.log"   # what each release ran
  log "images match the manifest ($(awk '$1 == "tag" { print $2 }' "$manifest"))"
}

caddy_reload() { edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; }

switch_to() {
  local color="$1"
  printf 'reverse_proxy web-%s:8080\n' "$color" > "$STATE/caddy/etc/site/upstream.caddy.new"
  mv "$STATE/caddy/etc/site/upstream.caddy.new" "$STATE/caddy/etc/site/upstream.caddy"   # atomic
  caddy_reload
  # Through the public entrance: TLS, Caddy, the new colour.
  local curl=(curl -fsS --noproxy '*' --max-time 10 --resolve "$SITE_HOST:443:127.0.0.1")
  [[ "${CURL_INSECURE:-}" == 1 ]] && curl+=(-k)
  for _ in $(seq 1 15); do
    "${curl[@]}" "https://$SITE_HOST/api/v1/health" >/dev/null 2>&1 && { log "live: $color"; return 0; }
    sleep 2
  done
  die "https://$SITE_HOST does not answer after switching to $color"
}

migrate() {
  local tag="$1"
  [[ -f "$CONF/migrate.env" ]] || die "$CONF/migrate.env is missing"
  log "migrations ($tag) as nurseapp_migration"
  docker run --rm --env-file "$CONF/migrate.env" --network nurseapp --add-host "db.host:$DB_HOST_IP" "nurseapp/migrate:$tag"
  log "role grants + verify.sql"
  "${PSQL[@]}" -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" < "$OPS/db/02_grants.sql"
  local out
  out="$("${PSQL[@]}" -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" < "$OPS/db/verify.sql" 2>&1)" \
    || { echo "$out" >&2; die "verify.sql reported a FAIL — the release stops before the new version starts"; }
}

# Brings <colour> up with <tag>, checks it, puts it in front, then retires the other colour.
promote() {
  local color="$1" tag="$2" old_color="$3"
  log "starting $color ($tag) beside the live colour"
  app "$color" "$tag" up -d --remove-orphans --scale worker=0
  check_colour "$color"
  switch_to "$color"
  # One job runner at a time (the worker lease would also prevent overlap).
  if [[ -n "$old_color" ]]; then
    app "$old_color" none stop -t 20 worker >/dev/null 2>&1 || true
  fi
  app "$color" "$tag" up -d worker
  if [[ -n "$old_color" ]]; then
    sleep "${DRAIN_SECONDS:-10}"   # requests already inside the old colour finish
    app "$old_color" none stop -t 30 >/dev/null 2>&1 || true
    log "stopped $old_color (kept for rollback)"
  fi
}

case "$CMD" in
  load)
    [[ -f "$ARG" ]] || die "usage: $0 load <images.tar.gz>"
    verify_images "$ARG"
    # The release scripts are public repository files; PostgreSQL's archive_command and the
    # nightly backup run ops/backup/scripts as postgres. An older nurseapp-release (umask 077)
    # leaves them root-only — fixed here because this file travels with every release.
    chmod -R u=rwX,go=rX "$OPS"
    gunzip -c "$ARG" | docker load
    ;;
  edge)
    mkdir -p "$STATE/caddy/data" "$STATE/caddy/config" "$STATE/caddy/etc/site" "$STATE/clamav"
    [[ -f "$STATE/caddy/etc/site/upstream.caddy" ]] || echo 'respond "The application is being installed." 503' > "$STATE/caddy/etc/site/upstream.caddy"
    changed=0
    # REDIRECT_HOSTS (deploy.env): names that only forward to https://SITE_HOST, e.g. the bare domain and www.
    redirects=""
    for h in ${REDIRECT_HOSTS:-}; do
      [[ "$h" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "REDIRECT_HOSTS: '$h' is not a lower-case host name"
      [[ "$h" != "$SITE_HOST" ]] || die "REDIRECT_HOSTS must not include SITE_HOST ($SITE_HOST)"
      redirects+="${redirects:+, }$h"
    done
    if [[ -n "$redirects" ]]; then
      printf '%s {\n\tredir https://%s{uri} permanent\n}\n' "$redirects" "$SITE_HOST" > "$STATE/caddy/etc/site/redirects.caddy.new"
    else
      : > "$STATE/caddy/etc/site/redirects.caddy.new"
    fi
    if cmp -s "$STATE/caddy/etc/site/redirects.caddy.new" "$STATE/caddy/etc/site/redirects.caddy"; then rm -f "$STATE/caddy/etc/site/redirects.caddy.new"
    else mv "$STATE/caddy/etc/site/redirects.caddy.new" "$STATE/caddy/etc/site/redirects.caddy"; changed=1; fi
    cmp -s "$HERE/Caddyfile" "$STATE/caddy/etc/Caddyfile" || { cp "$HERE/Caddyfile" "$STATE/caddy/etc/Caddyfile.new" && mv "$STATE/caddy/etc/Caddyfile.new" "$STATE/caddy/etc/Caddyfile"; changed=1; }
    edge up -d --remove-orphans
    # A new Caddyfile on a running Caddy: applied gracefully.
    if (( changed )) && [[ -n "$(edge ps -q caddy)" ]]; then sleep 2; caddy_reload; fi
    ;;
  release)
    need_tag "$ARG"
    mark_deploying
    for image in api migrate web; do docker image inspect "nurseapp/$image:$ARG" >/dev/null 2>&1 || die "nurseapp/$image:$ARG is not loaded (deploy.sh load)"; done
    mkdir -p "$STATE/storage" && chown 1000:1000 "$STATE/storage"   # the node user in the api image
    "$0" edge
    read -r live_color live_tag <<< "$(read_state ACTIVE)"
    migrate "$ARG"
    next="$( [[ -n "${live_color:-}" ]] && other "$live_color" || echo blue )"
    promote "$next" "$ARG" "${live_color:-}"
    # The same tag again (restart, a re-run deploy) is not a new release: PREVIOUS keeps
    # the release before it, so a rollback still has somewhere to go.
    [[ -n "${live_color:-}" && "${live_tag:-}" != "$ARG" ]] && echo "$live_color $live_tag" > "$STATE/PREVIOUS"
    echo "$next $ARG" > "$STATE/ACTIVE"
    log "release $ARG is live on $next"
    read -r _ prev_tag <<< "$(read_state PREVIOUS)"
    prune_images "$ARG" "${prev_tag:-}"
    ;;
  rollback)
    mark_deploying
    read -r prev_color prev_tag <<< "$(read_state PREVIOUS)"
    read -r live_color live_tag <<< "$(read_state ACTIVE)"
    [[ -n "${prev_color:-}" ]] || die "no previous release recorded"
    [[ "$prev_tag" != "$live_tag" ]] || die "the previous release is the live one ($live_tag): nothing to roll back to"
    # Always the colour that is not live: after a restart PREVIOUS may name the live colour.
    target="$(other "$live_color")"
    log "rolling back to $prev_tag on $target (the database schema is NOT rolled back)"
    promote "$target" "$prev_tag" "$live_color"
    echo "$live_color $live_tag" > "$STATE/PREVIOUS"
    echo "$target $prev_tag" > "$STATE/ACTIVE"
    log "release $prev_tag is live on $target"
    ;;
  restart)
    read -r live_color live_tag <<< "$(read_state ACTIVE)"
    [[ -n "${live_color:-}" ]] || die "no release is live yet"
    exec "$0" release "$live_tag"
    ;;
  status)
    echo "live: $(read_state ACTIVE || true)   previous: $(read_state PREVIOUS || true)"
    docker ps --filter "label=com.docker.compose.project" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E 'NAMES|nurseapp' || true
    ;;
  bootstrap)
    read -r live_color live_tag <<< "$(read_state ACTIVE)"
    [[ -n "${live_color:-}" ]] || die "no release is live yet"
    app "$live_color" "$live_tag" exec api node dist/cli/bootstrap.js
    ;;
  psql)
    exec "${PSQL[@]}" -d "$DB_NAME"
    ;;
  exit-package)
    # Personal data in clear: the ZIP streams from the API container straight into
    # gpg (the backup PUBLIC key); no plaintext copy is ever written on the VPS.
    (( ${#ARG} >= 10 )) || die 'usage: deploy.sh exit-package "<reason, at least 10 characters>"'
    pub="$CONF/backup.pub"
    [[ -f "$pub" ]] || die "$pub is missing — run setup-backup.sh first (README.md §5)"
    read -r live_color live_tag <<< "$(read_state ACTIVE)"
    [[ -n "${live_color:-}" ]] || die "no release is live yet"
    install -d -m 700 "$STATE/exit"
    out="$STATE/exit/aigh-exit-package-$(date -u +%Y%m%dT%H%M%SZ).zip.gpg"
    gnupg="$(mktemp -d)"   # a throw-away keyring: nothing is added to root's
    trap 'rm -rf "$gnupg"; rm -f "$out.part"' EXIT
    log "writing the exit package, encrypted to $(gpg --homedir "$gnupg" --show-keys --with-colons "$pub" | awk -F: '/^fpr/ {print $10; exit}')"
    app "$live_color" "$live_tag" exec -T api node dist/cli/exit-package.js --reason "$ARG" --out - \
      | gpg --batch --quiet --homedir "$gnupg" --trust-model always --recipient-file "$pub" --encrypt --output "$out.part"
    mv "$out.part" "$out" && chmod 600 "$out"
    log "done: $out ($(du -h "$out" | cut -f1)); only the holder of the backup PRIVATE key can open it"
    ;;
  *)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
