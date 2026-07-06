#!/bin/bash
# 启动管理后台 (后台运行)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.admin.pid"
LOG_DIR="$HOME/.mao/logs"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "管理后台已在运行 (PID: $(cat "$PID_FILE"))"
    exit 0
fi

echo "启动管理后台..."
cd "$PROJECT_DIR/admin"
nohup npm run dev > "$LOG_DIR/admin.out" 2>&1 &
echo $! > "$PID_FILE"
echo "管理后台已启动 (PID: $!, 日志: $LOG_DIR/admin.out)"
