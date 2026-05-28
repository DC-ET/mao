#!/bin/bash
# 重启管理后台

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "停止管理后台..."
if [ -f "$PROJECT_DIR/.admin.pid" ]; then
    PID=$(cat "$PROJECT_DIR/.admin.pid")
    kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
    rm -f "$PROJECT_DIR/.admin.pid"
else
    lsof -ti :5200 | xargs kill 2>/dev/null
fi
sleep 2

bash "$SCRIPT_DIR/start-admin.sh"
