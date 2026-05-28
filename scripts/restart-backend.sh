#!/bin/bash
# 重启后端服务

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "停止后端服务..."
if [ -f "$PROJECT_DIR/.backend.pid" ]; then
    PID=$(cat "$PROJECT_DIR/.backend.pid")
    kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
    rm -f "$PROJECT_DIR/.backend.pid"
else
    lsof -ti :9080 | xargs kill 2>/dev/null
fi
sleep 2

bash "$SCRIPT_DIR/start-backend.sh"
