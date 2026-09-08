#!/bin/sh
# 根入口仅定位仓库并转发；测试与报告复用现有运行器。
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$ROOT/scripts/test-report.mjs" --root "$ROOT" "$@"
