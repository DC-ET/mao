# mao-agent 终端对话客户端

`mao-agent` 是无 GUI 的终端 Agent 客户端，对接 REST + WebSocket（`/api/ws/stream`）。支持 **CLOUD**（服务端工作区）与 **LOCAL**（`--local`，本机执行工具）。

与 `mao` CLI 互补：本工具**驱动对话**；会话元数据、配置等用 `mao`。共用 `~/.mao/auth.json`。

## 安装

需 Node.js ≥ 20：

```bash
curl -fsSL https://raw.githubusercontent.com/DC-ET/mao/main/scripts/install-mao-agent.sh | bash
```

```bash
mao-agent login          # 密码无回显
mao-agent                # 交互 REPL（CLOUD）
mao-agent --local        # LOCAL，默认工作区 cwd
```

开发者克隆完整仓库后：

```bash
cd agent-cli && npm ci && npm run build && npm link
```

维护者发布后可 `npm install -g mao-agent`（包名 `mao-agent`）。

## 基本用法

```bash
mao-agent login
mao-agent                          # CLOUD REPL
mao-agent --local                  # LOCAL REPL
mao-agent "帮我总结 README"         # 首条消息后进入 REPL
mao-agent --local -p "列出当前目录" --yolo --output-format json
mao-agent ls
mao-agent resume                   # 最近更新会话（按 updatedAt）
mao-agent status
```

CI 示例（建议 CLOUD）：

```bash
mao-agent -p "检查本次 PR 是否有明显的安全问题" \
  --agent security-reviewer \
  --output-format json \
  --max-duration 900 \
  --on-question fail > result.json
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `MAO_TOKEN` / `MAO_REFRESH_TOKEN` | JWT |
| `MAO_AGENT_BASE_URL` | 到 `/api`（不含 `/v1`），自动剥误粘贴的 `/v1` |
| `MAO_AGENT_OUTPUT_FORMAT` | 默认输出格式 |

`--token` 传入的 JWT **不会**写入 `auth.json`；CI 用 `MAO_TOKEN`。

## 交互 REPL

- 执行中可排队输入下一条；`/cancel` 或 Ctrl+C 取消当前任务
- Agent 提问与 LOCAL 审批共用输入通道（方向键 / y n a）
- 斜杠命令 Tab 补全；`/copy` 复制上一回合回复
- `-p` 打印模式行为不变

## CLOUD / LOCAL 与 permissionLevel

| permissionLevel | LOCAL | CLOUD |
|-----------------|-------|-------|
| READ_ONLY | shell/write/edit/mcp 需审批 | **无影响** |
| READ_WRITE | shell/mcp 需审批 | **无影响** |
| SMART | mcp 恒审批；shell LLM 评估 | **无影响** |
| FULL | 全部自动 | **无影响** |

CLOUD 无工具审批；只读排障请用工具集受限的 Agent。

LOCAL 审批链：工作区信任 → 默认拒绝清单 → `--approve-rule` → `--yolo`/`--force` → TTY 确认。`--yolo` 不能豁免工作区信任与默认拒绝（如 `rm -rf /`）。非 TTY 默认 `--on-approval=fail`（退出码 4）。

## 退出码

| 码 | 含义 |
|----|------|
| 0 | COMPLETED |
| 1 | 一般错误 |
| 2 | FAILED |
| 3 | CANCELLED |
| 4 | LOCAL 需审批未授权 |
| 5 | `ask_user_questions` 且 `--on-question=fail` |
| 124 | `--max-duration` 超时 |

accessToken 24h，refreshToken 7 天；长期 CI 需轮换 `MAO_TOKEN`。

## 与 mao-cli 的关系

| 场景 | 工具 |
|------|------|
| 发消息、跑 Agent 循环 | mao-agent |
| 登录、查会话列表、改模型、管用户 | mao (`mao-cli` Skill) |

云端 shell 中 `MAO_TOKEN` 注入对两者均适用（mao-agent 同样可读环境变量）。
