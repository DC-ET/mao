#!/bin/bash
# E2E 测试环境一键搭建：
#   1. 在本地 MySQL 创建隔离的 mao_e2e 库与专用账号
#   2. 执行全部 Flyway 迁移（DELIMITER 语法经 mysql 客户端执行，绕开 TS 执行器限制）
#   3. 写入最小种子数据，避免 analytics 等页面走空态分支
#   4. 生成 backend-ts/.env.e2e（不入 git）
# 之后 npm test 会通过 playwright webServer 自动拉起后端(:9180)与两个前端 dev server。
#
# 用法：bash scripts/e2e-setup.sh [--force] [--skip-seed]
#   --force      重建数据库（丢弃已有 e2e 数据）
#   --skip-seed  只建表不写种子数据
#
# 可用环境变量：
#   E2E_MYSQL_HOST   默认 127.0.0.1
#   E2E_MYSQL_PORT   默认 3306
#   E2E_MYSQL_ROOT_PASS  root 密码，默认空（auth_socket 登录）
#   E2E_MYSQL_USER   默认 mao_e2e
#   E2E_MYSQL_PASS   默认 MaoE2e_2026!
#   E2E_DB           默认 mao_e2e

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_DIR="$ROOT_DIR/backend-ts/db/migration"

E2E_MYSQL_HOST="${E2E_MYSQL_HOST:-localhost}"
E2E_MYSQL_PORT="${E2E_MYSQL_PORT:-3306}"
E2E_MYSQL_ROOT_PASS="${E2E_MYSQL_ROOT_PASS:-}"
E2E_MYSQL_USER="${E2E_MYSQL_USER:-mao_e2e}"
E2E_MYSQL_PASS="${E2E_MYSQL_PASS:-MaoE2e_2026!}"
E2E_DB="${E2E_DB:-mao_e2e}"

FORCE=0
SEED=1
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --skip-seed) SEED=0 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

MYSQL_ROOT() {
  # root 常见两种登录方式：auth_socket（不传 -h，走 socket）与 TCP 密码。
  if [[ -n "$E2E_MYSQL_ROOT_PASS" ]]; then
    mysql -h"$E2E_MYSQL_HOST" -P"$E2E_MYSQL_PORT" -uroot -p"$E2E_MYSQL_ROOT_PASS" "$@"
  elif mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
    mysql -uroot "$@"
  else
    mysql -h"$E2E_MYSQL_HOST" -P"$E2E_MYSQL_PORT" -uroot "$@"
  fi
}

MYSQL_E2E() {
  mysql -h"$E2E_MYSQL_HOST" -P"$E2E_MYSQL_PORT" -u"$E2E_MYSQL_USER" -p"$E2E_MYSQL_PASS" "$E2E_DB" "$@"
}

command -v mysql >/dev/null || { echo "错误：未安装 mysql 客户端"; exit 1; }
[[ -d "$MIGRATION_DIR" ]] || { echo "错误：找不到迁移目录 $MIGRATION_DIR"; exit 1; }

echo "==> 检查 MySQL 连接"
MYSQL_ROOT -e "SELECT 1" >/dev/null 2>&1 || {
  echo "错误：无法用 root 连接 MySQL($E2E_MYSQL_HOST:$E2E_MYSQL_PORT)。"
  echo "如 root 有密码，请设置环境变量 E2E_MYSQL_ROOT_PASS 后重试。"
  exit 1
}

if [[ "$FORCE" == "1" ]]; then
  echo "==> --force：删除并重建数据库 $E2E_DB"
  MYSQL_ROOT -e "DROP DATABASE IF EXISTS \`$E2E_DB\`"
fi

