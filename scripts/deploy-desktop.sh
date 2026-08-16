#!/bin/bash
# =============================================================================
# deploy-desktop.sh — 构建桌面端前端（已废弃独立部署步骤）
#
# 迁移后 Nginx root 直接指向仓库内 desktop/dist/，构建完成即生效，无需 rsync。
#
# 用法：
#   ./deploy-desktop.sh
#
# 说明：部署后无需重启服务；Web 刷新即生效，Electron / 安卓远程加载同源刷新即可。
# 注意：后端接口改动仍需重启后端服务（Agent 不代劳）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DESKTOP_DIR="$PROJECT_DIR/desktop"

echo "==> 构建前端（vue-tsc + vite build）..."
cd "$DESKTOP_DIR"
npm run build

DIST_ASSETS="$DESKTOP_DIR/dist/assets"
if [ ! -d "$DIST_ASSETS" ] || [ -z "$(ls -A "$DIST_ASSETS")" ]; then
  echo "错误：构建产物 $DIST_ASSETS 不存在或为空" >&2
  exit 1
fi

echo "构建完成：$DESKTOP_DIR/dist/（Nginx 已指向此目录，刷新页面生效）"
