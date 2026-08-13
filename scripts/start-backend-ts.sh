#!/bin/bash
# Start the TypeScript backend on 9081 (dual-run alongside Java 9080).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.backend-ts.pid"
LOG_DIR="$HOME/.mao/logs"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "TS 后端已在运行 (PID: $(cat "$PID_FILE"))"
    exit 0
fi

echo "启动 TypeScript 后端 (9081)..."
cd "$PROJECT_DIR/backend-ts"
export MAO_TS_PORT="${MAO_TS_PORT:-9081}"
nohup npm run start:dev > "$LOG_DIR/backend-ts.out" 2>&1 &
echo $! > "$PID_FILE"
echo "TS 后端已启动 (PID: $!, 日志: $LOG_DIR/backend-ts.out)"
