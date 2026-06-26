#!/bin/bash
# 重启所有服务

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "===== 重启 Mao ====="
echo ""

bash "$SCRIPT_DIR/stop-all.sh"
sleep 2
echo ""
bash "$SCRIPT_DIR/start-all.sh"
