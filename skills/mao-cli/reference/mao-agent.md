# mao-agent 终端对话客户端

`mao-agent` 是无 GUI 的终端 Agent 客户端，对接 REST + WebSocket（`/api/ws/stream`）。支持 **CLOUD**（服务端工作区）与 **LOCAL**（`--local`，本机执行工具）。

与 `mao` CLI 互补：本工具**驱动对话**；会话元数据、配置等用 `mao`。共用 `~/.mao/auth.json`。

## 安装

需 Node.js ≥ 20：

```bash
curl -fsSL https://raw.githubusercontent.com/DC-ET/mao/main/scripts/install-mao-agent.sh | bash
```

升级（等价于重跑安装脚本；`--check` 仅检查远端是否有新版本）：

```bash
mao-agent update            # 拉取最新源码并重装
mao-agent update --check    # 只检查，不安装
```

**在 Agent / 持久 shell 中运行**：`update`、`status`、`ls`、`resume` 等子命令不读 stdin，可直接运行不会挂起；只有 chat（裸调用 / `-p`）在非 TTY 下读管道提示词，读到 EOF 立即开始执行，2s 内无输入自动跳过。

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
| `MAO_TOKEN` / `MAO_REFRESH_TOKEN` | JWT（兼容旧名 `MAO_ADMIN_TOKEN` / `MAO_USER_TOKEN` / `MAO_ADMIN_REFRESH_TOKEN` / `MAO_USER_REFRESH_TOKEN`） |
| `MAO_AGENT_BASE_URL` | 到 `/api`（不含 `/v1`），自动剥误粘贴的 `/v1` |
| `MAO_AGENT_OUTPUT_FORMAT` | 默认输出格式 |
| `MAO_AGENT_VERBOSE` | `1`/`true` 默认展开工具输出，`0`/`false` 强制折叠 |
| `MAO_AGENT_REPO` / `MAO_AGENT_REF` | `update` 默认仓库与分支/标签（等价于 `--repo` / `--ref`） |
| `NO_COLOR` | 禁用颜色 |

`--token` 传入的 JWT **不会**写入 `auth.json`；CI 用 `MAO_TOKEN`。`--password` 会进 shell 历史，交互场景请留空由程序隐藏输入。

## 约束与默认值

- `--local` 与 `--git-clone` / `--cloud-project` 互斥（后两者是 CLOUD 服务端工作区的能力）
- LOCAL 专属选项（`--yolo`、`--approve-rule`、`--on-approval`、`--strict-danger-check`、`--i-know-what-im-doing`、`-f/--force`）在非 `--local` 下使用会直接报错
- 打印模式（`-p`）+ 非 TTY + 显式 `--on-approval=ask` 会报错：非 TTY 无法弹审批，请改 `fail` 或提供 TTY
- `--permission-level` 缺省为 `READ_WRITE`，会写入会话并覆盖服务端默认值（服务端默认 `READ_ONLY`）；只影响 LOCAL 审批

## 模型解析

`--model` 与 `/model` 的取值按以下顺序解析（`mao model list-active` 可查全部候选）：

1. 纯数字 → 模型配置 `id`
2. 显示名 `name` 精确匹配（忽略首尾空格），再退一级大小写不敏感
3. 厂商模型串 `modelId` 兜底（大小写不敏感）

显示名是管理后台里看到、也是 REPL 底部状态栏显示的那一个，优先级高于厂商串——同一厂商串（如 `deepseek-v4-flash`）常对应多条模型配置（不同 key / 网关），此时按串匹配无法唯一定位，会提示 `「X」是厂商模型串，对应多条模型配置，请改用显示名或 --model <id>` 并列出候选 `id=名称`；真有多条同显示名时提示 `多个模型名为「X」，请改用 --model <id>`。Tab 补全只给显示名。

## 交互 REPL

已定稿的对话逐行写入终端 scrollback（可用终端原生滚动回看，**不使用备用屏**），只有输入框、状态行和正在流式输出的尾部属于活动区，活动区高度始终小于终端高度，所以不会整屏重绘、也不会清掉历史。用户消息以 `❯` 回显；工具调用显示为 `⏺ name  args` + `⎿` 摘要。

