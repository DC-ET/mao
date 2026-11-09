#!/usr/bin/env bash
# =============================================================================
# migrate-share-per-agent.sh —— /opt/mao-data/share 按 Agent 隔离（形态 C）迁移脚本
#
# 依据：docs/plan/2026-11-09-share-per-agent-isolation-technical-design.md（决策 2026-11-09）
#   · 形态 C：agent-experience/{A}（原位）+ agents/{A}（私有区），取消公共投放区
#   · 零兼容代码：本脚本承担全部存量数据搬迁与引用更新
#
# 用法：
#   bash migrate-share-per-agent.sh plan                # 默认：只读预演（不动任何文件/数据）
#   bash migrate-share-per-agent.sh apply --phase=1     # 数据面：备份+建结构+分发+README+删试验副本
#   bash migrate-share-per-agent.sh apply --phase=2     # 引用更新：DB + 文件清单（逐文件先备份）
#   bash migrate-share-per-agent.sh apply --phase=3     # 清理旧残留（须代码部署并验证后执行）
#   bash migrate-share-per-agent.sh verify              # 结构与残留校验（默认 pre-phase3 模式）
#   bash migrate-share-per-agent.sh verify --post-phase3 # phase3 之后：旧残留一律计 FAIL
#
# 选项：--yes（跳过二次确认）  --share-dir=DIR  --backend-env=FILE
#       --allow-missing  phase2 规则目标文件缺失时不中断（仅告警；verify 残留扫描兜底）
#       --no-db          verify 显式跳过 DB 校验（DB 不可达且未给该参数时计 FAIL）
# 阶段关系：phase1 零断点（复制保留，旧路径继续可用）→ phase2 → 部署代码
#           → verify --pre-phase3 + 回归 → 观察 → phase3 删旧残留 → verify --post-phase3
# 幂等：重复执行安全；命中 0 次打印"无需更新"并继续。
# =============================================================================
set -euo pipefail

SHARE_DIR="/opt/mao-data/share"
BACKEND_ENV="/opt/mao/backend-ts/.env"
BACKUP_ROOT="/opt/mao-data/backup"
AGENTS=(1 3 4 5 6)   # 存量 Agent（未来新增 Agent 由平台运行期懒建，不需补迁移）

MODE="plan"; PHASE=""; ASSUME_YES=0
VERIFY_MODE="pre"          # pre-phase3（默认）| post-phase3
ALLOW_MISSING=0            # phase2 规则目标文件缺失时是否放行
ALLOW_NO_DB=0              # verify 是否显式跳过 DB 校验
for arg in "$@"; do
  case "$arg" in
    plan|verify) MODE="$arg" ;;
    apply) MODE="apply" ;;
    --phase=*) PHASE="${arg#--phase=}" ;;
    --yes) ASSUME_YES=1 ;;
    --pre-phase3) VERIFY_MODE="pre" ;;
    --post-phase3) VERIFY_MODE="post" ;;
    --allow-missing) ALLOW_MISSING=1 ;;
    --no-db) ALLOW_NO_DB=1 ;;
    --share-dir=*) SHARE_DIR="${arg#--share-dir=}" ;;
    --backend-env=*) BACKEND_ENV="${arg#--backend-env=}" ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done
[[ "$MODE" == "apply" && ! "$PHASE" =~ ^[123]$ ]] && { echo "apply 需要 --phase=1|2|3" >&2; exit 2; }
if [[ "$SHARE_DIR" != "/opt/mao-data/share" ]]; then
  echo "WARN: --share-dir 非默认值（$SHARE_DIR）：FILE_RULES 与 DB SQL 仍按 /opt/mao-data/share 硬编码，" >&2
  echo "      verify 的残留扫描也可能误判；该参数仅建议用于演练/测试。" >&2
fi

TS="$(date +%Y%m%d-%H%M%S)"
BK="$BACKUP_ROOT/share-migrate-$TS"

