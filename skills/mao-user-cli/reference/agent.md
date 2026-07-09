# Agent 模块（agent）

## 模块职责

管理用户可见的 Agent：列表、详情、创建、更新、删除，以及 Agent 经验（experience）独立 CRUD。

## 命令选择

| 场景 | 命令 |
|------|------|
| 搜索/列出 Agent | `agent list` |
| 查看详情 | `agent get` |
| 新建 | `agent create` |
| 修改 | `agent update` |
| 删除 | `agent delete` |
| 经验列表 | `agent experience list` |
| 新增经验 | `agent experience create` |
| 更新经验 | `agent experience update` |
| 删除经验 | `agent experience delete` |

---

## 命令：mao-user agent list

### 用途

列出当前用户可见的 Agent。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--keyword` | 否 | 字符串 | 按名称等关键词过滤，对应查询参数 `keyword` |

### 示例

```bash
mao-user agent list --keyword 助手 --json
```

---

## 命令：mao-user agent get

### 用途

按 ID 获取 Agent 详情（含 tags、skillNames、experiences）。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | Agent ID |

### 示例

```bash
mao-user agent get --id 1
```

---

## 命令：mao-user agent create

### 用途

创建 Agent。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--name` | 是 | 字符串 | Agent 名称 → `name` |
| `--system-prompt` | 是 | 字符串 | 角色定义/系统提示词 → `systemPrompt` |
| `--description` | 否 | 字符串 | 描述 → `description` |
| `--tags` | 否 | 逗号分隔字符串 | 标签列表 → `tags` 数组 |
| `--skill-names` | 否 | 逗号分隔字符串 | 绑定技能名 → `skillNames` 数组 |
| `--experiences-json` | 否 | JSON 字符串 | 经验数组 → `experiences`。元素字段：`content`（字符串）、`sortOrder`（整数）、`enabled`（布尔）、可选 `id` |

### 参数约束

- `name`、`systemPrompt` 不能为空
- `--experiences-json` 必须是合法 JSON 数组

### 示例

```bash
mao-user agent create \
  --name '代码助手' \
  --system-prompt '你是资深工程师' \
  --tags 'dev,code' \
  --skill-names 'git-helper' \
  --experiences-json '[{"content":"优先读 README","sortOrder":0,"enabled":true}]'
```

---

## 命令：mao-user agent update

### 用途

更新已有 Agent。至少提供一个可更新字段。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | Agent ID |
| `--name` | 否 | 字符串 | 新名称 |
| `--description` | 否 | 字符串 | 新描述 |
| `--system-prompt` | 否 | 字符串 | 新系统提示词 |
| `--tags` | 否 | 逗号分隔 | 覆盖标签 |
| `--skill-names` | 否 | 逗号分隔 | 覆盖技能名 |
| `--experiences-json` | 否 | JSON | 覆盖经验列表 |

### 示例

```bash
mao-user agent update --id 1 --description '更新说明'
```

---

## 命令：mao-user agent delete

### 用途

删除 Agent。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | Agent ID |

### 示例

```bash
mao-user agent delete --id 1
```

---

## 命令：mao-user agent experience list

### 用途

列出某 Agent 的经验条目。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 是 | 数字 | Agent ID |

### 示例

```bash
mao-user agent experience list --agent-id 1
```

---

## 命令：mao-user agent experience create

### 用途

为 Agent 新增一条经验。

### 参数说明

| 参数 | 必填 | 类型 | 默认值 | 含义 |
|------|------|------|--------|------|
| `--agent-id` | 是 | 数字 | — | Agent ID |
| `--content` | 是 | 字符串 | — | 经验正文 → `content` |
| `--sort-order` | 否 | 整数 | 服务端默认 | 排序 → `sortOrder` |
| `--enabled` | 否 | 布尔 `true/false` | 服务端默认 | 是否启用 → `enabled` |

### 示例

```bash
mao-user agent experience create --agent-id 1 --content '先搜索再改代码' --sort-order 1 --enabled true
```

---

## 命令：mao-user agent experience update

### 用途

更新一条经验。至少提供一个字段。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 是 | 数字 | Agent ID |
| `--id` | 是 | 数字 | 经验 ID |
| `--content` | 否 | 字符串 | 新内容 |
| `--sort-order` | 否 | 整数 | 新排序 |
| `--enabled` | 否 | 布尔 | 是否启用 |

### 示例

```bash
mao-user agent experience update --agent-id 1 --id 9 --enabled false
```

---

## 命令：mao-user agent experience delete

### 用途

删除一条经验。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 是 | 数字 | Agent ID |
| `--id` | 是 | 数字 | 经验 ID |

### 示例

```bash
mao-user agent experience delete --agent-id 1 --id 9
```
