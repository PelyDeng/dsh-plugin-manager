#!/bin/sh
# Keep the Linux compatibility lock across private sync and the framework worker.
# Use deploy/build.sh when only the current checkout should be built without Git sync.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v node >/dev/null || { printf 'Missing prerequisite: Node.js. See PRIVATE.md.\n' >&2; exit 1; }
HELP=false
for argument in "$@"; do [ "$argument" != '--help' ] || HELP=true; done
case "${1:-}" in
  ''|release|--*)
    if [ "$HELP" = false ] && command -v flock >/dev/null; then
      mkdir -p "$ROOT/.local"
      exec flock -n "$ROOT/.local/source-release.lock" node "$ROOT/private-deploy/release.mjs" "$@"
    fi
    ;;
esac
exec node "$ROOT/private-deploy/release.mjs" "$@"
