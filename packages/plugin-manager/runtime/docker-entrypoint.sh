#!/usr/bin/env bash
# A new container owns its DSH child and uses the shared profile synchronizer.
set -Eeuo pipefail
RUNTIME_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export DSH_CLI_JS="${DSH_CLI_JS:-/opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js}"
export PLUGIN_MANIFEST_FILE="${PLUGIN_MANIFEST_FILE:-/opt/plugin-packages/manifest.json}"
export DSH_HOME="${DSH_HOME:-/data/dsh-home}"
export DSH_DATA_DIR="${DSH_DATA_DIR:-/data}"
export DSH_WORKSPACE="${DSH_WORKSPACE:-/data/workspace}"
export DSH_AUTH_URL_FILE="${DSH_AUTH_URL_FILE:-/data/dsh-web-auth-url.txt}"
exec node "${RUNTIME_DIR}/../dist/cli.mjs" container-start --root /opt/plugin-project "$@"
