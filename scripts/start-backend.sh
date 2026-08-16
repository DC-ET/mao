#!/bin/bash
# 启动后端服务 (TypeScript, 后台运行，关闭终端不影响)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.backend.pid"
LOG_DIR="$HOME/.mao/logs"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "后端服务已在运行 (PID: $(cat "$PID_FILE"))"
    exit 0
fi

echo "启动 TypeScript 后端 (9080)..."
cd "$PROJECT_DIR/backend-ts"
if [ -f .env ]; then
    set -a
    # shellcheck source=/dev/null
    source .env
    set +a
fi
export MAO_TS_PORT="${MAO_TS_PORT:-9080}"
nohup npm run start:dev > "$LOG_DIR/backend.out" 2>&1 &
echo $! > "$PID_FILE"
echo "后端服务已启动 (PID: $!, 日志: $LOG_DIR/backend.out)"
