#!/bin/bash
# 启动全部服务 (后台运行，关闭终端不影响)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "===== 启动 Mao ====="
echo ""

bash "$SCRIPT_DIR/start-backend.sh"
echo ""
bash "$SCRIPT_DIR/start-admin.sh"
echo ""
bash "$SCRIPT_DIR/start-desktop.sh"

echo ""
echo "===== 启动完成 ====="
echo "使用 stop-all.sh 停止所有服务"
echo "使用 restart-all.sh 重启所有服务"
