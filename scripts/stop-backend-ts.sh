#!/bin/bash
# Stop the TypeScript backend (does not touch the Java process on 9080).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.backend-ts.pid"

echo "停止 TypeScript 后端..."
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
        echo "  已停止 (PID: $PID)"
    else
        echo "  进程已不存在"
    fi
    rm -f "$PID_FILE"
else
    echo "  未找到 PID 文件，尝试按端口 9081 停止..."
    lsof -ti :9081 | xargs kill 2>/dev/null || true
fi
