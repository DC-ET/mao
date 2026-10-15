#!/bin/bash
# systemctl stop：停掉 9080 与 9081 上的后端（含蓝绿切流后的备用实例）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${ROOT}/backend-ts"
export BG_LIB_PATH="${ROOT}/scripts/lib/blue-green.sh"
# shellcheck source=lib/blue-green.sh
source "$BG_LIB_PATH"

for port in "$MAO_BLUE_GREEN_PORT_A" "$MAO_BLUE_GREEN_PORT_B"; do
  pid_file="$(bg_pid_file_for_port "$APP_DIR" "$port")"
  if bg_port_in_use "$port" || [ -f "$pid_file" ]; then
    bg_stop_port "$APP_DIR" "$port"
  fi
done
echo "Mao backend stopped"
