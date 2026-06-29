#!/bin/bash
# 启动桌面客户端 (后台运行)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.desktop.pid"
LOG_DIR="/data/logs/mao"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "桌面客户端已在运行 (PID: $(cat "$PID_FILE"))"
    exit 0
fi

echo "启动桌面客户端..."
cd "$PROJECT_DIR/desktop"
nohup npm run dev:electron > "$LOG_DIR/desktop.out" 2>&1 &
echo $! > "$PID_FILE"
echo "桌面客户端已启动 (PID: $!, 日志: $LOG_DIR/desktop.out)"