echo "==> 创建数据库与账号（已存在则跳过）"
MYSQL_ROOT <<SQL
CREATE DATABASE IF NOT EXISTS \`$E2E_DB\`;
CREATE USER IF NOT EXISTS '$E2E_MYSQL_USER'@'localhost' IDENTIFIED BY '$E2E_MYSQL_PASS';
CREATE USER IF NOT EXISTS '$E2E_MYSQL_USER'@'%' IDENTIFIED BY '$E2E_MYSQL_PASS';
GRANT ALL ON \`$E2E_DB\`.* TO '$E2E_MYSQL_USER'@'localhost';
GRANT ALL ON \`$E2E_DB\`.* TO '$E2E_MYSQL_USER'@'%';
FLUSH PRIVILEGES;
SQL

# 历史表结构与 TS 版 Flyway 一致（src/db/flyway.ts）。
echo "==> 确保 flyway_schema_history 存在"
MYSQL_E2E <<'SQL'
CREATE TABLE IF NOT EXISTS flyway_schema_history (
  installed_rank INT NOT NULL,
  version VARCHAR(50) NULL,
  description VARCHAR(200) NOT NULL,
  type VARCHAR(20) NOT NULL,
  script VARCHAR(1000) NOT NULL,
  checksum INT NULL,
  installed_by VARCHAR(100) NOT NULL,
  installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  execution_time INT NOT NULL,
  success TINYINT(1) NOT NULL,
  PRIMARY KEY (installed_rank)
);
SQL

# Flyway CRC32：逐行（不含换行符）crc32 累加，取有符号 int32，与 src/db/flyway.ts 的
# flywayChecksum 保持一致，保证后端启动时校验通过、不会重复迁移。
checksum_of() {
  node -e "
const { crc32 } = require('node:zlib');
const fs = require('node:fs');
let content = fs.readFileSync(process.argv[1], 'utf8').replace(/^\uFEFF/, '');
const lines = content.split(/\r\n|\n|\r/);
if (lines.length && lines[lines.length - 1] === '') lines.pop();
let h = 0;
for (const line of lines) h = crc32(Buffer.from(line, 'utf8'), h);
console.log(h | 0);
" "$1"
}

applied() {
  MYSQL_E2E -N -e "SELECT COUNT(*) FROM flyway_schema_history WHERE version='$1' AND success=1" 2>/dev/null
}

echo "==> 执行迁移（$(ls "$MIGRATION_DIR" | grep -c '^V') 个文件）"
RANK=0
for f in "$MIGRATION_DIR"/V*.sql; do
  name="$(basename "$f")"
  ver="$(echo "$name" | sed -E 's/^V([0-9.]+)__.*\.sql$/\1/')"
  desc="$(echo "$name" | sed -E 's/^V[0-9.]+__//; s/\.sql$//' | tr '_' ' ')"
  RANK=$((RANK + 1))
  if [[ "$(applied "$ver")" != "0" ]]; then
    echo "  跳过 $name（已应用）"
    continue
  fi
  start=$(date +%s%N)
  # DELIMITER/存储过程只有 mysql 客户端能正确解析，故逐文件经客户端执行。
  MYSQL_E2E < "$f" || { echo "迁移失败: $name"; exit 1; }
  ms=$(( ($(date +%s%N) - start) / 1000000 ))
  sum="$(checksum_of "$f")"
  MYSQL_E2E -e "INSERT INTO flyway_schema_history (installed_rank,version,description,type,script,checksum,installed_by,execution_time,success) VALUES ($RANK,'$ver','$desc','SQL','$name',$sum,'e2e-setup',$ms,1)" >/dev/null
  echo "  应用 $name"
done

if [[ "$SEED" == "1" ]]; then
  echo "==> 写入种子数据（幂等：已有 session 数据则跳过）"
  existing="$(MYSQL_E2E -N -e "SELECT COUNT(*) FROM session" 2>/dev/null || echo 0)"
  if [[ "$existing" != "0" ]]; then
    echo "  已有 $existing 条 session，跳过"
  else
    # 说明：种子里 model_id=1/2 依赖 V003 等迁移插入的默认模型；若缺模型则先补。
    model_count="$(MYSQL_E2E -N -e "SELECT COUNT(*) FROM llm_model")"
    if [[ "$model_count" == "0" ]]; then
      MYSQL_E2E -e "INSERT INTO llm_model (name, provider, api_protocol, effort, base_url, api_key, model_id, is_default, status) VALUES ('e2e-mock', 'openai', 'OPENAI', '', 'https://mock.local/v1', 'sk-e2e', 'e2e-mock', 1, 1)" 2>/dev/null || \
      MYSQL_E2E -e "INSERT INTO llm_model (name, provider, api_protocol, base_url, api_key, model_id) VALUES ('e2e-mock', 'openai', 'OPENAI', 'https://mock.local/v1', 'sk-e2e', 'e2e-mock')"
    fi
    MYSQL_E2E <<'SQL'
INSERT INTO agent (name, description, system_prompt, creator_id) VALUES
 ('数据分析助手', '帮助用户分析数据', '你是数据分析助手', 1),
 ('代码助手', '帮助用户写代码', '你是代码助手', 1);

INSERT INTO session (user_id, agent_id, title, status, phase, created_at, last_activity_at) VALUES
 (1, 1, '分析销售数据', 'ACTIVE', 'COMPLETED', NOW(), NOW()),
 (1, 2, '修复登录bug', 'ACTIVE', 'COMPLETED', NOW(), NOW()),
 (1, 1, '生成周报', 'ACTIVE', 'RUNNING', NOW(), NOW());

INSERT INTO message (session_id, role, content, token_count, created_at) VALUES
 (1, 'USER', '帮我分析这份销售数据', 120, NOW()),
 (1, 'ASSISTANT', '好的，我来分析', 350, NOW()),
 (2, 'USER', '登录页面报错了', 100, NOW()),
 (2, 'ASSISTANT', '我来看看日志', 280, NOW()),
 (3, 'USER', '生成本周周报', 90, NOW());
SQL
    # llm_usage / llm_call 需要 model_id，取最小可用模型（种子模型或迁移内置模型均可）
    MYSQL_E2E <<'SQL'
INSERT INTO llm_usage (user_id, session_id, model_id, scene, prompt_tokens, completion_tokens, total_tokens, success, created_at)
SELECT 1, 1, (SELECT MIN(id) FROM llm_model), 'chat', 800, 1200, 2000, 1, NOW();
INSERT INTO llm_usage (user_id, session_id, model_id, scene, prompt_tokens, completion_tokens, total_tokens, success, created_at)
SELECT 1, 2, (SELECT MIN(id) FROM llm_model), 'chat', 600, 900, 1500, 1, NOW();

INSERT INTO llm_call (user_id, session_id, agent_id, model_id, model_name, provider, scene, prompt_tokens, completion_tokens, total_tokens, success, duration_ms, created_at)
SELECT 1, 1, 1, m.id, m.name, m.provider, 'chat', 800, 1200, 2000, 1, 900, NOW()
FROM llm_model m WHERE m.id = (SELECT MIN(id) FROM llm_model);
INSERT INTO llm_call (user_id, session_id, agent_id, model_id, model_name, provider, scene, prompt_tokens, completion_tokens, total_tokens, success, duration_ms, created_at)
SELECT 1, 2, 2, m.id, m.name, m.provider, 'chat', 600, 900, 1500, 1, 1100, NOW()
FROM llm_model m WHERE m.id = (SELECT MIN(id) FROM llm_model);
SQL
    echo "  完成：agent/session/message/llm_usage/llm_call"
  fi
fi

echo "==> 生成 backend-ts/.env.e2e"
if [[ ! -f "$ROOT_DIR/backend-ts/.env.e2e" ]] || ! grep -q "MAO_RUNTIME_DIR" "$ROOT_DIR/backend-ts/.env.e2e"; then
  cat > "$ROOT_DIR/backend-ts/.env.e2e" <<EOF
# E2E 隔离环境配置（scripts/e2e-setup.sh 生成，勿提交 git）
MAO_TS_PORT=9180
MYSQL_URL='jdbc:mysql://$E2E_MYSQL_HOST:$E2E_MYSQL_PORT/$E2E_DB?useSSL=false&serverTimezone=Asia/Shanghai&allowMultiQueries=true&zeroDateTimeBehavior=convertToNull&useUnicode=true&characterEncoding=utf-8'
MYSQL_USERNAME=$E2E_MYSQL_USER
MYSQL_PASSWORD='$E2E_MYSQL_PASS'
JWT_SECRET=e2e-jwt-secret-not-for-prod
APP_GIT_CREDENTIAL_SECRET=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
# 运行期目录全部指向 e2e 临时目录，严禁触及生产 /opt/mao-data：
# runtimeDir 默认值是 /opt/mao-data/runtime，后端启动即跑一轮清理调度器，
# 会删除生产会话的超龄 shell 输出与 skills 副本，必须重定向。
MAO_RUNTIME_DIR=$ROOT_DIR/backend-ts/.e2e-data/runtime
MAO_USER_HOME_DIR=$ROOT_DIR/backend-ts/.e2e-data/users
WORKSPACE_ROOT=$ROOT_DIR/backend-ts/.e2e-data/workspace
FILE_UPLOAD_DIR=$ROOT_DIR/backend-ts/.e2e-data/uploads
EOF
else
  echo "  已存在，保留"
fi

# .env.e2e 必须不入 git
if ! grep -qE '^\.env\.e2e$' "$ROOT_DIR/backend-ts/.gitignore" 2>/dev/null; then
  echo ".env.e2e" >> "$ROOT_DIR/backend-ts/.gitignore"
  echo "==> 已将 .env.e2e 加入 backend-ts/.gitignore"
fi

echo ""
echo "E2E 环境就绪："
echo "  数据库  $E2E_DB@$E2E_MYSQL_HOST:$E2E_MYSQL_PORT"
echo "  管理员  admin / admin123"
echo "  下一步  cd $(pwd) && npm test"
