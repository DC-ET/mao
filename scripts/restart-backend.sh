#!/bin/bash
# 构建并蓝绿重启后端服务（生产环境走 backend-ts/restart.sh）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="${PROJECT_DIR}/backend-ts"

echo "==> 构建后端（tsc）..."
cd "$BACKEND_DIR"
npm run build

echo "==> 蓝绿重启后端..."
exec bash "${BACKEND_DIR}/restart.sh"
