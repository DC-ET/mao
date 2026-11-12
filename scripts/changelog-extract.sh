#!/bin/bash
# =============================================================================
# changelog-extract.sh — 从按月归档的发版说明提取版本号与正文
#
# 已发布正文在 changelog/YYYY/MM.md。根 CHANGELOG.md 只是索引（没有 ## 标题）时，
# 自动改读归档：version / sync-desktop 取最新月份文件的第一条版本。
#
# 用法：
#   changelog-extract.sh version [CHANGELOG]
#   changelog-extract.sh body <version> [--section 名称]... [CHANGELOG]
#   changelog-extract.sh ota-text <version> [CHANGELOG]
#   changelog-extract.sh apk-ota-text <version> [CHANGELOG]
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
  sed -n '3,14p' "$0" | sed 's/^# //'
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

# 月份文件按路径倒序：changelog/2026/11.md 先于 10.md，也先于上一年。
list_month_files() {
  local root="$1"
  local dir="$root/changelog"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi
  find "$dir" -type f -name '*.md' 2>/dev/null \
    | grep -E '/[0-9]{4}/[0-9]{2}\.md$' \
    | sort -r || true
}

file_has_version() {
  local ver="$1"
  local file="$2"
  [[ -f "$file" ]] || return 1
  awk -v ver="$ver" 'index($0, "## " ver " ")==1 { found=1; exit } END { exit found ? 0 : 1 }' "$file"
}

# 指定文件里已有该版本则用它；索引文件没有 ## 时，从新到旧查月份归档。
locate_version_file() {
  local ver="$1"
  local hint="$2"
  if file_has_version "$ver" "$hint"; then
    echo "$hint"
    return 0
  fi
  local root f
  local files=()
  root="$(cd "$(dirname "$hint")" && pwd)"
  while IFS= read -r f; do
    [[ -n "$f" ]] && files+=("$f")
  done < <(list_month_files "$root")
  local i
  for ((i = 0; i < ${#files[@]}; i++)); do
    if file_has_version "$ver" "${files[$i]}"; then
      echo "${files[$i]}"
      return 0
    fi
  done
  return 1
}

# 文件自身有版本标题时取第一条；否则取最新月份文件的第一条。
first_version_line() {
  local hint="$1"
  if [[ -f "$hint" ]] && grep -q '^## ' "$hint"; then
    grep -m1 '^## ' "$hint"
    return 0
  fi
  local root f
  local files=()
  root="$(cd "$(dirname "$hint")" && pwd)"
  while IFS= read -r f; do
    [[ -n "$f" ]] && files+=("$f")
  done < <(list_month_files "$root")
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "错误：找不到已发布版本" >&2
    return 1
  fi
  grep -m1 '^## ' "${files[0]}"
}

cmd_version() {
  local file line
  file="$(resolve_changelog "$@")"
  if [[ ! -f "$file" ]]; then
    echo "错误：CHANGELOG 不存在: $file" >&2
    exit 1
  fi
  line="$(first_version_line "$file")" || exit 1
  printf '%s\n' "$line" | sed 's/^## \([^ ]*\).*/\1/'
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
  local source=""
  source="$(locate_version_file "$version" "$CHANGELOG_FILE" || true)"
  if [[ -z "$source" ]]; then
    return 0
  fi

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
  ' "$source"
}

lines_to_pipe() {
  echo "$1" | sed '/^[[:space:]]*$/d' | tr '\n' '|' | sed 's/|$//'
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
    echo "错误：版本 $version 没有可写入 OTA 的条目" >&2
    exit 1
  fi

  echo "$lines" | sed '/^[[:space:]]*$/d' | tr '\n' '|' | sed 's/|$//'
}

# apk-ota-text: 安卓壳 APK OTA 文案（优先 ### 安卓原生，否则回退 ota-text）
cmd_apk_ota_text() {
  local version="$1"
  shift
  local changelog_arg=""
  if [[ $# -ge 1 && -f "$1" && "$1" == *.md ]]; then
    changelog_arg="$1"
    shift
  fi
  local CHANGELOG_FILE="${changelog_arg:-$DEFAULT_CHANGELOG}"

  local lines
  lines=$(cmd_body "$version" --section "安卓原生" "$CHANGELOG_FILE" || true)
  if [[ -z "$lines" ]]; then
    cmd_ota_text "$version" "$CHANGELOG_FILE"
    return
  fi

  lines_to_pipe "$lines"
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
    if (pkg.version !== ver) {
      pkg.version = ver;
      fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
      console.log('desktop/package.json version -> ' + ver);
    }
    const lockPath = require('path').join(require('path').dirname(p), 'package-lock.json');
    if (!fs.existsSync(lockPath)) process.exit(0);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    let changed = false;
    if (lock.version !== ver) { lock.version = ver; changed = true; }
    if (lock.packages && lock.packages[''] && lock.packages[''].version !== ver) {
      lock.packages[''].version = ver;
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
      console.log('desktop/package-lock.json version -> ' + ver);
    }
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
  apk-ota-text)
    shift
    [[ $# -ge 1 ]] || usage
    cmd_apk_ota_text "$@"
    ;;
  sync-desktop) shift; cmd_sync_desktop "$@" ;;
  -h|--help) usage ;;
  *) echo "未知命令: $1" >&2; usage ;;
esac
