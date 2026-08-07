#!/bin/bash
# =============================================================================
# deploy-desktop.sh — 构建并部署桌面端前端（Web / Electron / 安卓共用）
#
# 解决历史问题：此前 `cp -r dist/*` 只增不删，导致 /root/soft/mao/desktop/assets/
# 堆积数百个历史构建文件（曾达 3.4k 个 / 730MB）。本脚本改用 rsync --delete
# 同步 assets 子目录，仅保留当前版本资产；其余文件（index.html / version.json /
# 图标等）覆盖复制。目标目录独有文件（如 app-icon.png）不受影响。
#
# 用法：
#   ./deploy-desktop.sh            # 构建并部署
#   ./deploy-desktop.sh --dry-run  # 仅预览将同步/删除哪些文件，不实际修改
#
# 部署目标（可用环境变量覆盖）：
#   DEPLOY_DIR=/root/soft/mao/desktop
#
# 说明：部署后无需重启服务；Web 刷新即生效，Electron / 安卓远程加载同源刷新即可。
# 注意：后端接口改动仍需重启后端服务（Agent 不代劳）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DESKTOP_DIR="$PROJECT_DIR/desktop"
DEPLOY_DIR="${DEPLOY_DIR:-/root/soft/mao/desktop}"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# ---- 1. 构建 ----
echo "==> [1/3] 构建前端（vue-tsc + vite build）..."
cd "$DESKTOP_DIR"
npm run build

DIST_ASSETS="$DESKTOP_DIR/dist/assets"
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

# ---- 3. 复制其余文件（index.html / version.json / 图标等）----
echo "==> [3/3] 覆盖复制其余文件..."
if [ "$DRY_RUN" = true ]; then
  for f in "$DESKTOP_DIR"/dist/*; do
    [ "$(basename "$f")" = "assets" ] && continue
    echo "  -> $(basename "$f")"
  done
else
  for f in "$DESKTOP_DIR"/dist/*; do
    [ "$(basename "$f")" = "assets" ] && continue
    cp -rf "$f" "$DEPLOY_DIR/"
  done
fi

if [ "$DRY_RUN" = true ]; then
  echo "dry-run 完成，未做任何实际修改。"
else
  echo "部署完成：$DEPLOY_DIR（无需重启服务，刷新页面生效）"
fi
