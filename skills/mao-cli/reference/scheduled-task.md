# 定时任务模块（scheduled-task）

## 模块职责

查询和维护定时任务：列表、详情、更新名称/提示词/cron/状态/一次性开关、删除。默认仅操作当前用户任务；持 `session:read` 的管理端可跨用户查看（`list-all` / 详情），持 `scheduled-task:write` 的管理端可跨用户更新/删除/启停。

任务名称上限 200 字符，提示词上限 10000 字符，均不允许为空（服务端校验，超限返回参数错误）。

## 明确不包含

当前用户 REST API 暂未暴露创建定时任务端点；创建入口是 Agent 内置工具 `create_scheduled_task`。本 CLI 的 `scheduled-task create` 会直接报错提示边界。

`create_scheduled_task` 仅响应用户直接表达的定时处理需求；Agent 不得在自身任务执行中擅自创建（任务结束后仍会循环）。执行期内的轮询/检查走 Shell，不走定时任务。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列出任务 | `scheduled-task list` |
| 全量列表（跨用户） | `scheduled-task list-all` |
| 查看详情 | `scheduled-task get` |
| 更新任务 | `scheduled-task update` |
| 删除任务 | `scheduled-task delete` |

---

## 命令：mao scheduled-task list

### 用途

列出当前用户的定时任务，按创建时间倒序。

### 示例

```bash
mao scheduled-task list --json
```

---

## 命令：mao scheduled-task list-all

### 用途

全量列出所有用户的定时任务（分页 + 筛选），需 `session:read` 权限。管理排查用。

### 参数说明

| 参数 | 必填 | 类型 | 默认 | 含义 |
|------|------|------|------|------|
| `--page-num` | 否 | 数字 | 1 | 页码 |
| `--page-size` | 否 | 数字 | 20 | 每页数量 |
| `--keyword` | 否 | 字符串 | - | 任务名称/内容模糊匹配 |
| `--user-id` | 否 | 数字 | - | 按用户过滤 |
| `--agent-id` | 否 | 数字 | - | 按 Agent 过滤 |
| `--status` | 否 | 字符串 | - | `ACTIVE` 或 `PAUSED` |
| `--finished` | 否 | 布尔字符串 | - | `true` 已完结 / `false` 进行中 |

`GET /scheduled-tasks/all`

### 示例

```bash
mao scheduled-task list-all --json
mao scheduled-task list-all --page-num 2 --page-size 50
mao scheduled-task list-all --user-id 7 --status PAUSED
mao scheduled-task list-all --keyword 报告 --finished false
```

---

## 命令：mao scheduled-task get

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 定时任务 ID |

### 示例

```bash
mao scheduled-task get --id 3 --json
```

---

## 命令：mao scheduled-task update

### 用途

更新任务名称、提示词、cron 表达式或状态。服务端会校验 cron 表达式与名称/提示词长度，并在恢复 ACTIVE 时重新计算下次触发时间。本人任务直接可改；他人任务需 `scheduled-task:write`（管理端编辑/启停/删除）。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 定时任务 ID |
| `--name` | 否 | 字符串 | 任务名称 |
| `--prompt` | 否 | 字符串 | 定时触发时发送给 Agent 的提示词 |
| `--cron-expression` | 否 | 字符串 | Spring cron 表达式 |
| `--status` | 否 | 字符串 | `ACTIVE` 或 `PAUSED` |

至少提供一个更新字段。

### 示例

```bash
mao scheduled-task update --id 3 --status PAUSED
mao scheduled-task update --id 3 --cron-expression '0 0 9 * * *'
```

---

## 命令：mao scheduled-task delete

### 用途

删除定时任务。本人任务直接可删；他人任务需 `scheduled-task:write`。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 定时任务 ID |

### 示例

```bash
mao scheduled-task delete --id 3
```

---

## Cron 预览（REST）

`POST /scheduled-tasks/cron-preview`（需 `session:read`），请求体 `{ "expression": "0 0 9 * * ?", "count": 3 }`，返回 `{ valid, oneShot, nextFireTimes[], message }`：

- `valid=false` 时带 `message`（该接口用正常响应对表达式的错误，方便编辑过程中反复预览）；`count` 取值 1..10。
- `nextFireTimes` 与调度器同源（同一 croner 解析 + Asia/Shanghai），即预览看到的触发时间就是实际执行时间。
- 管理后台定时任务「编辑」弹窗已内置该预览；CLI 暂未提供 `scheduled-task preview` 子命令。

## 返回字段

常见字段：`id`、`userId`、`agentId`、`sessionId`、`name`、`prompt`、`cronExpression`、`status`、`lastFireTime`、`lastExecutionStatus`、`nextFireTime`、`fireCount`、`createdAt`、`updatedAt`。
