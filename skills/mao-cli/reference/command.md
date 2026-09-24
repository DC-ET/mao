# 指令模块（command / quick-command / system-command）

## 模块职责

- `quick-command`：聚合可在输入框快速选用的 skills + commands
- `command`：用户个人指令（user-commands）CRUD
- `system-command`：管理端指令管理（系统指令 CRUD + 跨用户个人指令查看/删除/复制为系统指令）。查看需 `command:read`，写入需 `command:write`

## 命令选择

| 场景 | 命令 |
|------|------|
| 快捷指令聚合列表 | `quick-command list` |
| 个人指令列表 | `command list` |
| 个人指令详情 | `command get` |
| 新建个人指令 | `command create` |
| 更新个人指令 | `command update` |
| 删除个人指令 | `command delete` |
| 管理端系统指令列表 | `system-command list` |
| 管理端个人指令列表 | `system-command list-personal` |
| 个人指令复制为系统指令 | `system-command promote-personal` |

---

## 命令：mao quick-command list

### 用途

返回快捷面板数据：`skills` 与 `commands` 两组。若传 `agentId`，skills 会按该 Agent 绑定的技能名过滤；用户技能同名时覆盖系统技能。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 否 | 数字 | Agent ID → 查询参数 `agentId` |

### 返回结果

```json
{
  "skills": [{ "type": "skill", "name": "...", "description": "..." }],
  "commands": [{ "type": "command", "name": "...", "description": "..." }]
}
```

### 示例

```bash
mao quick-command list --agent-id 1 --json
```

---

## 命令：mao command list

### 用途

列出当前用户的个人指令。

### 参数说明

无。

### 示例

```bash
mao command list
```

---

## 命令：mao command get

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 指令 ID |

### 示例

```bash
mao command get --id 5
```

---

## 命令：mao command create

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--name` | 是 | 字符串 | 指令名称 → `name` |
| `--content` | 是 | 字符串 | 指令正文 → `content` |

### 示例

```bash
mao command create --name '总结' --content '请用三点总结上文'
```

---

## 命令：mao command update

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 指令 ID |
| `--content` | 是 | 字符串 | 新正文（服务端要求必填） |
| `--name` | 否 | 字符串 | 新名称 |

### 示例

```bash
mao command update --id 5 --content '请用五句话总结' --name '五句总结'
```

---

## 命令：mao command delete

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 指令 ID |

### 示例

```bash
mao command delete --id 5
```

---

## system-command — 指令管理（管理员）

管理端指令页对应 API。查看需 `command:read`，写入需 `command:write`：

- 系统指令：`/v1/admin/system-commands`（`user_id=0`，全体用户可见；用户视角经 `GET /v1/user-commands/system`）
- 个人指令：`/v1/admin/user-commands`（跨用户 `user_id>0`，可查看与删除；支持可选 `pageNum`/`pageSize`/`keyword`/`userId` 服务端分页与过滤，总数经 `x-total-count` 响应头返回，不传参数时返回全量数组）
- 复制为系统指令：`POST /v1/admin/user-commands/:userId/:id/promote`（把该个人指令复制为 `user_id=0` 的系统指令，原个人指令保留；可选 body `name`/`content` 覆盖后再写入，名称与已有系统指令重复时返回「指令名称已存在」）

### 命令

| 场景 | 命令 |
|------|------|
| 系统指令列表 | `system-command list` |
| 系统指令详情 | `system-command get --id` |
| 新建系统指令 | `system-command create --name --content` |
| 更新系统指令 | `system-command update --id --content [--name]` |
| 删除系统指令 | `system-command delete --id` |
| 个人指令列表（跨用户） | `system-command list-personal` |
| 个人指令详情 | `system-command get-personal --user-id --id` |
| 删除个人指令 | `system-command delete-personal --user-id --id` |
| 个人指令复制为系统指令 | `system-command promote-personal --user-id --id [--name] [--content]` |

```bash
mao system-command list --json
mao system-command create --name '代码审查' --content '对当前工作区做代码审查'
mao system-command list-personal --json
mao system-command delete-personal --user-id 7 --id 21
mao system-command promote-personal --user-id 7 --id 21
mao system-command promote-personal --user-id 7 --id 21 --name '代码审查' --content '对当前改动做代码审查'
```
