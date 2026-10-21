#!/usr/bin/env bash
# Run before any build or SSH call. Only staging-specific settings are accepted.
set -euo pipefail
: "${STAGING_VPS_HOST:?Set the staging environment variable STAGING_VPS_HOST}"
: "${STAGING_APP_URL:?Set the staging environment variable STAGING_APP_URL}"
: "${STAGING_VPS_SSH_KEY:?Set the staging environment secret STAGING_VPS_SSH_KEY}"
: "${STAGING_VPS_KNOWN_HOSTS:?Set the staging environment secret STAGING_VPS_KNOWN_HOSTS}"
[[ "$STAGING_VPS_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo 'STAGING_VPS_HOST must be a hostname or IPv4 address' >&2; exit 1; }
[[ "$STAGING_APP_URL" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?/?$ ]] || { echo 'STAGING_APP_URL must be an HTTPS origin, without credentials or a path' >&2; exit 1; }
echo 'Staging destination and required settings are configured'
