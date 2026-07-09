# 指令模块（command / quick-command）

## 模块职责

- `quick-command`：聚合可在输入框快速选用的 skills + commands
- `command`：用户个人指令（user-commands）CRUD

## 命令选择

| 场景 | 命令 |
|------|------|
| 快捷指令聚合列表 | `quick-command list` |
| 个人指令列表 | `command list` |
| 个人指令详情 | `command get` |
| 新建个人指令 | `command create` |
| 更新个人指令 | `command update` |
| 删除个人指令 | `command delete` |

---

## 命令：mao-user quick-command list

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
mao-user quick-command list --agent-id 1 --json
```

---

## 命令：mao-user command list

### 用途

列出当前用户的个人指令。

### 参数说明

无。

### 示例

```bash
mao-user command list
```

---

## 命令：mao-user command get

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 指令 ID |

### 示例

```bash
mao-user command get --id 5
```

---

## 命令：mao-user command create

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--name` | 是 | 字符串 | 指令名称 → `name` |
| `--content` | 是 | 字符串 | 指令正文 → `content` |

### 示例

```bash
mao-user command create --name '总结' --content '请用三点总结上文'
```

---

## 命令：mao-user command update

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 指令 ID |
| `--content` | 是 | 字符串 | 新正文（服务端要求必填） |
| `--name` | 否 | 字符串 | 新名称 |

### 示例

```bash
mao-user command update --id 5 --content '请用五句话总结' --name '五句总结'
```

---

## 命令：mao-user command delete

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 指令 ID |

### 示例

```bash
mao-user command delete --id 5
```
