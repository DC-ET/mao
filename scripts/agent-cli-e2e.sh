#!/usr/bin/env bash
# 半自动验收：对接真实后端跑通 login → -p 打印模式（CLOUD）以及可选 LOCAL。
# 不进 CI。用法：
#   MAO_AGENT_BASE_URL=https://mao.etarch.cn/api \
#   MAO_AGENT_E2E_USER=admin MAO_AGENT_E2E_PASS='...' \
#   bash scripts/agent-cli-e2e.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/agent-cli"
if [[ ! -d node_modules ]]; then npm ci; fi
npm run build
npm test

BASE="${MAO_AGENT_BASE_URL:-https://mao.etarch.cn/api}"
USER="${MAO_AGENT_E2E_USER:-}"
PASS="${MAO_AGENT_E2E_PASS:-}"
if [[ -z "$USER" || -z "$PASS" ]]; then
  echo "跳过在线验收：未设置 MAO_AGENT_E2E_USER / MAO_AGENT_E2E_PASS"
  exit 0
fi

BIN="$ROOT/agent-cli/bin/mao-agent.js"
node "$BIN" login --username "$USER" --password "$PASS" --base-url "$BASE"
node "$BIN" status --base-url "$BASE"
node "$BIN" -p "请只回复一个字：好" --output-format json --max-duration 180 --on-question fail --base-url "$BASE" | tee /tmp/mao-agent-e2e.json
node -e 'const r=JSON.parse(require("fs").readFileSync("/tmp/mao-agent-e2e.json","utf8")); if(r.type!=="result") throw new Error("not result"); if(r.status!=="COMPLETED") throw new Error("status="+r.status); console.log("E2E CLOUD ok session="+r.sessionId);'

if [[ "${MAO_AGENT_E2E_LOCAL:-1}" == "1" ]]; then
  MAO_AGENT_E2E_ROOT="$ROOT" node -e '
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const file = path.join(os.homedir(), ".mao", "agent-cli", "config.json");
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8") || "{}"); } catch { cfg = {}; }
const trusted = Array.isArray(cfg.trustedWorkspaces) ? cfg.trustedWorkspaces : [];
const cwd = process.env.MAO_AGENT_E2E_ROOT;
if (!trusted.includes(cwd)) {
  cfg.trustedWorkspaces = [...trusted, cwd];
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
console.log("trusted", cwd);
'
  node "$BIN" --local --yolo --workspace "$ROOT" -p "只在当前仓库用 shell 执行 echo mao-local-e2e，然后原样把输出告诉我。不要做其它事。" \
    --output-format json --max-duration 180 --on-question fail --base-url "$BASE" | tee /tmp/mao-agent-e2e-local.json
  node -e 'const r=JSON.parse(require("fs").readFileSync("/tmp/mao-agent-e2e-local.json","utf8")); if(r.type!=="result") throw new Error("not result"); if(r.status!=="COMPLETED") throw new Error("status="+r.status); console.log("E2E LOCAL ok session="+r.sessionId+" tools="+r.toolCalls.length);'
fi
