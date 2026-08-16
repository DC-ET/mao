#!/bin/bash
# 停止后端服务

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.backend.pid"

echo "停止后端服务..."
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
    echo "  未找到 PID 文件，尝试按端口 9080 停止..."
    lsof -ti :9080 | xargs kill 2>/dev/null || true
fi
