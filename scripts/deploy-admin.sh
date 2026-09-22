#!/bin/bash
# =============================================================================
# deploy-admin.sh — 构建管理后台前端并同步到线上目录
#
# 生产 Nginx root 为 /opt/mao/admin/dist（线上 git 检出），与工作区是两套目录；
# 本脚本在工作区构建后 rsync 到线上目录，无需重启。
# 已打开的标签在点击尚未加载过的菜单时会自动整页进入新版本；若仍异常，刷新一次即可。
# 生产必须使用 Vite base `/admin/`（见 admin/vite.config.ts）。
# 双域名合并：docs/guides/single-domain-nginx-migration.md。
#
# 用法：
#   ./deploy-admin.sh [--dry-run]
#
# 说明：部署后无需重启服务。已打开的页面点击未加载菜单会自动进入新版本。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ADMIN_DIR="$PROJECT_DIR/admin"
LIVE_ADMIN_DIR="/opt/mao/admin"
DRY_RUN=""
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN="--dry-run"
fi

echo "==> 构建管理后台（npm run build）..."
cd "$ADMIN_DIR"
npm run build

DIST_ASSETS="$ADMIN_DIR/dist/assets"
if [ ! -d "$DIST_ASSETS" ] || [ -z "$(ls -A "$DIST_ASSETS")" ]; then
  echo "错误：构建产物 $DIST_ASSETS 不存在或为空" >&2
  exit 1
fi

echo "==> 同步到线上目录 $LIVE_ADMIN_DIR/dist ..."
rsync -a --delete $DRY_RUN "$ADMIN_DIR/dist/" "$LIVE_ADMIN_DIR/dist/"

echo "部署完成：$LIVE_ADMIN_DIR/dist/（已打开的页面点击未加载菜单会自动进入新版本）"
