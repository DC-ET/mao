#!/bin/bash
# 启动后端服务 (后台运行)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.backend.pid"
LOG_DIR="/data/logs/mao"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "后端服务已在运行 (PID: $(cat "$PID_FILE"))"
    exit 0
fi

echo "启动后端服务..."
cd "$PROJECT_DIR/backend"
nohup mvn spring-boot:run > "$LOG_DIR/backend.out" 2>&1 &
echo $! > "$PID_FILE"
echo "后端服务已启动 (PID: $!, 日志: $LOG_DIR/backend.out)"