- 执行中可排队输入下一条；`/cancel` 或 Ctrl+C 取消当前任务
- Agent 提问与 LOCAL 审批共用输入通道，多个请求按先后顺序排队（方向键 / y n a；带危险原因的审批需再按 Enter 确认）
- 输入 `/` 弹出命令面板，↑↓ 选择、Enter 执行、Tab 填入
- 输入历史存 `~/.mao/agent-cli/history`（0600，最近 200 条），↑↓ 翻历史
- 终端最小 8 行 × 20 列；更小的窗口会自动收缩各区域
- `-p` 打印模式不加载 TUI，行为不变

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/help` | 查看斜杠命令 |
| `/session` | 当前会话信息（sessionId、Agent、模型、workspace、phase） |
| `/model <id\|name>` | 切换当前会话模型（持久写库）；无参数显示当前模型。`name` 按显示名匹配，见「模型解析」 |
| `/todo` | 查看 Todo |
| `/context` | 最近一次上下文占用（≥80% 会提示接近上限） |
| `/verbose` | 展开 / 折叠工具输出 |
| `/thinking` | 展开 / 折叠思考内容 |
| `/queue [clear]` | 查看或清空待发送队列 |
| `/cancel` | 取消当前任务 |
| `/clear` | 清屏与滚动缓冲（不删服务端历史） |
| `/copy` | 复制上一回合回复 |
| `/agent` | 如何换 Agent |
| `/exit` `/quit` | 退出 |

### 键位

| 键 | 作用 |
|----|------|
| ← → / Home End | 移动光标 / 行首行尾 |
| Alt+← Alt+→ | 按词移动 |
| Ctrl+A / Ctrl+E | 行首 / 行尾 |
| Ctrl+W / Alt+Backspace | 删除前一个词 |
| Ctrl+U / Ctrl+K | 删到行首 / 删到行尾 |
| Ctrl+J / Alt+Enter | 插入换行（多行输入） |
| 行尾 `\` 或未闭合 ``` | 自动续行 |
| ↑ ↓ | 翻输入历史（多行草稿内先移动光标） |
| Tab | 补全斜杠命令 |
| Esc | 关面板 → 清草稿 → 取消任务（逐级） |
| Ctrl+L | 清屏 |
| Ctrl+C | 有草稿清草稿；任务在跑取消任务；空闲连按两次退出 |
| Ctrl+D | 空草稿时退出 |

emoji / CJK 按整字符删除；粘贴多行文本原样进入草稿。

## 命令行选项

`mao-agent --help` 只列常用项，`mao-agent --help --all` 输出下表全部内容加退出码与 permissionLevel 矩阵。

**通用**

| 选项 | 说明 |
|------|------|
| `-p, --print [prompt]` | 打印模式：发一条消息，等任务终态后退出 |
| `--local` | 工具在本机工作区执行（executionMode=LOCAL） |
| `--agent <id\|name>` | 指定 Agent；缺省用 isDefault=true 的那个 |
| `--model <id\|name>` | 指定模型（会持久修改会话模型），见「模型解析」 |
| `--workspace <path>` | CLOUD：服务端工作区路径；LOCAL：本机工作区（默认 cwd） |
| `--thinking` | 展开思考内容（默认折叠） |
| `--ascii` | 纯 ASCII 输出：直角边框 + 无 emoji/宽字符 |
| `--color` / `--no-color` | 强制启用 / 禁用颜色 |
| `-h, --help` / `--all` | 帮助；`--help --all` 输出完整帮助 |
| `-V, --version` | 版本号 |
| `--username` / `--password` | login 用（密码缺省隐藏输入） |
| `--check` / `--ref` / `--repo` / `--src-dir` | update 用 |

**会话**

| 选项 | 说明 |
|------|------|
| `--resume [sessionId]` | 恢复会话；省略 id 恢复最近更新的一个 |
| `--continue` | 恢复本地记录的「上次使用会话」 |
| `--permission-level <level>` | READ_ONLY\|READ_WRITE\|SMART\|FULL，写入会话；只影响 LOCAL 审批 |
| `--if-running <wait\|cancel\|fail>` | 目标会话仍在跑时的策略，默认 wait |
| `--on-question <ask\|fail>` | 遇到 `ask_user_questions`：TTY 默认 ask，打印/非 TTY 默认 fail |
| `--max-duration <sec>` | 单次任务墙钟上限，超时发 cancel 并以 124 退出 |
| `--cloud-project <key>` | 复用已存在的服务端项目目录（仅 CLOUD） |
| `--git-clone <url>` / `--git-branch` | 建会话时克隆仓库到服务端工作区（仅 CLOUD） |
| `--no-queue` | 执行中禁止预输入下一条 |

**输出与诊断**

| 选项 | 说明 |
|------|------|
| `--output-format <text\|json\|stream-json>` | 输出格式，默认 text |
| `--verbose-tools` | 交互模式展开工具输出 |
| `--include-tool-io` | json 输出带上 `toolCalls[].arguments` / `result` |
| `--stream-partial-output` | 配合 stream-json 逐 delta 输出 |
| `--replay-full` | resume 时完整打印历史消息（默认只摘要最后 3 轮） |
| `--debug` | WS 收发帧与 REST 摘要打到 stderr（已脱敏） |
| `--trace-file <path>` | 完整事件流落盘为 NDJSON |
| `--base-url <url>` | API 根地址（到 `/api` 为止，不含 `/v1`） |
| `--token <jwt>` | 一次性覆盖本地 token（更推荐 `MAO_TOKEN`） |
| `--timeout-ms <n>` | 单次 REST 请求超时，默认 30000 |

**LOCAL 模式**（非 `--local` 时使用会报错）

