#!/bin/sh
# Private source updates are separate from the upstream framework's build entry.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "${1:-}" in
  --help) ;;
  ''|release|--*)
    for command in node git flock; do
      command -v "$command" >/dev/null || { printf 'Missing prerequisite: %s. See PRIVATE.md.\n' "$command" >&2; exit 1; }
    done
    mkdir -p "$ROOT/.local"
    flock -n "$ROOT/.local/source-release.lock" node "$ROOT/private-deploy/sync-origin.mjs" "$@"
    ;;
esac
# The framework acquires the same lock for its own build and deployment phase.
exec bash "$ROOT/deploy/build.sh" "$@"
