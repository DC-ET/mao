#!/bin/bash
# 蓝绿重启后端服务（生产环境走 backend-ts/restart.sh）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

exec bash "${PROJECT_DIR}/backend-ts/restart.sh"
