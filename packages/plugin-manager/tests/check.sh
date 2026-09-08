#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
for script in "${ROOT}/build.sh" "${ROOT}/test-report.sh" "${ROOT}/deploy/"*.sh "${ROOT}/deploy/scripts/"*.sh "${ROOT}/packages/plugin-manager/runtime/"*.sh; do
    [ ! -f "$script" ] || bash -n "$script"
done
for script in "${ROOT}/deploy/scripts/"*.mjs "${ROOT}/packages/plugin-manager/runtime/"*.mjs; do
    [ ! -f "$script" ] || node --check "$script"
done
node --test "${ROOT}/packages/plugin-manager/tests/"*.test.mjs
printf '%s\n' '部署路径、安装恢复与可选宿主检查通过。'
