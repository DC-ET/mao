# admin-session — 管理端会话

## 用途

跨用户检索会话、查看详情与消息，以及筛选项（用户/Agent 下拉数据）。列表、详情和消息需要 `session:read`；归档和删除需要 `session:write`。用户下拉同时接受 `session:read`、`scheduled-task:read`、`llm-call:read`、`audit:read`；Agent 下拉同时接受前三个。定时任务、调用流水和审计复用这两个下拉，不因此打开会话列表。

## 命令选择

| 场景 | 命令 |
|------|------|
| 分页筛选会话 | `admin-session list` |
| 会话详情 | `admin-session get` |
| 按轮次拉消息 | `admin-session messages` |
| 用户筛选项 | `admin-session options-users` |
| Agent 筛选项 | `admin-session options-agents` |
| 清理失败会话 | `admin-session delete`（运行中会话被拒绝） |
| 归档会话 | `admin-session archive` |

## 命令：admin-session list

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--page` | 否 | 整数 | 1 | 页码 | `page` |
| `--size` | 否 | 整数 | 20 | 每页 | `size` |
| `--user-id` | 否 | 整数 | — | 用户 ID | `userId` |
| `--agent-id` | 否 | 整数 | — | Agent ID | `agentId` |
| `--execution-mode` | 否 | 字符串 | — | 执行模式，如 `CLOUD`/`LOCAL` | `executionMode` |
| `--phase` | 否 | 字符串 | — | 阶段，如 `IDLE`/`RUNNING` 等 | `phase` |
| `--keyword` | 否 | 字符串 | — | 标题/摘要/消息内容关键词（消息范围见 `--search-scope`） | `keyword` |
| `--search-scope` | 否 | 字符串 | `conversation` | `conversation` 只搜对话双方消息；`all` 连工具输出/系统消息一起搜 | `messageScope` |
| `--status` | 否 | 字符串 | — | 会话状态 | `status` |

`GET /admin/sessions`

关键词会同时匹配标题、摘要与消息正文。消息正文默认只搜对话双方（`USER`/`ASSISTANT`），命中片段 `matchSnippet` 同口径——工具输出、读到的文件内容、`ls` 文件名不再把会话顶上来；要反查工具输出里的词时加 `--search-scope all`（等同旧口径，含 `TOOL`/`SYSTEM`）。记录带 `sessionType`（`NORMAL`/`SIDE_TASK`/`SUBAGENT`）与 `parentSessionId`：管理后台列表「类型」列三种类型都着标签（边路任务橙色、子代理与主会话蓝色），悬停显示来源说明；`parentSessionId` 非空时指向父会话。

```bash
mao admin-session list --user-id 1 --execution-mode LOCAL --page 1 --size 20
mao admin-session list --keyword "登录页面报 500"
mao admin-session list --keyword "P单" --search-scope all
```

## 命令：admin-session get

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 会话 ID |

`GET /admin/sessions/{id}`

```bash
mao admin-session get --id 100
```

## 命令：admin-session messages

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--id` | 是 | 整数 | — | 会话 ID | 路径 |
| `--round-limit` | 否 | 整数 | 5 | 拉取轮次数 | `roundLimit` |
| `--before-message-id` | 否 | 整数 | — | 向前翻页游标 | `beforeMessageId` |
| `--compact` | 否 | 开关 | 关 | 精简载荷：不返回文件 diff 正文，并截断工具输出与过长参数 | `compact=true` |

`GET /admin/sessions/{id}/messages`

成功 `data` 含 `messages`、`hasMore`、`nextBeforeMessageId`。管理后台详情页使用 `--compact`；需要完整工具输出和 diff 时不要加这个开关（与详情页「导出记录」相同）。

```bash
mao admin-session messages --id 100 --round-limit 5
mao admin-session messages --id 100 --before-message-id 500
mao admin-session messages --id 100 --compact
```

## 命令：admin-session options-users

无参数。`GET /admin/sessions/options/users`。需要 `session:read`、`scheduled-task:read`、`llm-call:read`、`audit:read` 之一。

返回 `{ id, username, displayName }[]`，用于筛选。

```bash
mao admin-session options-users
```

## 命令：admin-session options-agents

无参数。`GET /admin/sessions/options/agents`。需要 `session:read`、`scheduled-task:read`、`llm-call:read` 之一。

返回 `{ id, name }[]`。

```bash
mao admin-session options-agents
```

## 命令：admin-session delete

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 会话 ID |

`DELETE /admin/sessions/{id}`（需 `session:write`）。运行中（RUNNING/WAITING_APPROVAL/RESUMING/CANCELLING）的会话会被拒绝（code 2001）；删除级联清理消息、上下文压缩与运行文件。

```bash
mao admin-session delete --id 100
```

## 命令：admin-session archive

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 会话 ID |

`PUT /admin/sessions/{id}/archive`（需 `session:write`），将状态置为 ARCHIVED。

```bash
mao admin-session archive --id 100
```

## 成功失败判断

- 列表成功：`data.records` + `total`/`page`/`size`；关键词命中消息时记录含 `matchSnippet`
- 会话不存在：业务错误 message

## 字段提示

列表记录与详情 VO 均含 `pendingQuestionCount`：当前等待用户回答的提问数量（内存态，此时 `phase` 仍为 `RUNNING`）。`phase=RUNNING` 且该值大于 0 表示会话正在等用户答复，管理后台「任务阶段」显示为「等待回复」。

列表记录与详情 VO 均含 `sessionType` 与 `parentSessionId`：`sessionType` 取 `NORMAL`（主会话，缺省同）/`SIDE_TASK`（边路任务）/`SUBAGENT`（子代理），管理后台「类型」列据此着色标注（主会话不标）；`parentSessionId` 为边路 / 子代理会话的父会话 ID，主会话为 `null`。

列表记录与详情 VO 均含 `failureReason`：`phase=FAILED` 时的失败原因（后端在终态落库的 `executionError`），非失败态为 `null`。管理后台列表的「失败」标签悬浮展示、详情页「会话信息」展示完整文本；移动端列表限 3 行预览。

消息接口 `GET /admin/sessions/{id}/messages` 在**最新一页**（不传 `beforeMessageId`）末尾追加等待作答的 `ask_user_questions` 伪消息：`id` 形如 `pending-ask-*`，`toolCalls` 为扁平结构（`name`/`input`/`summary`/`status=running`）。该轮真实 tool_calls 尚未落库；用户作答并整轮写入后伪消息消失，由真实记录取代。历史分页不注入。
