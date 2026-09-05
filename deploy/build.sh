#!/usr/bin/env bash
# Public deployment entrypoint; configuration and synchronization live in Node.
set -Eeuo pipefail
DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "${DEPLOY_DIR}/scripts/deployment.mjs" "$@"
