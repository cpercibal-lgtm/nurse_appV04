#!/bin/bash
# Local proof of the VPS release path (decision D-57) — no VPS needed:
#   TAG=ci ops/vps/test/run.sh      (images already built as nurseapp/{api,migrate,web}:ci)
#
# Stands in for the VPS with Docker: a PostgreSQL 15 container plays the host
# database (the real VPS runs it on the host, reached the same way as
# db.host), Caddy issues a certificate from its own local CA instead of
# Let's Encrypt. Then, while a client polls the site over HTTPS every 0.2 s:
#   0. db-init.sh creates the database, the four roles and the settings files
#   1. first release  → blue (deploy.sh)
#   2. second release → green, as GitHub Actions does it: a bundle through
#      nurseapp-release (the deploy key's only command) — blue/green switch
#   3. rollback       → blue
#   4. restart (after a settings change) → green
#   5. monitoring: monitor.sh alerts by e-mail when the site goes down and
#      when it recovers; verify-install.sh passes the checks that apply here
#   6. the exit package: encrypted to a test key, opened with its private key,
#      manifest checked
# and fails if any request failed, a colour was left running, or the roles
# check did not pass. Leaves nothing running.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export TAG="${TAG:-ci}"
for image in api migrate web; do docker image inspect "nurseapp/$image:$TAG" >/dev/null || { echo "build nurseapp/$image:$TAG first" >&2; exit 1; }; done

