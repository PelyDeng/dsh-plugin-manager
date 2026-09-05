#!/usr/bin/env bash
set -Eeuo pipefail
RUNTIME_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "${RUNTIME_DIR}/../dist/cli.mjs" sync --root /opt/plugin-project "$@"
