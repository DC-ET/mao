#!/bin/bash
# =============================================================================
# deploy-admin.sh — 构建并部署管理后台前端
#
# 与 deploy-desktop.sh 同理：改用 rsync --delete 同步 assets 子目录，
# 仅保留当前版本资产，避免 `cp -r dist/*` 只增不删造成的历史文件堆积。
#
# 用法：
#   ./deploy-admin.sh            # 构建并部署
#   ./deploy-admin.sh --dry-run  # 仅预览将同步/删除哪些文件，不实际修改
#
# 部署目标（可用环境变量覆盖）：
#   DEPLOY_DIR=/root/soft/mao/admin
#
# 说明：部署后无需重启服务，刷新页面生效。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ADMIN_DIR="$PROJECT_DIR/admin"
DEPLOY_DIR="${DEPLOY_DIR:-/root/soft/mao/admin}"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# ---- 1. 构建 ----
echo "==> [1/3] 构建管理后台（npm run build）..."
cd "$ADMIN_DIR"
npm run build

DIST_ASSETS="$ADMIN_DIR/dist/assets"
# 安全防护：dist/assets 不存在或为空时中止，避免误清空线上资源
if [ ! -d "$DIST_ASSETS" ] || [ -z "$(ls -A "$DIST_ASSETS")" ]; then
  echo "错误：构建产物 $DIST_ASSETS 不存在或为空，中止部署" >&2
  exit 1
fi

# ---- 2. 同步 assets（--delete 清理历史构建文件）----
echo "==> [2/3] 同步 assets 到 $DEPLOY_DIR/assets/（rsync --delete 清理历史文件）..."
if [ "$DRY_RUN" = true ]; then
  rsync -a --delete --dry-run -v "$DIST_ASSETS/" "$DEPLOY_DIR/assets/"
else
  rsync -a --delete "$DIST_ASSETS/" "$DEPLOY_DIR/assets/"
fi

# ---- 3. 复制其余文件（index.html / 图标等）----
echo "==> [3/3] 覆盖复制其余文件..."
if [ "$DRY_RUN" = true ]; then
  for f in "$ADMIN_DIR"/dist/*; do
    [ "$(basename "$f")" = "assets" ] && continue
    echo "  -> $(basename "$f")"
  done
else
  for f in "$ADMIN_DIR"/dist/*; do
    [ "$(basename "$f")" = "assets" ] && continue
    cp -rf "$f" "$DEPLOY_DIR/"
  done
fi

if [ "$DRY_RUN" = true ]; then
  echo "dry-run 完成，未做任何实际修改。"
else
  echo "部署完成：$DEPLOY_DIR（无需重启服务，刷新页面生效）"
fi
