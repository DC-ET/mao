#!/bin/bash
# 停止所有服务

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

echo "停止管理后台..."
if [ -f "$PROJECT_DIR/.admin.pid" ]; then
    PID=$(cat "$PROJECT_DIR/.admin.pid")
    if kill -0 "$PID" 2>/dev/null; then
        kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
        echo "  已停止 (PID: $PID)"
    else
        echo "  进程已不存在"
    fi
    rm -f "$PROJECT_DIR/.admin.pid"
else
    echo "  未找到 PID 文件，尝试按端口停止..."
    lsof -ti :5200 | xargs kill 2>/dev/null
fi

echo "停止桌面客户端..."
if [ -f "$PROJECT_DIR/.desktop.pid" ]; then
    PID=$(cat "$PROJECT_DIR/.desktop.pid")
    if kill -0 "$PID" 2>/dev/null; then
        kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
        echo "  已停止 (PID: $PID)"
    else
        echo "  进程已不存在"
    fi
    rm -f "$PROJECT_DIR/.desktop.pid"
else
    echo "  未找到 PID 文件，尝试按端口停止..."
    lsof -ti :5201 | xargs kill 2>/dev/null
    pkill -f "electron.*desktop" 2>/dev/null
fi

echo "所有服务已停止"
