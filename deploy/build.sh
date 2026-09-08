#!/usr/bin/env bash
# Keep the legacy Linux flock while Node owns the cross-platform release lock.
set -Eeuo pipefail
DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { printf 'Missing prerequisite: Node.js. See deploy/README.md.\n' >&2; exit 1; }
HELP=false
for argument in "$@"; do [[ "$argument" != "--help" ]] || HELP=true; done
if [[ ( $# -eq 0 || "$1" == "release" || "$1" == --* ) && "$HELP" == false ]] && command -v flock >/dev/null; then
  mkdir -p "${DEPLOY_DIR}/../.local"
  exec flock -n "${DEPLOY_DIR}/../.local/source-release.lock" node "${DEPLOY_DIR}/scripts/release.mjs" "$@"
fi
exec node "${DEPLOY_DIR}/scripts/release.mjs" "$@"
