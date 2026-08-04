#!/bin/bash
# =============================================================================
# build-apk.sh — 一键构建安卓 APK 并发布到 releases 目录
#
# 用法：
#   ./build-apk.sh                  # 自动从 CHANGELOG.md 提取版本
#   ./build-apk.sh --version 0.0.2  # 手动指定版本名（versionCode 仍自动递增）
#   ./build-apk.sh --dry-run        # 仅构建，不发布
#
# 环境要求：
#   - ANDROID_HOME 已设置
#   - MAO_KEYSTORE_PATH / MAO_KEYSTORE_PASSWORD / MAO_KEY_ALIAS / MAO_KEY_PASSWORD
#     已设置或写在 /root/soft/mao/keystore/keystore-credentials.env
#
# 产出：
#   - APK:   /root/soft/mao/data/releases/mao-android-<version>.apk
#   - JSON:  /root/soft/mao/data/uploads/releases/android-latest.json
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$PROJECT_ROOT/desktop"
ANDROID_DIR="$SCRIPT_DIR"
ANDROID_APP="$ANDROID_DIR/android/app"
RELEASES_DIR="/root/soft/mao/data/uploads/releases"

# ---- 参数解析 ----
DRY_RUN=false
CUSTOM_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --version) CUSTOM_VERSION="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ---- 加载签名凭据 ----
CRED_FILE="/root/soft/mao/keystore/keystore-credentials.env"
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
# JDK 21（Capacitor 7 Android 要求）
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"
if [ -z "${MAO_KEYSTORE_PATH:-}" ] || [ ! -f "$MAO_KEYSTORE_PATH" ]; then
  echo "错误：MAO_KEYSTORE_PATH 未设置或文件不存在"; exit 1
fi

# ---- 读取版本号 ----
if [ -n "$CUSTOM_VERSION" ]; then
  VERSION_NAME="$CUSTOM_VERSION"
else
  # 从 CHANGELOG.md 第一个 ## 行提取版本号
  VERSION_NAME=$(grep -m1 '^## ' "$SCRIPT_DIR/CHANGELOG.md" | sed 's/^## \([^ ]*\).*/\1/')
  if [ -z "$VERSION_NAME" ]; then
    echo "错误：无法从 CHANGELOG.md 提取版本号，请使用 --version 手动指定"; exit 1
  fi
fi

# versionCode：已发布版本中最大 versionCode + 1（首次为 1）
LATEST_APK=$(ls -v "$RELEASES_DIR"/mao-android-*.apk 2>/dev/null | tail -1 || true)
if [ -n "$LATEST_APK" ]; then
  # 从 APK 文件名中提取 versionCode（mao-android-<name>-<code>.apk）
  LATEST_CODE=$(echo "$LATEST_APK" | grep -oP '(?<=-)\d+(?=\.apk$)' || echo "0")
  VERSION_CODE=$((LATEST_CODE + 1))
else
  VERSION_CODE=1
fi

echo "=========================================="
echo "  Mao Android APK 构建"
echo "=========================================="
echo "  版本: $VERSION_NAME (code: $VERSION_CODE)"
echo "  签名: $MAO_KEY_ALIAS @ $(basename "$MAO_KEYSTORE_PATH")"
echo "  发布: $RELEASES_DIR"
echo "=========================================="
echo ""

# ---- Step 1: 构建 desktop 前端（安卓专用 base） ----
echo "[1/4] 构建 desktop 前端（--base=./）..."
cd "$DESKTOP_DIR"
npx --no-install vue-tsc -b
npx --no-install vite build --base=./
echo "      desktop 构建完成"

# ---- Step 2: Capacitor sync ----
echo "[2/4] Capacitor sync..."
cd "$ANDROID_DIR"
npx cap copy android
npx cap update android
echo "      sync 完成"

# ---- Step 3: Gradle assembleRelease ----
echo "[3/4] Gradle assembleRelease..."
cd "$ANDROID_DIR/android"
chmod +x gradlew
export ANDROID_HOME
./gradlew assembleRelease \
  -PMAO_VERSION_CODE="$VERSION_CODE" \
  -PMAO_VERSION_NAME="$VERSION_NAME" \
  --no-daemon -q
APK_OUT="$ANDROID_APP/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK_OUT" ]; then
  echo "错误：APK 构建失败，产物不存在: $APK_OUT"; exit 1
fi
APK_SIZE=$(du -h "$APK_OUT" | cut -f1)
echo "      构建完成: $APK_SIZE"

# ---- Step 4: 发布 ----
echo "[4/4] 发布 APK + 清单..."
mkdir -p "$RELEASES_DIR"

APK_NAME="mao-android-${VERSION_NAME}-${VERSION_CODE}.apk"
cp "$APK_OUT" "$RELEASES_DIR/$APK_NAME"

# 提取 changelog
CHANGELOG=$(awk '/^## '"$VERSION_NAME"'/{found=1; next} /^## /{if(found) exit} found{print}' \
  "$SCRIPT_DIR/CHANGELOG.md" | sed '/^[[:space:]]*$/d' | sed 's/^- //' | tr '\n' '|' | sed 's/|$//')

# 生成 android-latest.json
cat > "$RELEASES_DIR/android-latest.json" <<ENDJSON
{
  "versionCode": $VERSION_CODE,
  "versionName": "$VERSION_NAME",
  "downloadUrl": "https://mao.etarch.cn/uploads/releases/$APK_NAME",
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
