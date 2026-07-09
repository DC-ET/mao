# 待办模块（todo）

## 模块职责

管理会话内的待办事项（Session Todo）：列表、更新状态/内容、删除。不创建新待办（创建由 Agent 运行时工具完成）。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列出待办 | `todo list` |
| 更新待办 | `todo update` |
| 删除待办 | `todo delete` |

---

## 命令：mao-user todo list

### 用途

获取指定会话的待办列表，按排序字段返回。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--session-id` | 是 | 数字 | 会话 ID → 路径 `/sessions/{id}/todos` |

### 返回结果

数组元素：`id`、`content`、`status`。

### 示例

```bash
mao-user todo list --session-id 12 --json
```

---

## 命令：mao-user todo update

### 用途

更新待办状态或内容。将状态设为 `in_progress` 时，服务端会把同会话其它 `in_progress` 项降为 `pending`。

### 参数说明

| 参数 | 必填 | 类型 | 取值 | 含义 |
|------|------|------|------|------|
| `--session-id` | 是 | 数字 | — | 会话 ID |
| `--todo-id` | 是 | 数字 | — | 待办 ID |
| `--status` | 条件 | 字符串 | `pending` \| `in_progress` \| `completed` \| `cancelled` | 状态 → `status` |
| `--content` | 条件 | 字符串 | — | 内容 → `content` |

`--status` 与 `--content` 至少提供一个。

### 示例

```bash
mao-user todo update --session-id 12 --todo-id 3 --status completed
mao-user todo update --session-id 12 --todo-id 3 --content '改写说明'
```

---

## 命令：mao-user todo delete

### 用途

删除指定待办。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--session-id` | 是 | 数字 | 会话 ID |
| `--todo-id` | 是 | 数字 | 待办 ID |

### 示例

```bash
mao-user todo delete --session-id 12 --todo-id 3
```
