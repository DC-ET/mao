#!/bin/bash
# Restart the TypeScript backend (does not touch the Java process on 9080).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

bash "$SCRIPT_DIR/stop-backend-ts.sh"
sleep 1
bash "$SCRIPT_DIR/start-backend-ts.sh"
