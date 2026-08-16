#!/bin/bash
# 重启后端服务

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

bash "$SCRIPT_DIR/stop-backend.sh"
sleep 1
bash "$SCRIPT_DIR/start-backend.sh"
