#!/usr/bin/env bash
# Source releases are serialized; explicit management commands retain their CLI.
set -Eeuo pipefail
DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -eq 0 || "$1" == "release" || "$1" == --* ]]; then
  [[ "${1:-}" != "release" ]] || shift
  if [[ "${1:-}" == "--help" ]]; then exec node "${DEPLOY_DIR}/scripts/build.mjs" "$@"; fi
  for command in node npm git docker tar flock; do
    command -v "$command" >/dev/null || { printf 'Missing prerequisite: %s. See deploy/README.md.\n' "$command" >&2; exit 1; }
  done
  mkdir -p "${DEPLOY_DIR}/../.local"
  exec flock -n "${DEPLOY_DIR}/../.local/source-release.lock" node "${DEPLOY_DIR}/scripts/build.mjs" "$@"
fi
exec node "${DEPLOY_DIR}/scripts/deployment.mjs" "$@"
