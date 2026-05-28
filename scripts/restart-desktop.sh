#!/bin/bash
# 重启桌面客户端

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "停止桌面客户端..."
if [ -f "$PROJECT_DIR/.desktop.pid" ]; then
    PID=$(cat "$PROJECT_DIR/.desktop.pid")
    kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
    rm -f "$PROJECT_DIR/.desktop.pid"
else
    lsof -ti :5201 | xargs kill 2>/dev/null
    pkill -f "electron.*desktop" 2>/dev/null
fi
sleep 2

bash "$SCRIPT_DIR/start-desktop.sh"
