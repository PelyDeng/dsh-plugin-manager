#!/usr/bin/env bash
set -Eeuo pipefail
DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../deploy" && pwd)"
for script in "${DEPLOY_DIR}/build.sh" "${DEPLOY_DIR}/scripts/"*.sh "${DEPLOY_DIR}/runtime/"*.sh; do
    [ ! -f "$script" ] || bash -n "$script"
done
for script in "${DEPLOY_DIR}/runtime/"*.mjs "${DEPLOY_DIR}/scripts/"*.mjs; do
    [ ! -f "$script" ] || node --check "$script"
done
node --test "${DEPLOY_DIR}/../packages/plugin-manager/tests/"*.test.mjs
printf '%s\n' '部署路径、安装恢复与可选宿主检查通过。'
