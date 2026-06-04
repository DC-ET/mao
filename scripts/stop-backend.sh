#!/bin/bash
# 停止后端服务

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "停止后端服务..."
if [ -f "$PROJECT_DIR/.backend.pid" ]; then
    PID=$(cat "$PROJECT_DIR/.backend.pid")
    if kill -0 "$PID" 2>/dev/null; then
        kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
        echo "  已停止 (PID: $PID)"
    else
        echo "  进程已不存在"
    fi
    rm -f "$PROJECT_DIR/.backend.pid"
else
    echo "  未找到 PID 文件，尝试按端口停止..."
    lsof -ti :9080 | xargs kill 2>/dev/null
fi
