#!/bin/bash
# Restart the TypeScript backend (Node on 9081). Used by GET /v1/admin/runtime/restart.
# Deploy this file to ${app.root-dir}/backend-ts/restart.sh (default /opt/mao/backend-ts/restart.sh).

set -euo pipefail

APP_NAME="mao-server-ts"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${APP_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a
fi
PID_FILE="${APP_DIR}/mao-server-ts.pid"
LOG_DIR="${MAO_LOG_DIR:-${APP_DIR}/logs}"
LOG_FILE="${LOG_DIR}/backend-ts.log"
PORT="${MAO_TS_PORT:-9081}"

mkdir -p "$LOG_DIR"

rotate_log() {
    if [ -f "$LOG_FILE" ]; then
        local size
        size=$(stat -c%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
        local max_bytes=$((100 * 1024 * 1024))
        if [ "$size" -gt "$max_bytes" ] 2>/dev/null; then
            mv "$LOG_FILE" "$LOG_FILE.$(date +%Y%m%d%H%M%S)"
            ls -t "$LOG_FILE".* 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
        fi
    fi
}

stop() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping $APP_NAME (PID: $PID)..."
            kill "$PID" 2>/dev/null || true
            sleep 2
            kill -9 "$PID" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
    fi
    if command -v lsof >/dev/null 2>&1; then
        lsof -ti ":$PORT" | xargs kill 2>/dev/null || true
    fi
}

start() {
    echo "Starting $APP_NAME on $PORT..."
    rotate_log
    cd "$APP_DIR"
    if [ -f dist/main.js ]; then
        nohup node dist/main.js >> "$LOG_FILE" 2>&1 &
    else
        nohup npx tsx src/main.ts >> "$LOG_FILE" 2>&1 &
    fi
    echo $! > "$PID_FILE"
    echo "Started (PID: $(cat "$PID_FILE"))"
    echo "Log: tail -f $LOG_FILE"
}

stop
start
