#!/bin/bash
# 开机 / systemctl start：活跃端口已健康则直接返回，否则走 restart.sh。
# 已在跑时不触发蓝绿切换，避免 enable --now 把当前实例切走。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${ROOT}/backend-ts"
export BG_LIB_PATH="${ROOT}/scripts/lib/blue-green.sh"
# shellcheck source=lib/blue-green.sh
source "$BG_LIB_PATH"

port="$(bg_read_active_port)"
if bg_port_in_use "$port"; then
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/swagger-ui.html" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ] || [ "$code" = "301" ] || [ "$code" = "302" ]; then
    echo "Mao backend already healthy on port ${port}; skip start"
    exit 0
  fi
  echo "Port ${port} is in use but unhealthy (HTTP ${code}); running blue-green restart"
else
  echo "Mao backend not listening on port ${port}; starting"
fi

export MAO_RESTART_DETACHED=1
exec "${APP_DIR}/restart.sh"