log()  { printf '%s\n' "$*"; }
note() { printf '  - %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
head2() { printf '\n== %s ==\n' "$*"; }

require_root() { [[ "$(id -u)" -eq 0 ]] || die "需要 root 执行（share 与工作区文件均为 root 属主）"; }

confirm() {
  [[ "$ASSUME_YES" -eq 1 ]] && return 0
  printf '\n确认执行以上动作？输入 yes 继续：'
  read -r answer || answer=""; [[ "$answer" == "yes" ]] || die "已取消"
}

# --- 文件替换规则：<file>||<old>||<new> ------------------------------------
FILE_RULES=(
"${SHARE_DIR}/agent-experience/5/2026-11-05-应用接入Redis集群限流并发布测试环境.md||/opt/mao-data/share/settings.xml||/opt/mao-data/share/agents/5/settings.xml"
"${SHARE_DIR}/agent-experience/5/2026-11-03-二方包升级兼容性验证.md||/opt/mao-data/share/settings.xml||/opt/mao-data/share/agents/5/settings.xml"
"${SHARE_DIR}/agent-experience/5/2026-11-05-NTX大促推单与预售统计口径.md||/opt/mao-data/share/scripts/||/opt/mao-data/share/agents/5/scripts/"
"${SHARE_DIR}/agent-experience/5/2026-11-06-定时任务性能评估.md||/opt/mao-data/share/scripts/||/opt/mao-data/share/agents/5/scripts/"
"${SHARE_DIR}/agent-experience/5/2026-10-25-ASCM提前推单.md||/opt/mao-data/share/scripts/||/opt/mao-data/share/agents/5/scripts/"
"${SHARE_DIR}/agent-experience/5/2026-10-27-腾炬服务商查询鉴权与业绩趋势.md||/opt/mao-data/share/tools/vtn-biz-cli-0.8.7/bin/vtn-biz-cli.js||skill-views/<uid>/vtn-biz-cli/bin/vtn-biz-cli.js"
"${SHARE_DIR}/agent-experience/5/2026-10-27-腾炬服务商查询鉴权与业绩趋势.md||/opt/mao-data/share/tools/vtn-biz-cli-1.0.2||skill-views/<uid>/vtn-biz-cli"
"${SHARE_DIR}/agent-experience/6/2026-11-06-tag-center标签数据未找到排查.md||/opt/mao-data/share/settings_t.xml||/opt/mao-data/share/agents/6/settings_t.xml"
"${SHARE_DIR}/agent-experience/6/2026-11-06-rabbitmq-406-unknown-delivery-tag排查.md||/opt/mao-data/share/settings_t.xml||/opt/mao-data/share/agents/6/settings_t.xml"
"/opt/mao-data/workspace/feishu-chat/3/oc_67837a63395d608df8e766ba96919fe0/AGENTS.md||/opt/mao-data/share/settings_t.xml||/opt/mao-data/share/agents/6/settings_t.xml"
"/opt/mao-data/workspace/10/projects/feishu-chat-2-oc_155c79d46f86b12ec34fbb46e12e094e/docs/agents/goods-hulk-redis-limit.md||/opt/mao-data/share/settings.xml||/opt/mao-data/share/agents/5/settings.xml"
"/opt/mao-data/workspace/10/projects/feishu-chat-2-oc_155c79d46f86b12ec34fbb46e12e094e/docs/agents/market-coupon-service-recbest-combination-cpu.md||/opt/mao-data/share/settings.xml||/opt/mao-data/share/agents/5/settings.xml"
"/opt/mao-data/workspace/feishu-chat/2/oc_fb9ef40b6ff5b0c8cae6814f97c59a94/docs/agents/skill-cli-health-check.md||/opt/mao-data/share/scripts/||/opt/mao-data/share/agents/5/scripts/"
"/opt/mao-data/workspace/feishu-chat/2/oc_fb9ef40b6ff5b0c8cae6814f97c59a94/docs/agents/skill-view-deployment.md||/opt/mao-data/share/scripts/||/opt/mao-data/share/agents/5/scripts/"
)

# --- 小工具 ----------------------------------------------------------------
replace_in_file() { # $1 文件 $2 旧串 $3 新串 $4 是否写(1/0)
  local file="$1" old="$2" new="$3" apply="$4"
  if [[ ! -f "$file" ]]; then note "[跳过·不存在] $file"; return 0; fi
  python3 - "$file" "$old" "$new" "$apply" <<'PY'
import os, shutil, sys
path, old, new, apply = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == '1'
s = open(path, encoding='utf-8').read()
n = s.count(old)
if n == 0:
    print(f"    [0命中] {path}")
elif apply:
    tmp = path + '.migrate-tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(s.replace(old, new))
    shutil.copystat(path, tmp)
    os.replace(tmp, path)          # 原子替换，避免并发读者读到半截文件
    print(f"    [已替换 x{n}] {path}\n        {old}\n     -> {new}")
else:
    print(f"    [将替换 x{n}] {path}\n        {old}\n     -> {new}")
PY
}

backup_file() { # 保留目录结构、扁平化文件名
  local f="$1"
  [[ -f "$f" ]] || return 0
  mkdir -p "$BK/files"
  local flat; flat="$(printf '%s' "$f" | sed 's#^/##; s#/#_#g')"
  cp -p "$f" "$BK/files/$flat"
}

# --- DB 工具 ---------------------------------------------------------------
init_db_vars() {
  DB_URL=""; DB_USER=""; DB_PASS=""
  DB_HOST=""; DB_PORT=""; DB_NAME=""
  [[ -f "$BACKEND_ENV" ]] || return 1
  read_envvar() {
    grep -E "^$1=" "$BACKEND_ENV" | head -1 | cut -d= -f2- \
      | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//'
  }
  DB_URL="$(read_envvar MYSQL_URL)"; DB_USER="$(read_envvar MYSQL_USERNAME)"; DB_PASS="$(read_envvar MYSQL_PASSWORD)"
  [[ -n "$DB_URL" && -n "$DB_USER" ]] || return 1
  if [[ "$DB_URL" =~ jdbc:mysql://([^:/]+):([0-9]+)/([^?]+) ]]; then
    DB_HOST="${BASH_REMATCH[1]}"; DB_PORT="${BASH_REMATCH[2]}"; DB_NAME="${BASH_REMATCH[3]}"
  else
    return 1
  fi
  return 0
}
db_sql() { MYSQL_PWD="$DB_PASS" mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" \
  --default-character-set=utf8mb4 -N -B -e "$1"; }

db_available() { command -v mysql >/dev/null 2>&1 && init_db_vars && db_sql "SELECT 1" >/dev/null 2>&1; }

# 将将被修改的 DB 行导出为前像（REPLACE 语句；回滚：mysql "$DB_NAME" < "$BK/db-before.sql"）
db_dump_before() {
  local dump_bin
  dump_bin="$(command -v mysqldump || true)"
  if [[ -z "$dump_bin" && -x /usr/bin/mysqldump ]]; then dump_bin="/usr/bin/mysqldump"; fi
  [[ -n "$dump_bin" ]] || die "mysqldump 缺失，无法导出 DB 前像（P1-4 要求），请先安装 mysql-client"
  mkdir -p "$BK"
  : > "$BK/db-before.sql"
  # 注意：生产 DB 账号无 RELOAD 权限，不能加 --single-transaction（会 FLUSH TABLES 报错）；
  # 用 --skip-lock-tables 保证不锁表，目标表均为低写入的管理配置表，前像一致性可接受。
  local -a common=(-h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" --no-create-info --skip-extended-insert
                   --replace --skip-triggers --skip-lock-tables --set-gtid-purged=OFF
                   --default-character-set=utf8mb4 "$DB_NAME")
  MYSQL_PWD="$DB_PASS" "$dump_bin" "${common[@]}" agent_experiences \
    --where="id IN (66,74,75,76)" >> "$BK/db-before.sql"
  MYSQL_PWD="$DB_PASS" "$dump_bin" "${common[@]}" scheduled_task \
    --where="id IN (96,97)" >> "$BK/db-before.sql"
  MYSQL_PWD="$DB_PASS" "$dump_bin" "${common[@]}" session_workspace_rules \
    --where="source_path='/opt/mao-data/workspace/feishu-chat/3/oc_67837a63395d608df8e766ba96919fe0/AGENTS.md'" >> "$BK/db-before.sql"
}

db_run_update() { # $1=描述 $2=SQL；同连接执行并打印 affected rows
  local desc="$1" sql="$2" out affected
  out="$(db_sql "$sql"$'\nSELECT ROW_COUNT();')"
  affected="$(printf '%s\n' "$out" | tail -1)"
  note "[$desc] affected=$affected"
}

# ============================================================================
# phase 1：数据面（备份 + 建结构 + 分发 + README + 删试验副本）
# ============================================================================
phase1_actions() { # $1=apply(1/0)
  local apply="$1"
  head2 "phase1 · 数据面"
  note "备份目录：$BK（share-full.tgz + 后续文件级备份）"
  if [[ "$apply" == "1" ]]; then
    require_root
    mkdir -p "$BK"
    tar -czf "$BK/share-full.tgz" -C "$(dirname "$SHARE_DIR")" "$(basename "$SHARE_DIR")"
    note "已生成全量备份：$BK/share-full.tgz"
  fi
  note "mkdir -p $SHARE_DIR/agents/{${AGENTS[*]}}"
  if [[ "$apply" == "1" ]]; then
    for a in "${AGENTS[@]}"; do mkdir -p "$SHARE_DIR/agents/$a"; done
  fi
  copy_if_missing() { # $1 源 $2 目标
    if [[ ! -e "$1" ]]; then note "[跳过·源不存在] $1"; return 0; fi
    if [[ -e "$2" ]]; then
      if diff -q "$1" "$2" >/dev/null 2>&1; then note "[已存在且一致] $2"
      else note "[已存在且不一致！保留现状，需人工确认] $2"; fi
      return 0
    fi
    note "cp $1 -> $2"
    [[ "$apply" == "1" ]] && cp -p "$1" "$2"
    return 0
}
  local a
  for a in 1 3 4 5; do
    copy_if_missing "$SHARE_DIR/settings.xml" "$SHARE_DIR/agents/$a/settings.xml"
  done
  copy_if_missing "$SHARE_DIR/settings_t.xml" "$SHARE_DIR/agents/6/settings_t.xml"
  copy_if_missing_dir() { # $1 源目录 $2 目标目录
    if [[ ! -d "$1" ]]; then note "[跳过·源不存在] $1"; return 0; fi
    if [[ -e "$2" ]]; then note "[已存在] $2（保留现状）"; return 0; fi
    local tmp="$2.migrate-tmp"
    note "cp -a $1 -> $2（先复制到临时目录，完成后原子 mv，避免半截副本）"
    if [[ "$apply" == "1" ]]; then
      rm -rf "$tmp"
      cp -a "$1" "$tmp"
      rm -rf "$tmp/__pycache__"   # 不把字节码缓存带进新目录
      mv "$tmp" "$2"
    fi
    return 0
  }
  for a in "${AGENTS[@]}"; do
    copy_if_missing_dir "$SHARE_DIR/scripts" "$SHARE_DIR/agents/$a/scripts"
  done
  note "修正各副本内自引用：agents/{${AGENTS[*]}}/scripts/push_fast.sh 的 SHARE 路径 → 各自 scripts 目录"
  [[ "$apply" == "1" ]] || note "（apply 时执行）"
  if [[ "$apply" == "1" ]]; then
    for a in "${AGENTS[@]}"; do
      replace_in_file "$SHARE_DIR/agents/$a/scripts/push_fast.sh" \
        "/opt/mao-data/share/scripts" "/opt/mao-data/share/agents/$a/scripts" 1
    done
  fi
  local readme="$SHARE_DIR/README.md"
  if [[ -e "$readme" ]]; then note "[已存在] $readme"; else
    note "写 $readme（结构说明与投放指引）"
    if [[ "$apply" == "1" ]]; then
      cat > "$readme" <<'EOM'
# /opt/mao-data/share 结构说明与投放指引（2026-11-09 起）

本目录已按 Agent 隔离，不再有全员共享的公共投放区。

## 结构
- `agent-experience/{agentId}/`：团队经验库（平台管理；Agent 会话内经工作区 `团队经验/` 软链访问）。
- `agents/{agentId}/`：该 Agent 的私有区（脚本、配置、产物、投放品）。

## 管理员/运维投放指引
- 投放：把文件放到 `agents/<目标AgentId>/`——目录级挂载，即时生效（无需重启/重建容器）。
- 多 Agent 需要同一文件时逐个复制（无公共区）。
- 备份请放 `/opt/mao-data/backup`（勿放任何用户挂载面，避免经用户级共享面泄露）。

## 迁移说明（2026-11-09）
- 原 `share/scripts` → `agents/{1,3,4,5,6}/scripts/`（每个 Agent 一份）；`share/settings.xml` → `agents/{1,3,4,5}/`；`share/settings_t.xml` → `agents/6/`。
- `agent-experience/{agentId}/` 路径不变。
EOM
    fi
  fi
  head2 "phase1 · 删除试验副本（agent-experience/*/share）"
  for a in "${AGENTS[@]}"; do
    local victim="$SHARE_DIR/agent-experience/$a/share"
    if [[ -e "$victim" ]]; then
      note "rm -rf $victim"
      [[ "$apply" == "1" ]] && rm -rf "$victim"
    fi
  done
  return 0
}

# ============================================================================
# phase 2：引用更新（DB + 文件清单）
# ============================================================================
db_apply_updates() {
  db_run_update "agent_experiences#66 settings_t 路径" \
    "UPDATE agent_experiences SET content = REPLACE(content, '/opt/mao-data/share/settings_t.xml', '/opt/mao-data/share/agents/6/settings_t.xml') WHERE id = 66 AND content LIKE '%/opt/mao-data/share/settings_t.xml%';"
  local pair id a
  for pair in "74:5" "75:1" "76:6"; do
    id="${pair%%:*}"; a="${pair##*:}"
    db_run_update "agent_experiences#$id 共享文案" \
      "UPDATE agent_experiences SET content = REPLACE(content, '有需要跨用户共享的文件一律放到 /opt/mao-data/share 目录下', '本 Agent 的文件一律放到 /opt/mao-data/share/agents/$a/ 目录下（share 已按 Agent 隔离，无跨 Agent 公共共享目录；旧路径已迁移，勿自行重建）') WHERE id = $id AND content LIKE '%有需要跨用户共享的文件一律放到 /opt/mao-data/share 目录下%';"
  done
  db_run_update "scheduled_task#96/#97 scripts 路径（历史行同步）" \
    "UPDATE scheduled_task SET prompt = REPLACE(prompt, '/opt/mao-data/share/scripts/', '/opt/mao-data/share/agents/5/scripts/') WHERE id IN (96,97) AND prompt LIKE '%/opt/mao-data/share/scripts/%';"
  db_run_update "session_workspace_rules oc_6783 旧快照（删除后下轮 resolve 自动重建）" \
    "DELETE FROM session_workspace_rules WHERE source_path = '/opt/mao-data/workspace/feishu-chat/3/oc_67837a63395d608df8e766ba96919fe0/AGENTS.md' AND rules_text LIKE '%/opt/mao-data/share/settings_t.xml%';"
}

phase2_actions() { # $1=apply(1/0)
  local apply="$1"
  head2 "phase2 · 引用更新"
  if [[ "$apply" == "1" ]]; then
    require_root
    local a
    for a in "${AGENTS[@]}"; do
      [[ -d "$SHARE_DIR/agents/$a/scripts" ]] || die "phase1 未完成（缺少 agents/$a/scripts），请先执行 apply --phase=1"
    done
    for a in 1 3 4 5; do
      [[ -f "$SHARE_DIR/agents/$a/settings.xml" ]] || die "phase1 未完成（缺少 agents/$a/settings.xml），请先执行 apply --phase=1"
    done
    [[ -f "$SHARE_DIR/agents/6/settings_t.xml" ]] || die "phase1 未完成（缺少 agents/6/settings_t.xml），请先执行 apply --phase=1"
  fi

  head2 "phase2 · DB 引用更新（agent_experiences #66/#74/#75/#76、scheduled_task #96/#97、快照 5 行）"
  if db_available; then
    note "当前值预览："
    db_sql "SELECT id, LEFT(content, 200) FROM agent_experiences WHERE id IN (66,74,75,76) ORDER BY id;" | sed 's/^/    /'
    db_sql "SELECT id, LEFT(prompt, 160) FROM scheduled_task WHERE id IN (96,97) ORDER BY id;" | sed 's/^/    /'
    db_sql "SELECT session_id, workspace, source_path FROM session_workspace_rules WHERE rules_text LIKE '%/opt/mao-data/share/settings_t.xml%';" | sed 's/^/    /'
    if [[ "$apply" == "1" ]]; then
      head2 "phase2 · DB 前像导出"
      db_dump_before
      note "已导出：$BK/db-before.sql（REPLACE 语句；回滚：MYSQL_PWD=… mysql -h… $DB_NAME < $BK/db-before.sql）"
      db_apply_updates
      note "更新后校验（期望：旧串计数为 0）："
      db_sql "SELECT 'agent_experiences_old_share_text', COUNT(*) FROM agent_experiences WHERE content LIKE '%有需要跨用户共享的文件一律放到 /opt/mao-data/share 目录下%' UNION ALL SELECT 'agent_experiences_old_settings_t', COUNT(*) FROM agent_experiences WHERE content LIKE '%/opt/mao-data/share/settings_t.xml%' UNION ALL SELECT 'scheduled_task_old_scripts', COUNT(*) FROM scheduled_task WHERE prompt LIKE '%/opt/mao-data/share/scripts/%' UNION ALL SELECT 'session_workspace_rules_old_settings_t', COUNT(*) FROM session_workspace_rules WHERE rules_text LIKE '%/opt/mao-data/share/settings_t.xml%';" | sed 's/^/    /'
    else
      note "（apply 时执行上述 REPLACE/DELETE；命中 0 次即已是最新）"
    fi
  else
    if [[ "$apply" == "1" ]]; then
      die "DB 不可达或 mysql 缺失——phase2 必须更新 DB，请检查 --backend-env（$BACKEND_ENV）或在可连 DB 的环境执行"
    fi
    note "（DB 不可达或 mysql 缺失——预演跳过 DB 预览；apply 时会强制要求 DB 可达）"
  fi

  head2 "phase2 · 文件引用更新（${#FILE_RULES[@]} 条规则）"
  local rule file rest old new n=0
  local -a missing=()
  for rule in "${FILE_RULES[@]}"; do
    file="${rule%%||*}"; rest="${rule#*||}"
    old="${rest%%||*}"; new="${rest#*||}"
    if [[ ! -f "$file" ]]; then
      missing+=("$file")
      note "[缺失] $file ← 可能已被改名/合并，需人工核对"
      continue
    fi
    if [[ "$apply" == "1" ]] && grep -qF -- "$old" "$file" 2>/dev/null; then
      backup_file "$file"
    fi
    replace_in_file "$file" "$old" "$new" "$apply"
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    if [[ "$apply" == "1" && "$ALLOW_MISSING" -ne 1 ]]; then
      log "  以下规则目标文件缺失（${#missing[@]} 个）："
      printf '    %s\n' "${missing[@]}"
      die "phase2 中止：请核对改名后的目标文件并更新 FILE_RULES，确认可忽略后加 --allow-missing 重跑"
    fi
    note "WARN：${#missing[@]} 个规则目标文件缺失（plan 预演或 --allow-missing 放行）；verify 残留扫描兜底"
  fi
  return 0
}

# ============================================================================
# phase 3：清理旧残留（须部署并验证后执行）
# ============================================================================
phase3_actions() { # $1=apply(1/0)
  local apply="$1"
  head2 "phase3 · 清理旧残留"
  log "  将删除：$SHARE_DIR/scripts/"
  log "          $SHARE_DIR/settings.xml"
  log "          $SHARE_DIR/settings_t.xml"
  log "  警告：执行后历史消息中的旧路径失效（已接受项）。前置条件："
  log "        ① 代码已部署（挂载已切换） ② verify --pre-phase3 通过（FAIL=0） ③ 已观察 ≥1 天"
  log "        ④ 待删残留将先自动打包到 $BK/phase3-residual.tgz"
  if [[ "$apply" == "1" ]]; then
    require_root
    mkdir -p "$BK"
    local -a resid=()
    local x
    for x in scripts settings.xml settings_t.xml; do
      if [[ -e "$SHARE_DIR/$x" ]]; then resid+=("$x"); fi
    done
    if [[ ${#resid[@]} -gt 0 ]]; then
      tar -czf "$BK/phase3-residual.tgz" -C "$SHARE_DIR" "${resid[@]}"
      note "已备份待删残留（${resid[*]}）：$BK/phase3-residual.tgz"
    else
      note "待删残留均不存在（可能已清理）"
    fi
    rm -rf "$SHARE_DIR/scripts"
    rm -f  "$SHARE_DIR/settings.xml" "$SHARE_DIR/settings_t.xml"
    note "已删除。当前顶层："
    ls -la "$SHARE_DIR" | sed 's/^/    /'
  fi
  return 0
}

# ============================================================================
# verify：结构与残留校验
# ============================================================================
do_verify() {
  head2 "verify · 结构与残留（模式：$([[ "$VERIFY_MODE" == "post" ]] && echo post-phase3 || echo pre-phase3)）"
  local OK=0 FAIL=0 WARN=0
  pass() { note "[OK] $1"; OK=$((OK+1)); }
  fail() { note "[FAIL] $1"; FAIL=$((FAIL+1)); }
  soft() { # 待 phase2/phase3 收敛的项：pre 模式 WARN，post 模式 FAIL
    if [[ "$VERIFY_MODE" == "post" ]]; then
      fail "$1"
    else
      note "[WARN] $1（pre-phase3 模式不计 FAIL；--post-phase3 时计 FAIL）"
      WARN=$((WARN+1))
    fi
  }
  check() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi; }

  check "README.md 存在" test -f "$SHARE_DIR/README.md"
  local a
  for a in "${AGENTS[@]}"; do
    check "agents/$a 目录存在" test -d "$SHARE_DIR/agents/$a"
    check "agent-experience/$a 目录存在" test -d "$SHARE_DIR/agent-experience/$a"
  done
  for a in 1 3 4 5; do
    check "agents/$a/settings.xml 存在" test -f "$SHARE_DIR/agents/$a/settings.xml"
  done
  check "agents/6/settings_t.xml 存在" test -f "$SHARE_DIR/agents/6/settings_t.xml"
  for a in "${AGENTS[@]}"; do
    check "agents/$a/scripts/skill-cli-health-check.py 存在" test -f "$SHARE_DIR/agents/$a/scripts/skill-cli-health-check.py"
  done

  local leftovers rc
  if leftovers="$(find "$SHARE_DIR/agent-experience" -maxdepth 2 -name share -type d 2>/dev/null)"; then rc=0; else rc=$?; fi
  if [[ "$rc" -ne 0 ]]; then
    fail "试验副本清理检查（find 执行失败 rc=$rc）"
  elif [[ -z "$leftovers" ]]; then
    pass "试验副本已清除（agent-experience/*/share 不存在）"
  else
    fail "试验副本仍存在：$(printf '%s' "$leftovers" | tr '\n' ' ')"
  fi

  local pfbad="" pf
  for a in "${AGENTS[@]}"; do
    pf="$SHARE_DIR/agents/$a/scripts/push_fast.sh"
    if [[ ! -f "$pf" ]] || grep -q '/opt/mao-data/share/scripts' "$pf" 2>/dev/null; then
      pfbad+="agents/$a "
    fi
  done
  if [[ -z "$pfbad" ]]; then
    pass "副本内 push_fast.sh 自引用已更新（全 Agent 副本）"
  else
    fail "副本内 push_fast.sh 自引用未更新或缺失：$pfbad"
  fi

  # --- 旧路径残留扫描（phase2 的验收面）-----------------------------------
  residual_check() { # $1 描述；其余为 grep 目标（文件/目录，可含 grep 选项）
    local desc="$1"; shift
    local hits="" rc=1 n=0
    if hits="$(grep -rn -F --exclude-dir=__pycache__ \
        -e "/opt/mao-data/share/scripts" -e "/opt/mao-data/share/settings" \
        -e "/opt/mao-data/share/tools" "$@" 2>/dev/null)"; then rc=0; else rc=$?; fi
    if [[ "$rc" -ge 2 ]]; then fail "$desc（扫描失败 rc=$rc）"; return 0; fi
    if [[ "$rc" -eq 0 ]]; then
      n="$(printf '%s\n' "$hits" | wc -l)"
      log "    命中 $n 处（前 20 行）："
      printf '%s\n' "$hits" | head -20 | sed 's/^/      /'
      soft "$desc：命中 $n 处旧路径"
      return 0
    fi
    pass "$desc"
    return 0
  }
  residual_check "经验库（agent-experience/**/*.md）无旧路径残留" \
    --include='*.md' --exclude-dir=share "$SHARE_DIR/agent-experience"
  for a in "${AGENTS[@]}"; do
    if [[ -d "$SHARE_DIR/agents/$a/scripts" ]]; then
      residual_check "agents/$a/scripts 无旧路径残留" "$SHARE_DIR/agents/$a/scripts"
    else
      fail "agents/$a/scripts 无旧路径残留（目录不存在，phase1 未完成）"
    fi
  done

  local seen=$'\n' rule f x
  local -a rfiles=() rexist_extra=() rmissing=()
  for rule in "${FILE_RULES[@]}"; do
    f="${rule%%||*}"
    if [[ "$seen" != *$'\n'"$f"$'\n'* ]]; then
      seen+="$f"$'\n'
      rfiles+=("$f")
    fi
  done
  for f in "${rfiles[@]}"; do
    if [[ ! -f "$f" ]]; then
      rmissing+=("$f")
    elif [[ "$f" != "$SHARE_DIR/agent-experience/"* ]]; then
      rexist_extra+=("$f")
    fi
  done
  if [[ ${#rmissing[@]} -gt 0 ]]; then
    fail "规则目标文件缺失（${#rmissing[@]} 个，可能被改名/合并）：$(printf '%s ' "${rmissing[@]}")"
  else
    pass "规则目标文件齐全（${#rfiles[@]} 个）"
  fi
  if [[ ${#rexist_extra[@]} -gt 0 ]]; then
    residual_check "规则目标文件（经验库外）无旧路径残留" "${rexist_extra[@]}"
  fi

  # --- phase3 待清理项（pre 模式 WARN）-----------------------------------
  local -a oldroot=()
  for x in scripts settings.xml settings_t.xml; do
    if [[ -e "$SHARE_DIR/$x" ]]; then oldroot+=("$x"); fi
  done
  if [[ ${#oldroot[@]} -eq 0 ]]; then
    pass "根目录旧残留已清理（phase3 后生效）"
  else
    soft "根目录仍有旧残留：${oldroot[*]}（phase3 删除）"
  fi

  # --- DB ----------------------------------------------------------------
  if db_available; then
    db_count_check() { # $1 描述 $2 SQL
      local desc="$1" sql="$2" c
      c="$(db_sql "$sql" | head -1)"
      if [[ "$c" == "0" ]]; then
        pass "$desc"
      else
        log "    $desc：当前 $c 行"
        soft "$desc（残留 $c 行）"
      fi
    }
    db_count_check "DB scheduled_task 无 share/scripts 旧路径" \
      "SELECT COUNT(*) FROM scheduled_task WHERE prompt LIKE '%/opt/mao-data/share/scripts/%';"
    db_count_check "DB agent_experiences 无旧共享文案" \
      "SELECT COUNT(*) FROM agent_experiences WHERE content LIKE '%有需要跨用户共享的文件一律放到 /opt/mao-data/share 目录下%';"
    db_count_check "DB agent_experiences 无 settings_t 旧路径" \
      "SELECT COUNT(*) FROM agent_experiences WHERE content LIKE '%/opt/mao-data/share/settings_t.xml%';"
    db_count_check "DB session_workspace_rules 无 settings_t 旧快照" \
      "SELECT COUNT(*) FROM session_workspace_rules WHERE rules_text LIKE '%/opt/mao-data/share/settings_t.xml%';"
  else
    if [[ "$ALLOW_NO_DB" -eq 1 ]]; then
      note "[SKIP] DB 校验（--no-db 显式跳过）"
    else
      fail "DB 不可达（如确需跳过请显式加 --no-db）"
    fi
  fi

  head2 "verify · 容器级验证命令（手动执行，以 user36/agent5 为例）"
  cat <<'EOM'
  docker exec mao-user-36-agent-5 ls /opt/mao-data/share/agent-experience/     # 期望：仅 5
  docker exec mao-user-36-agent-5 ls /opt/mao-data/share/agents/               # 期望：仅 5
  docker exec mao-user-36-agent-5 cat /opt/mao-data/share/agent-experience/6/x 2>&1  # 期望：ENOENT
  docker exec mao-user-36-agent-5 sh -c 'echo x > /opt/mao-data/share/agents/5/.t && rm /opt/mao-data/share/agents/5/.t'  # 期望：成功
EOM
  head2 "verify · 汇总（模式：$([[ "$VERIFY_MODE" == "post" ]] && echo post-phase3 || echo pre-phase3)）"
  log "  OK=$OK FAIL=$FAIL WARN=$WARN"
  if [[ "$FAIL" -eq 0 ]]; then
    log "  结论：PASS"; return 0
  fi
  log "  结论：FAIL"; return 1
}

# ============================================================================
# 入口
# ============================================================================
apply_phase() {
  local n="$1"
  log "========== 预演（phase$n）=========="
  "phase${n}_actions" 0
  confirm
  log "========== 执行（phase$n）=========="
  "phase${n}_actions" 1
  return 0
}

case "$MODE" in
  plan)
    log "== 只读预演：share=$SHARE_DIR（不会改动任何文件/数据）=="
    phase1_actions 0
    phase2_actions 0
    phase3_actions 0
    log ""
    log "预演完成。执行顺序建议：apply --phase=1 → apply --phase=2 → 部署代码 → verify --pre-phase3 + 回归"
    log "  → 观察 ≥1 天 → apply --phase=3 → verify --post-phase3"
    ;;
  apply) apply_phase "$PHASE" ;;
  verify) do_verify ;;
esac

