#!/bin/bash
# =============================================================================
# deploy-admin.sh — 构建管理后台前端（已废弃独立部署步骤）
#
# 迁移后 Nginx 将 /admin/ 指向仓库内 admin/dist/，构建完成即生效，无需 rsync。
# 生产必须使用 Vite base `/admin/`（见 admin/vite.config.ts）；双域名合并步骤见
# docs/guides/single-domain-nginx-migration.md。
#
# 用法：
#   ./deploy-admin.sh
#
# 说明：部署后无需重启服务，刷新页面生效。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ADMIN_DIR="$PROJECT_DIR/admin"

echo "==> 构建管理后台（npm run build）..."
cd "$ADMIN_DIR"
npm run build

DIST_ASSETS="$ADMIN_DIR/dist/assets"
if [ ! -d "$DIST_ASSETS" ] || [ -z "$(ls -A "$DIST_ASSETS")" ]; then
  echo "错误：构建产物 $DIST_ASSETS 不存在或为空" >&2
  exit 1
fi

echo "构建完成：$ADMIN_DIR/dist/（Nginx 已指向此目录，刷新页面生效）"