| 选项 | 说明 |
|------|------|
| `--yolo` / `-f, --force` | 自动放行服务端要求的审批（不豁免工作区信任与默认拒绝清单） |
| `--approve-rule <tool:pattern>` | 放行匹配的工具，可重复。例：`--approve-rule 'shell:ls *'`。必须写成 `tool:pattern`；`*` / `**` / `?` 不跨越分号、管道、重定向、`$`、反引号等 shell 元字符，区分大小写；`*`、`*:*`、只写工具名、空 pattern 会被拒绝（退出码 4） |
| `--on-approval <ask\|fail>` | 需审批时：TTY 默认 ask，打印/非 TTY 默认 fail。ask 要求 stdin 与 stdout 都是 TTY，管道输入时按 fail 处理 |
| `--strict-danger-check` | dangerReason 非空时即使 `--yolo` 也必须人工确认 |
| `--i-know-what-im-doing` | 豁免默认拒绝清单（`rm -rf /`、fork bomb、写 `~/.ssh` 等） |

## 本地文件

| 路径 | 内容 |
|------|------|
| `~/.mao/auth.json` | JWT（与 `mao` CLI 共用，0600） |
| `~/.mao/agent-cli/config.json` | 用户配置：baseUrl、默认 Agent/模型、界面偏好、`trustedWorkspaces`（0600） |
| `~/.mao/agent-cli/history` | 输入历史，最近 200 条（0600） |
| `~/.mao/agent-cli/runtime/` | 每会话运行期文件（仅在工具结果超 900KB 时落盘，0600），保留最近 20 个会话、7 天 |
| `<项目>/.mao/agent.json` | 项目级配置，向上找到 git 根为止 |

配置优先级：命令行 > 环境变量 > 项目配置 > 用户配置 > 内置默认。旧版 `~/.mao-cli` / `~/.mao-user-cli` / `~/.mao-admin-cli` 下的 `auth.json` 首次使用时自动迁移到 `~/.mao/auth.json`。

## LOCAL 运行前提与边界

`--local` 才涉及以下内容；CLOUD 模式工具全在服务端执行，不受此节约束。

- **需要 bash**：shell 工具固定通过 bash 执行，启动时按 PATH → `/bin` → `/usr/bin` → `/usr/local/bin` → `/opt/homebrew/bin` 解析绝对路径，找不到即报错。容器镜像需自带可执行 bash。技能包解压为内置 Node 实现，**不需要 python3 或 unzip**
- **路径沙箱 = 已信任工作区 + 本会话 runtime 目录**：`read_file` / `write_file` / `edit_file`、`glob_search` / `grep_search` 的搜索根、`shell` 的 `workdir` 都必须落在边界内。`../` 越界、边界外的绝对路径、指向外部的符号链接一律拒绝；`~` 展开后同样要在边界内
- **工作区以本地为权威**：服务端下发的 workspace 只能等于本地工作区或位于其内部，否则该次工具调用直接失败（`拒绝服务端下发的工作区 ...`）
- **shell 内不注入 token**：子进程环境只有登录 shell 的 PATH 加 `TERM=dumb` / `PS1=''`，不含 `MAO_TOKEN` / `MAO_REFRESH_TOKEN`。要在 shell 工具里调 `mao` / `mao-agent`，需先 `mao login`（读 `~/.mao/auth.json`）。这与桌面 Electron（会注入 token）是有意差异
- **MCP**：本地 stdio 服务器启动前需过审批；子进程环境为白名单（PATH / HOME / LANG / LC_* / TERM / TMPDIR / TZ / USER / LOGNAME + Windows 若干 + 该 server 显式声明的 `env`）；stdio 传输为行分隔 JSON；单服务器连接超时 45s、工具调用 120s；超时或退出杀整个进程组
- **技能同步**：技能包只能从当前 `baseUrl` 同源地址下载，跨源 `syncUrl` 会被拒绝；包内含 `../`、绝对路径或符号链接的条目会被拒绝
- **`AGENTS.md`** 注入系统提示时上限 100KB（与云端一致），超出截断
- 读取图片上限 5MB，终端版不做缩放，超限需先本地压缩或裁剪

## CLOUD / LOCAL 与 permissionLevel

| permissionLevel | LOCAL | CLOUD |
|-----------------|-------|-------|
| READ_ONLY | shell/write/edit/mcp 需审批 | **无影响** |
| READ_WRITE | shell/mcp 需审批 | **无影响** |
| SMART | mcp 恒审批；shell LLM 评估 | **无影响** |
| FULL | 全部自动 | **无影响** |

CLOUD 无工具审批；只读排障请用工具集受限的 Agent。

LOCAL 审批链：工作区信任（含 `read_file` / `glob_search` / `grep_search`）→ 默认拒绝清单 → `--approve-rule` → 本次会话选过「总是允许」的**精确**工具+命令 → `--yolo`/`--force` → TTY 确认。`--yolo` 不能豁免工作区信任与默认拒绝（如 `rm -rf /`）。shell 的每次 exec / `write_stdin`、以及每个 MCP stdio 进程启动都各自过一遍这条链——复用已有 shell 会话不会沿用首次批准。`action:'await_async'` 只领取该会话已缓冲的输出、不向 bash 交付新文本，因此不触发审批。ask 需要 stdin 与 stdout 同为 TTY，否则按 `--on-approval=fail` 处理（退出码 4）。

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
