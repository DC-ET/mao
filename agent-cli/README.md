# mao-agent CLI

无 GUI 终端对话式 Agent 客户端，对接 mao 后端 REST + WebSocket（`/api/ws/stream`）。支持 **CLOUD**（工具在服务端工作区）与 **LOCAL**（`--local`，工具在本机执行）。

与 `mao-user-cli` 互补：本工具覆盖「驱动 Agent 对话」；会话归档 / Agent / 模型等元数据请继续用 `mao-user`。两者共用 `~/.mao/auth.json`。

## 安装

需要 Node.js ≥ 20。一条命令（macOS / Linux）：

```bash
curl -fsSL https://raw.githubusercontent.com/DC-ET/mao/main/scripts/install-mao-agent.sh | bash
```

装好后：

```bash
mao-agent login          # 密码无回显
mao-agent                # 进入交互式 REPL；启动时会显示会话身份与 /help 提示
```

交互式 REPL：底部输入框 + `❯` 回显用户消息；工具调用显示为 `⏺` / `⎿` 卡片。执行中可继续输入下一条（回车进入队列）；`/cancel` 或 Ctrl+C 取消当前任务；Agent 提问与 LOCAL 审批占用同一输入通道（方向键 / y n a）。斜杠命令支持 Tab 补全；`/copy` 复制上一回合回复。打印模式（`-p`）行为不变。

开发者在完整仓库里：

```bash
cd agent-cli && npm ci && npm run build && npm link
```

维护者发布到 npm 后也可以 `npm install -g mao-agent`（包名 `mao-agent`，尚未发布到 registry 时请用上面的脚本）。

## 用法

```bash
mao-agent login
mao-agent                          # 交互式 REPL（CLOUD）
mao-agent --local                  # 交互式 REPL（本机执行工具，默认工作区为 cwd）
mao-agent "帮我总结 README"         # 发送首条消息后进入 REPL
mao-agent --local -p "列出当前目录" --yolo --output-format json
mao-agent ls
mao-agent resume                   # 恢复最近更新的会话（按 updatedAt，忽略置顶）
mao-agent status
```

CI 示例（建议 CLOUD，本机风险更低）：

```bash
mao-agent -p "检查本次 PR 是否有明显的安全问题" \
  --agent security-reviewer \
  --output-format json \
  --max-duration 900 \
  --on-question fail > result.json
```

环境变量：`MAO_TOKEN` / `MAO_REFRESH_TOKEN` / `MAO_AGENT_BASE_URL`（到 `/api` 为止，不含 `/v1`）/ `MAO_AGENT_OUTPUT_FORMAT`。

`--token` 传入的 JWT **不会**写入 `auth.json`，也不应出现在 shell 历史里；CI 请用 `MAO_TOKEN`。

## CLOUD / LOCAL 与 permissionLevel

| permissionLevel | LOCAL 下的含义 | CLOUD 下的含义 |
|---|---|---|
| READ_ONLY | shell / write_file / edit_file / mcp__* 需审批 | **无影响** |
| READ_WRITE | shell / mcp__* 需审批 | **无影响** |
| SMART | mcp__* 恒需审批；shell 经 LLM 评估 | **无影响** |
| FULL | 全部自动放行 | **无影响** |

CLOUD 模式没有工具审批，`--permission-level` 只写会话记录。真要只读排障请用工具集受限的 Agent。

LOCAL 审批门禁：工作区信任 → 默认拒绝清单 → `--approve-rule` → `--yolo`/`--force` → TTY 确认。`--yolo` **不能**豁免工作区信任与默认拒绝清单（`rm -rf /` 等）；后者只能 `--i-know-what-im-doing`。首次在某目录跑 LOCAL 会询问是否信任，结果写入 `~/.mao/agent-cli/config.json` 的 `trustedWorkspaces`。非 TTY 默认 `--on-approval=fail`（退出码 4）。拒绝工具时会同时发送 `tool_approval` 与 `tool_error`，避免会话挂死。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | COMPLETED |
| 1 | 一般性错误 |
| 2 | FAILED |
| 3 | CANCELLED |
| 4 | 需审批但未获授权（仅 LOCAL） |
| 5 | `ask_user_questions` 且 `--on-question=fail` |
| 124 | `--max-duration` 超时 |

Token 有效期：accessToken 24h，refreshToken 7 天；后端无 API Key。长期 CI 需要轮换 `MAO_TOKEN`。

设计文档：[docs/mao-agent-cli-technical-design.md](../docs/mao-agent-cli-technical-design.md)、[交互体验](../docs/mao-agent-cli-ux-design.md)
