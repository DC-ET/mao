#!/bin/bash
# =============================================================================
# build-apk.sh — 一键构建安卓 APK 并发布到 releases 目录
#
# 安卓壳远程加载 https://mao.etarch.cn（与 Electron 一致），不再打包 desktop 前端。
# 前端改动部署 Web 即可；仅原生壳变更时需本脚本发 APK OTA。
#
# 用法：
#   ./build-apk.sh                  # 自动从 changelog 归档提取最新版本
#   ./build-apk.sh --version 0.0.2  # 手动指定版本名（versionCode 仍自动递增）
#   ./build-apk.sh --version-code 12 # 手动指定 versionCode（必须大于目标站清单）
#   ./build-apk.sh --server-url https://mao.example.com  # 写入编译期默认站点
#   ./build-apk.sh --dry-run        # 仅构建，不发布
#
# 环境变量：
#   MAO_DEFAULT_SERVER_URL   编译期默认站点（与 --server-url 等价）
#   MAO_PUBLIC_BASE_URL      android-latest.json 的 downloadUrl 基址（默认官方）
#
# 环境要求：
#   - ANDROID_HOME 已设置
#   - MAO_KEYSTORE_PATH / MAO_KEYSTORE_PASSWORD / MAO_KEY_ALIAS / MAO_KEY_PASSWORD
#     已设置或写在 /opt/mao/keystore/keystore-credentials.env
#
# 产出：
#   - APK:   /opt/mao-data/uploads/releases/mao-android-<version>.apk
#   - JSON:  /opt/mao-data/uploads/releases/android-latest.json
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$SCRIPT_DIR"
ANDROID_APP="$ANDROID_DIR/android/app"
RELEASES_DIR="/opt/mao-data/uploads/releases"
CHANGELOG_EXTRACT="$PROJECT_ROOT/scripts/changelog-extract.sh"
CHANGELOG_FILE="$PROJECT_ROOT/CHANGELOG.md"

# ---- 参数解析 ----
DRY_RUN=false
CUSTOM_VERSION=""
CUSTOM_VERSION_CODE=""
SERVER_URL="${MAO_DEFAULT_SERVER_URL:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --version|--version-code|--server-url)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "错误：$1 缺少参数值"; exit 1
      fi
      case "$1" in
        --version) CUSTOM_VERSION="$2" ;;
        --version-code) CUSTOM_VERSION_CODE="$2" ;;
        --server-url) SERVER_URL="${2%/}" ;;
      esac
      shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

