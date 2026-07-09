# session — 管理端会话

## 用途

管理员视角检索会话、查看详情与消息，以及筛选项（用户/Agent 下拉数据）。

## 命令选择

| 场景 | 命令 |
|------|------|
| 分页筛选会话 | `session list` |
| 会话详情 | `session get` |
| 按轮次拉消息 | `session messages` |
| 用户筛选项 | `session options-users` |
| Agent 筛选项 | `session options-agents` |

## 命令：session list

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--page` | 否 | 整数 | 1 | 页码 | `page` |
| `--size` | 否 | 整数 | 20 | 每页 | `size` |
| `--user-id` | 否 | 整数 | — | 用户 ID | `userId` |
| `--agent-id` | 否 | 整数 | — | Agent ID | `agentId` |
| `--execution-mode` | 否 | 字符串 | — | 执行模式，如 `CLOUD`/`LOCAL` | `executionMode` |
| `--phase` | 否 | 字符串 | — | 阶段，如 `IDLE`/`RUNNING` 等 | `phase` |
| `--keyword` | 否 | 字符串 | — | 标题等关键词 | `keyword` |
| `--status` | 否 | 字符串 | — | 会话状态 | `status` |

`GET /admin/sessions`

```bash
mao-admin session list --user-id 1 --execution-mode LOCAL --page 1 --size 20
```

## 命令：session get

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 会话 ID |

`GET /admin/sessions/{id}`

```bash
mao-admin session get --id 100
```

## 命令：session messages

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--id` | 是 | 整数 | — | 会话 ID | 路径 |
| `--round-limit` | 否 | 整数 | 5 | 拉取轮次数 | `roundLimit` |
| `--before-message-id` | 否 | 整数 | — | 向前翻页游标 | `beforeMessageId` |

`GET /admin/sessions/{id}/messages`

成功 `data` 含 `messages`、`hasMore`、`nextBeforeMessageId`。

```bash
mao-admin session messages --id 100 --round-limit 5
mao-admin session messages --id 100 --before-message-id 500
```

## 命令：session options-users

无参数。`GET /admin/sessions/options/users`

返回 `{ id, username, displayName }[]`，用于筛选。

```bash
mao-admin session options-users
```

## 命令：session options-agents

无参数。`GET /admin/sessions/options/agents`

返回 `{ id, name }[]`。

```bash
mao-admin session options-agents
```

## 成功失败判断

- 列表成功：`data.records` + `total`/`page`/`size`
- 会话不存在：业务错误 message