WORK="$(mktemp -d)"; CONF="$WORK/conf"; STATE="$WORK/state"; mkdir -p "$CONF" "$STATE"
DB=nurseapp-vpstest-db; HOST=nurse.vps.test; DBPW="$(openssl rand -hex 16)"
POLL_PID=""
cleanup() {
  local code=$?
  if [[ -n "$POLL_PID" ]]; then kill "$POLL_PID" 2>/dev/null || true; fi
  if (( code != 0 )); then
    for p in nurseapp-blue nurseapp-green nurseapp-edge; do docker compose -p "$p" logs --no-color --tail=40 2>/dev/null >&2 || true; done
  fi
  for c in blue green; do COLOR=$c TAG=$TAG NURSEAPP_CONF="$CONF" NURSEAPP_STATE="$STATE" docker compose -f "$HERE/docker-compose.app.yml" down -v >/dev/null 2>&1 || true; done
  SITE_HOST=$HOST ACME_EMAIL=x@x.test NURSEAPP_STATE="$STATE" docker compose -f "$HERE/docker-compose.edge.yml" down -v >/dev/null 2>&1 || true
  docker rm -f "$DB" nurseapp-vpstest-mail >/dev/null 2>&1 || true
  docker network rm nurseapp >/dev/null 2>&1 || true
  docker run --rm -v "$WORK:/w" alpine:3.20 rm -rf /w/state >/dev/null 2>&1 || true   # files written by containers as root
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT
for image in api migrate web; do docker rmi "nurseapp/$image:0123abc" >/dev/null 2>&1 || true; done

echo "== the VPS stand-in: network, PostgreSQL 15"
docker network create --subnet 172.30.0.0/24 --ip-range 172.30.0.128/25 nurseapp >/dev/null
docker run -d --name "$DB" --network nurseapp --ip 172.30.0.50 -e POSTGRES_PASSWORD="$DBPW" postgres:15-alpine >/dev/null
until docker exec "$DB" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
sleep 2

echo "== 0. db-init.sh"
NURSEAPP_CONF="$CONF" DB_SUPERUSER_PSQL="docker exec -i $DB psql -U postgres" \
  SITE_HOST=$HOST ACME_EMAIL=ops@$HOST DATA_RESIDENCY_REGION=ksa-vps "$HERE/db-init.sh"
for f in app.env migrate.env deploy.env; do [[ "$(stat -c %a "$CONF/$f")" == 600 ]] || { echo "$f is not 0600" >&2; exit 1; }; done
if NURSEAPP_CONF="$CONF" DB_SUPERUSER_PSQL="docker exec -i $DB psql -U postgres" SITE_HOST=$HOST ACME_EMAIL=x DATA_RESIDENCY_REGION=ksa-vps "$HERE/db-init.sh" 2>/dev/null; then
  echo "db-init.sh overwrote existing settings" >&2; exit 1
fi
cat >> "$CONF/deploy.env" <<ENV
CADDY_GLOBAL_EXTRA=local_certs
DB_HOST_IP=172.30.0.50
DB_SUPERUSER_PSQL="docker exec -i $DB psql -U postgres"
CURL_INSECURE=1
DRAIN_SECONDS=3
ENV
export NURSEAPP_CONF="$CONF" NURSEAPP_STATE="$STATE"
DEPLOY="$HERE/deploy.sh"

live() { cut -d' ' -f1 "$STATE/ACTIVE"; }
running() { docker ps -q --filter "label=com.docker.compose.project=nurseapp-$1" | wc -l; }
fetch() { curl -fsS -k --noproxy '*' --max-time 5 --resolve "$HOST:443:127.0.0.1" "https://$HOST$1"; }

echo "== 1. first release (blue)"
"$DEPLOY" release "$TAG"
[[ "$(live)" == blue ]] || { echo "expected blue live" >&2; exit 1; }
fetch /api/v1/health | grep -q '"database":"up"'
fetch / | grep -q '<div id="root">'
curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --resolve "$HOST:80:127.0.0.1" "http://$HOST/" | grep -q '30[18]'   # HTTP → HTTPS
curl -sk --noproxy '*' -D - -o /dev/null --resolve "$HOST:443:127.0.0.1" "https://$HOST/" | grep -qi '^strict-transport-security'

echo "== polling https://$HOST every 0.2 s during the next releases"
( fails=0; ok=0
  while [[ ! -f "$WORK/stop" ]]; do
    if fetch /api/v1/health >/dev/null 2>&1; then ok=$((ok+1)); else fails=$((fails+1)); echo "failed request at $(date -u +%T.%N)" >&2; fi
    sleep 0.2
  done
  echo "$ok $fails" > "$WORK/poll" ) &
POLL_PID=$!

echo "== 2. second release (green) through nurseapp-release, from a bundle — blue/green switch"
SHA=0123abc
for image in api migrate web; do docker tag "nurseapp/$image:$TAG" "nurseapp/$image:$SHA"; done
mkdir -p "$WORK/bundle/ops" "$WORK/opt"
cp -r "$ROOT/ops/vps" "$ROOT/ops/db" "$ROOT/ops/backup" "$WORK/bundle/ops/"   # what the workflow ships
docker save "nurseapp/api:$SHA" "nurseapp/migrate:$SHA" "nurseapp/web:$SHA" | gzip -1 > "$WORK/bundle/images.tar.gz"
for image in api migrate web; do docker rmi "nurseapp/$image:$SHA" >/dev/null; done   # must come from the bundle
tar -cf "$WORK/bundle.tar" -C "$WORK/bundle" ops images.tar.gz
tar -cf "$WORK/evil.tar" -C "$WORK/bundle" ops/vps/deploy.sh && tar -rf "$WORK/evil.tar" -C / etc/hostname
release_dirs() { compgen -G '/var/tmp/nurseapp-release.*' | sort || true; }
before="$(release_dirs)"
if NURSEAPP_OPS="$WORK/opt" "$HERE/nurseapp-release" release "$SHA" < "$WORK/evil.tar" 2>/dev/null; then echo "a bundle with a foreign path was accepted" >&2; exit 1; fi
if NURSEAPP_OPS="$WORK/opt" "$HERE/nurseapp-release" "release;id" < /dev/null 2>/dev/null; then echo "a bad command was accepted" >&2; exit 1; fi
NURSEAPP_OPS="$WORK/opt" "$HERE/nurseapp-release" release "$SHA" < "$WORK/bundle.tar"
[[ "$(release_dirs)" == "$before" ]] || { echo "nurseapp-release left its work folder in /var/tmp" >&2; exit 1; }
# PostgreSQL runs the backup kit as postgres: the released scripts must be readable by others.
for p in "$WORK/opt" "$WORK/opt/backup/scripts" "$WORK/opt/backup/scripts/wal-archive.sh"; do
  [[ "$(stat -c %a "$p")" == 755 ]] || { echo "released $p is not readable by the postgres user" >&2; exit 1; }
done
[[ "$(live)" == green ]] || { echo "expected green live" >&2; exit 1; }
(( $(running blue) == 0 )) || { echo "blue still running after the switch" >&2; exit 1; }
(( $(running green) == 3 )) || { echo "green is not api + worker + web" >&2; exit 1; }

echo "== 3. rollback (blue)"
"$DEPLOY" rollback
[[ "$(live)" == blue ]] || { echo "expected blue after rollback" >&2; exit 1; }
(( $(running green) == 0 )) || { echo "green still running after the rollback" >&2; exit 1; }

echo "== 4. restart (settings changed): the live release again, in the other colour"
echo "LOGIN_THROTTLE_MAX_PER_CLIENT=25" >> "$CONF/app.env"
"$DEPLOY" restart
[[ "$(live)" == green ]] || { echo "expected green after restart" >&2; exit 1; }
[[ ! -e "$STATE/DEPLOYING" ]] || { echo "the deploy marker was left behind after the restart" >&2; exit 1; }
# A restart is the same release again: the rollback target (and its images) must survive it.
[[ "$(cut -d' ' -f2 "$STATE/PREVIOUS")" == "$SHA" ]] || { echo "restart overwrote the previous release: $(cat "$STATE/PREVIOUS")" >&2; exit 1; }
for image in api migrate web; do docker image inspect "nurseapp/$image:$SHA" >/dev/null || { echo "restart removed the previous release's $image image" >&2; exit 1; }; done

touch "$WORK/stop"; wait "$POLL_PID"; POLL_PID=""
read -r ok fails < "$WORK/poll"
echo "requests during three switches: $ok ok, $fails failed"
(( fails == 0 && ok > 20 )) || { echo "requests failed during a switch" >&2; exit 1; }
echo "== 5. monitoring: alerts on failure and recovery; installation check"
docker run -d --name nurseapp-vpstest-mail --network nurseapp --ip 172.30.0.60 axllent/mailpit:v1.21 >/dev/null
cat > "$CONF/monitor.env" <<ENV
ALERT_EMAILS=oncall@$HOST
SMTP_HOST=172.30.0.60
SMTP_PORT=1025
SMTP_FROM=NurseApp monitor <monitor@$HOST>
ALERT_SMTP_STARTTLS=0
ENV
chmod 600 "$CONF/monitor.env"
export CERT_WARN_DAYS=0 CERT_FAIL_DAYS=0   # Caddy's local test CA issues 12-hour certificates
MON=("$HERE/monitor.sh" --notify --only "site,containers,database,disk,cert")
# The host running this test is not the VPS stand-in. In CI, Docker images and
# browser dependencies can fill the runner disk, so make the simulated VPS
# disk usage deterministic without changing monitor.sh or the production check.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/df" <<'DF'
#!/bin/sh
if [ "$1" = "--output=pcent" ]; then
  printf 'Use%%\n 20%%\n'
else
  exec /usr/bin/df "$@"
fi
DF
chmod +x "$WORK/bin/df"
run_mon() { PATH="$WORK/bin:$PATH" "${MON[@]}"; }
mails() { curl -s --noproxy '*' http://172.30.0.60:8025/api/v1/messages | jq -r '.messages[].Subject'; }
until curl -s --noproxy '*' -o /dev/null http://172.30.0.60:8025/api/v1/messages; do sleep 1; done
"$HERE/monitor.sh" --test-alert >/dev/null || { echo "monitor --test-alert failed" >&2; exit 1; }
mails | grep -q "TEST alert" || { echo "no TEST alert e-mail: $(mails)" >&2; exit 1; }
curl -s --noproxy '*' -X DELETE http://172.30.0.60:8025/api/v1/messages >/dev/null   # the checks below count alerts from zero
run_mon || { echo "monitor: expected all checks to pass" >&2; exit 1; }
[[ -z "$(mails)" ]] || { echo "monitor sent an alert while everything passed" >&2; exit 1; }
docker stop nurseapp-edge-caddy-1 >/dev/null
if run_mon; then echo "monitor: the site is down but every check passed" >&2; exit 1; fi
mails | grep -q "FAILING: site" || { echo "no FAILING alert e-mail: $(mails)" >&2; exit 1; }
run_mon >/dev/null || true
(( $(mails | grep -c "FAILING: site") == 1 )) || { echo "the same failure was alerted twice within 6 hours" >&2; exit 1; }
docker start nurseapp-edge-caddy-1 >/dev/null
until fetch /api/v1/health >/dev/null 2>&1; do sleep 1; done
run_mon || { echo "monitor: expected recovery" >&2; exit 1; }
mails | grep -q "RECOVERED: site" || { echo "no RECOVERED alert e-mail: $(mails)" >&2; exit 1; }
echo "alert e-mails: $(mails | tr '\n' ';')"
OUT="$("$HERE/verify-install.sh" --only settings,roles,https,containers,site,admins)" || { echo "$OUT" >&2; echo "verify-install.sh failed" >&2; exit 1; }
echo "$OUT"
grep -q "WARN  admins" <<< "$OUT" || { echo "verify-install.sh did not flag the missing administrators" >&2; exit 1; }

echo "== 6. exit package (spec §14.3): streamed from the API into gpg; opens only with the private key"
PRIV="$WORK/gpg-private"; install -d -m 700 "$PRIV"
gpg --batch --quiet --homedir "$PRIV" --passphrase '' --pinentry-mode loopback --quick-gen-key 'Exit Test <exit@vps.test>' default default never
gpg --batch --quiet --homedir "$PRIV" --armor --export exit@vps.test > "$CONF/backup.pub"
"$DEPLOY" exit-package "Harness: the hospital moves to another provider"
pkg="$(ls "$STATE"/exit/*.zip.gpg)"
[[ "$(stat -c %a "$pkg")" == 600 ]] || { echo "the exit package is not 0600" >&2; exit 1; }
if ls "$STATE"/exit/*.part >/dev/null 2>&1 || ls "$STATE"/exit/*.zip >/dev/null 2>&1; then echo "a plaintext or partial package was left behind" >&2; exit 1; fi
gpg --batch --quiet --homedir "$PRIV" --decrypt "$pkg" > "$WORK/exit.zip"
[[ "$(head -c 4 "$WORK/exit.zip" | od -An -c | tr -d ' ')" == 'PK003004' ]] || { echo "the decrypted package is not a ZIP from its first byte" >&2; exit 1; }
unzip -q "$WORK/exit.zip" -d "$WORK/exit"
(cd "$WORK/exit" && sha256sum --quiet -c MANIFEST.sha256) || { echo "the exit package manifest does not check" >&2; exit 1; }
grep -q "PERSONAL DATA IN CLEAR" "$WORK/exit/README.txt" || { echo "the exit package README is missing its warning" >&2; exit 1; }
if "$DEPLOY" exit-package "short" 2>/dev/null; then echo "exit-package accepted a reason under 10 characters" >&2; exit 1; fi
echo "exit package: $(du -h "$pkg" | cut -f1), $(unzip -Z1 "$WORK/exit.zip" | wc -l) entries"

"$DEPLOY" status
echo "ALL PASSED"
