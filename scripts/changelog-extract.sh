#!/bin/bash
# =============================================================================
# changelog-extract.sh — 从根 CHANGELOG.md 提取版本号与发版说明
#
# 用法：
#   changelog-extract.sh version [CHANGELOG]
#   changelog-extract.sh body <version> [--section 名称]... [CHANGELOG]
#   changelog-extract.sh ota-text <version> [CHANGELOG]
#   changelog-extract.sh sync-desktop [CHANGELOG]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_CHANGELOG="${MAO_CHANGELOG:-$PROJECT_ROOT/CHANGELOG.md}"

# OTA 用户可见小节（前缀匹配 ### 标题）
OTA_SECTIONS=(
  "前端（桌面 / Web / 安卓）"
  "安卓原生"
)

usage() {
  sed -n '3,12p' "$0" | sed 's/^# //'
  exit 1
}

resolve_changelog() {
  local last="${*: -1}"
  if [[ $# -gt 0 && -f "$last" && "$last" == *.md ]]; then
    echo "$last"
  else
    echo "$DEFAULT_CHANGELOG"
  fi
}


cmd_version() {
  local file
  file="$(resolve_changelog "$@")"
  if [[ ! -f "$file" ]]; then
    echo "错误：CHANGELOG 不存在: $file" >&2
    exit 1
  fi
  grep -m1 '^## ' "$file" | sed 's/^## \([^ ]*\).*/\1/'
}

# body: 每行一条（已去掉 "- " 前缀）
cmd_body() {
  local version="$1"
  shift
  local sections=()
  local changelog_arg=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --section) sections+=("$2"); shift 2 ;;
      -h|--help) usage ;;
      *)
        if [[ -f "$1" && "$1" == *.md ]]; then
          changelog_arg="$1"
          shift
        else
          echo "未知参数: $1" >&2
          exit 1
        fi
        ;;
    esac
  done

  local CHANGELOG_FILE="${changelog_arg:-$DEFAULT_CHANGELOG}"

  local section_csv=""
  if ((${#sections[@]} > 0)); then
    section_csv=$(IFS='|'; echo "${sections[*]}")
  fi

  awk -v ver="$version" -v want="$section_csv" '
    function section_wanted(h,   i, n, p) {
      if (want == "") return 1
      n = split(want, parts, "|")
      for (i = 1; i <= n; i++) {
        p = parts[i]
        if (h == p || index(h, p) == 1) return 1
      }
      return 0
    }
    /^## / {
      if (in_ver) exit
      if ($0 ~ "^## " ver " ") {
        in_ver = 1
        has_sub = 0
        in_sec = 0
      }
      next
    }
    in_ver && /^## / { exit }
    in_ver && /^### / {
      has_sub = 1
      heading = $0
      sub(/^### /, "", heading)
      in_sec = section_wanted(heading)
      next
    }
    in_ver && /^- / {
      line = substr($0, 3)
      if (!has_sub) print line
      else if (in_sec) print line
    }
  ' "$CHANGELOG_FILE"
}

# ota-text: pipe 分隔；有 ### 分节时仅取前端 + 安卓原生，否则取全部条目
cmd_ota_text() {
  local version="$1"
  shift
  local changelog_arg=""
  if [[ $# -ge 1 && -f "$1" && "$1" == *.md ]]; then
    changelog_arg="$1"
    shift
  fi
  local CHANGELOG_FILE="${changelog_arg:-$DEFAULT_CHANGELOG}"

  local lines
  lines=$(cmd_body "$version" --section "${OTA_SECTIONS[0]}" --section "${OTA_SECTIONS[1]}" "$CHANGELOG_FILE" || true)
  if [[ -z "$lines" ]]; then
    lines=$(cmd_body "$version" "$CHANGELOG_FILE")
  fi

  if [[ -z "$lines" ]]; then
    echo "错误：版本 $version 在 $CHANGELOG_FILE 中无 OTA 条目" >&2
    exit 1
  fi

  echo "$lines" | sed '/^[[:space:]]*$/d' | tr '\n' '|' | sed 's/|$//'
}

cmd_sync_desktop() {
  local file
  file="$(resolve_changelog "$@")"
  local version
  version="$(cmd_version "$file")"
  local pkg="$PROJECT_ROOT/desktop/package.json"

  if [[ ! -f "$pkg" ]]; then
    echo "错误：desktop/package.json 不存在" >&2
    exit 1
  fi

  node -e "
    const fs = require('fs');
    const p = process.argv[1];
    const ver = process.argv[2];
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (pkg.version === ver) process.exit(0);
    pkg.version = ver;
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
    console.log('desktop/package.json version -> ' + ver);
  " "$pkg" "$version"
}

[[ $# -ge 1 ]] || usage

case "$1" in
  version) shift; cmd_version "$@" ;;
  body)
    shift
    [[ $# -ge 1 ]] || usage
    cmd_body "$@"
    ;;
  ota-text)
    shift
    [[ $# -ge 1 ]] || usage
    cmd_ota_text "$@"
    ;;
  sync-desktop) shift; cmd_sync_desktop "$@" ;;
  -h|--help) usage ;;
  *) echo "未知命令: $1" >&2; usage ;;
esac
