# 定时任务模块（scheduled-task）

## 模块职责

查询和维护当前用户的定时任务：列表、详情、更新名称/提示词/cron/状态、删除。

## 明确不包含

当前用户 REST API 暂未暴露创建定时任务端点；创建入口是 Agent 内置工具 `create_scheduled_task`。本 CLI 的 `scheduled-task create` 会直接报错提示边界。

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

全量列出所有用户的定时任务（分页），需 `session:read` 权限。管理排查用。

### 参数说明

| 参数 | 必填 | 类型 | 默认 | 含义 |
|------|------|------|------|------|
| `--page-num` | 否 | 数字 | 1 | 页码 |
| `--page-size` | 否 | 数字 | 20 | 每页数量 |

`GET /scheduled-tasks/all`

### 示例

```bash
mao scheduled-task list-all --json
mao scheduled-task list-all --page-num 2 --page-size 50
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

更新任务名称、提示词、cron 表达式或状态。服务端会校验 cron 表达式，并在恢复 ACTIVE 时重新计算下次触发时间。

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

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 定时任务 ID |

### 示例

```bash
mao scheduled-task delete --id 3
```

## 返回字段

常见字段：`id`、`userId`、`agentId`、`sessionId`、`name`、`prompt`、`cronExpression`、`status`、`lastFireTime`、`lastExecutionStatus`、`nextFireTime`、`fireCount`、`createdAt`、`updatedAt`。
