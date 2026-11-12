#!/bin/bash
# 把 changelog/unreleased/*.md 合成下一个版本。见 changelog-cut.mjs --help。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/changelog-cut.cjs" "$@"