if [[ -n "$SERVER_URL" && ! "$SERVER_URL" =~ ^https?:// ]]; then
  echo "错误：--server-url 必须是 http:// 或 https:// 开头的站点根"; exit 1
fi
if [[ -n "$SERVER_URL" && "$SERVER_URL" =~ ^https?://[^/]+/.+ ]]; then
  echo "错误：--server-url 只支持站点根，不支持子路径"; exit 1
fi

PUBLIC_BASE_URL="${MAO_PUBLIC_BASE_URL:-https://mao.etarch.cn}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"
if [[ ! "$PUBLIC_BASE_URL" =~ ^https?:// ]]; then
  echo "错误：MAO_PUBLIC_BASE_URL 必须是 http:// 或 https:// 开头的站点根"; exit 1
fi
if [[ "$PUBLIC_BASE_URL" =~ ^https?://[^/]+/.+ ]]; then
  echo "错误：MAO_PUBLIC_BASE_URL 只支持站点根，不支持子路径"; exit 1
fi

# ---- 加载签名凭据 ----
CRED_FILE="/opt/mao/keystore/keystore-credentials.env"
if [ -f "$CRED_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$CRED_FILE"
  set +a
fi

# ---- 验证环境 ----
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
if [ ! -d "$ANDROID_HOME" ]; then
  echo "错误：ANDROID_HOME 不存在: $ANDROID_HOME"; exit 1
fi
# Capacitor 7.6.8 是动态配置依赖的内核版本；构建机 node_modules 必须精确匹配。
CAPACITOR_VERSION=$(node -p "require('$ANDROID_DIR/node_modules/@capacitor/android/package.json').version" 2>/dev/null || true)
if [ "$CAPACITOR_VERSION" != "7.6.8" ]; then
  echo "错误：@capacitor/android 必须是 7.6.8（当前: ${CAPACITOR_VERSION:-未安装}），请先在 android/ 执行 npm ci"; exit 1
fi
# JDK 21（Capacitor 7 Android 要求）
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"
if [ -z "${MAO_KEYSTORE_PATH:-}" ] || [ ! -f "$MAO_KEYSTORE_PATH" ]; then
  echo "错误：MAO_KEYSTORE_PATH 未设置或文件不存在"; exit 1
fi

# ---- 读取版本号 ----
if [ -n "$CUSTOM_VERSION" ]; then
  VERSION_NAME="$CUSTOM_VERSION"
else
  VERSION_NAME=$("$CHANGELOG_EXTRACT" version "$CHANGELOG_FILE")
  if [ -z "$VERSION_NAME" ]; then
    echo "错误：无法从发版说明提取版本号，请使用 --version 手动指定"; exit 1
  fi
fi

# versionCode：显式 --version-code 优先；否则已发布版本中最大 versionCode + 1（首次为 1）
if [ -n "$CUSTOM_VERSION_CODE" ]; then
  if [[ ! "$CUSTOM_VERSION_CODE" =~ ^[0-9]+$ ]] || [ "$CUSTOM_VERSION_CODE" -le 0 ]; then
    echo "错误：--version-code 必须是正整数"; exit 1
  fi
  VERSION_CODE=$((10#$CUSTOM_VERSION_CODE))
else
  LATEST_APK=$(ls -v "$RELEASES_DIR"/mao-android-*.apk 2>/dev/null | tail -1 || true)
  if [ -n "$LATEST_APK" ]; then
    # 从 APK 文件名中提取 versionCode（mao-android-<name>-<code>.apk）
    LATEST_CODE=$(echo "$LATEST_APK" | grep -oP '(?<=-)\d+(?=\.apk$)' || echo "0")
    VERSION_CODE=$((LATEST_CODE + 1))
  else
    VERSION_CODE=1
  fi
fi

# 下限校验：目标站已有清单的 versionCode 必须严格小于本次构建
MANIFEST_FILE="$RELEASES_DIR/android-latest.json"
if [ -f "$MANIFEST_FILE" ]; then
  EXISTING_CODE=$(grep -o '"versionCode"[[:space:]]*:[[:space:]]*[0-9]*' "$MANIFEST_FILE" \
    | grep -o '[0-9]*$' | head -1 || true)
  EXISTING_CODE="${EXISTING_CODE:-0}"
  if [ "$VERSION_CODE" -le "$EXISTING_CODE" ]; then
    echo "错误：versionCode $VERSION_CODE 不大于已发布清单的 $EXISTING_CODE；请用 --version-code 指定更大的值"; exit 1
  fi
fi

echo "=========================================="
echo "  Mao Android APK 构建"
echo "=========================================="
echo "  版本: $VERSION_NAME (code: $VERSION_CODE)"
echo "  默认服务器: ${SERVER_URL:-assets/capacitor.config.json}"
echo "  发布基址: $PUBLIC_BASE_URL"
echo "  签名: $MAO_KEY_ALIAS @ $(basename "$MAO_KEYSTORE_PATH")"
echo "  发布: $RELEASES_DIR"
echo "=========================================="
echo ""

# ---- Step 1: Capacitor sync（web-stub + 远程 server.url）----
echo "[1/3] Capacitor sync..."
cd "$ANDROID_DIR"
npx cap copy android
npx cap update android
echo "      sync 完成"

# ---- Step 2: Gradle assembleRelease ----
echo "[2/3] Gradle assembleRelease..."
cd "$ANDROID_DIR/android"
chmod +x gradlew
export ANDROID_HOME
GRADLE_ARGS=(assembleRelease -PMAO_VERSION_CODE="$VERSION_CODE" -PMAO_VERSION_NAME="$VERSION_NAME" --no-daemon -q)
if [ -n "$SERVER_URL" ]; then
  GRADLE_ARGS+=(-PMAO_DEFAULT_SERVER_URL="$SERVER_URL")
fi
./gradlew "${GRADLE_ARGS[@]}"
APK_OUT="$ANDROID_APP/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK_OUT" ]; then
  echo "错误：APK 构建失败，产物不存在: $APK_OUT"; exit 1
fi
APK_SIZE=$(du -h "$APK_OUT" | cut -f1)
echo "      构建完成: $APK_SIZE"

# ---- dry-run：到此为止，不发布 ----
if $DRY_RUN; then
  echo ""
  echo "=========================================="
  echo "  DRY-RUN：仅构建，未发布"
  echo "  APK:  $APK_OUT"
  echo "=========================================="
  exit 0
fi

# ---- Step 3: 发布 ----
echo "[3/3] 发布 APK + 清单..."
mkdir -p "$RELEASES_DIR"

APK_NAME="mao-android-${VERSION_NAME}-${VERSION_CODE}.apk"
cp "$APK_OUT" "$RELEASES_DIR/$APK_NAME"

# 提取 changelog（安卓原生壳；无分节时回退 ota-text）
CHANGELOG=$("$CHANGELOG_EXTRACT" apk-ota-text "$VERSION_NAME" "$CHANGELOG_FILE")

# 生成 android-latest.json
cat > "$RELEASES_DIR/android-latest.json" <<ENDJSON
{
  "versionCode": $VERSION_CODE,
  "versionName": "$VERSION_NAME",
  "downloadUrl": "$PUBLIC_BASE_URL/uploads/releases/$APK_NAME",
  "minVersionCode": 0,
  "changelog": "$CHANGELOG",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
ENDJSON

echo ""
echo "=========================================="
echo "  发布完成！"
echo "=========================================="
echo "  APK:  $RELEASES_DIR/$APK_NAME"
echo "  JSON: $RELEASES_DIR/android-latest.json"
echo "  版本: $VERSION_NAME ($VERSION_CODE)"
echo "=========================================="
