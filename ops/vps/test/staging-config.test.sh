#!/usr/bin/env bash
# Configuration must fail closed before building images or contacting a server.
set -euo pipefail
cd "$(dirname "$0")/../../.."
check=ops/vps/check-staging-config.sh
run() { env -i PATH="$PATH" bash "$check" "$@"; }
if run >/dev/null 2>&1; then echo 'FAIL: missing settings accepted'; exit 1; fi
if env -i PATH="$PATH" VPS_HOST=production.example.test APP_URL=https://production.example.test VPS_SSH_KEY=test VPS_KNOWN_HOSTS=test bash "$check" >/dev/null 2>&1; then echo 'FAIL: production settings accepted for staging'; exit 1; fi
for setting in STAGING_VPS_HOST STAGING_APP_URL STAGING_VPS_SSH_KEY STAGING_VPS_KNOWN_HOSTS; do
  if (
    export STAGING_VPS_HOST=stage.example.test STAGING_APP_URL=https://stage.example.test STAGING_VPS_SSH_KEY=test STAGING_VPS_KNOWN_HOSTS=test
    unset "$setting"
    bash "$check"
  ) >/dev/null 2>&1; then echo "FAIL: missing $setting accepted"; exit 1; fi
done
valid() { env -i PATH="$PATH" STAGING_VPS_HOST="${1}" STAGING_APP_URL="${2}" STAGING_VPS_SSH_KEY=test STAGING_VPS_KNOWN_HOSTS=test bash "$check"; }
valid stage.example.test https://stage.example.test
valid 192.0.2.10 https://stage.example.test:8443/
for pair in 'bad@host https://stage.example.test' 'stage.example.test http://stage.example.test' 'stage.example.test https://user:pass@stage.example.test' 'stage.example.test https://stage.example.test/path'; do
  read -r host url <<< "$pair"
  if valid "$host" "$url" >/dev/null 2>&1; then echo "FAIL: invalid staging destination accepted"; exit 1; fi
done
echo 'Staging configuration checks passed'
