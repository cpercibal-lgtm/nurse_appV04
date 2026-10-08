#!/bin/bash
# HTTPS browser test of the session cookies (legacy B-03), then the smoke and
# accessibility test in Chromium, Firefox and WebKit — see README.md.
#
#   ops/e2e/run.sh              build the three release images, then test
#   TAG=ci ops/e2e/run.sh       test images already built as nurseapp/*:ci
#   E2E_BROWSERS=chromium …     the smoke test in fewer browsers
#
# Needs Docker (with compose), Node 22 and openssl. Firefox and WebKit need
# "127.0.0.1 nurse.e2e.test" in /etc/hosts (CI adds it); without it the smoke
# test runs in Chromium only. Leaves nothing running.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(cd ../.. && pwd)"

export TAG="${TAG:-e2e}"
if [[ "$TAG" == e2e ]]; then
  BUILD=(docker build -q)
  [[ -n "${BUILD_CA:-}" ]] && BUILD+=(--secret "id=ca,src=$BUILD_CA")   # TLS-inspecting proxy only
  "${BUILD[@]}" -f "$ROOT/backend/Dockerfile" --target runtime -t nurseapp/api:e2e "$ROOT" >/dev/null
  "${BUILD[@]}" -f "$ROOT/backend/Dockerfile" --target migrate -t nurseapp/migrate:e2e "$ROOT" >/dev/null
  "${BUILD[@]}" -f "$ROOT/frontend/Dockerfile" -t nurseapp/web:e2e "$ROOT" >/dev/null
fi

# Throwaway secrets and a self-signed certificate for nurse.e2e.test.
WORK="$(mktemp -d)"
export E2E_CERT_DIR="$WORK"
export E2E_DB_PASSWORD="$(openssl rand -hex 16)" E2E_JWT_SECRET="$(openssl rand -hex 32)" E2E_PASSWORD="e2e-$(openssl rand -hex 12)"
export E2E_MFA_KEY="$(openssl rand -base64 32)" E2E_DOC_KEY="$(openssl rand -base64 32)"
export E2E_FIELD_KEY="$(openssl rand -base64 32)" E2E_PEPPER="$(openssl rand -base64 32)"
# The HR authenticator set up by the session test, for the smoke test's sign-ins (deleted with $WORK).
export E2E_MFA_FILE="$WORK/hr-mfa.json"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=nurse.e2e.test" \
  -addext "subjectAltName=DNS:nurse.e2e.test" -keyout "$WORK/tls.key" -out "$WORK/tls.crt" 2>/dev/null
chmod 644 "$WORK/tls.key"   # read by nginx inside the container; deleted on exit

cleanup() {
  local code=$?
  if (( code != 0 )); then docker compose logs --no-color --tail=80 >&2 || true; fi
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT

docker compose up -d --wait --wait-timeout 300 tls
[[ -d node_modules ]] || npm ci --no-audit --no-fund
node --test --test-reporter=spec https-session.test.mjs
if [[ -z "${E2E_BROWSERS:-}" ]] && ! getent hosts nurse.e2e.test >/dev/null; then
  echo "nurse.e2e.test is not in the hosts file: smoke test in Chromium only" >&2
  export E2E_BROWSERS=chromium
fi
node --test --test-reporter=spec smoke.test.mjs
