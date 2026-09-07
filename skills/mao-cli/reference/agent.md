# Agent 模块（agent）

## 模块职责

管理用户可见的 Agent：列表、详情、创建、更新、删除，以及 Agent 经验（experience）独立 CRUD。

## Agent 头像（REST / 管理后台）

- `POST /api/v1/agents/avatar`：需登录及 `agent:write`，以 multipart 字段 `file` 上传 PNG / JPEG / WebP，最大 2 MiB。服务端校验内容并转为 PNG，返回 `data: { avatarUrl: "/uploads/<uuid>.png" }`。
- 创建 / 更新 Agent 的 JSON 支持 `avatarUrl`，使用上传返回的路径；更新省略字段保留原头像，传 `null` 清空。上传本身不修改 Agent，随后保存才生效。
- 列表和详情的 `avatarUrl` 为头像路径或 `null`，供客户端、后台及 SDK 共用；跨域调用方以 Mao 服务端 origin 解析 `/uploads/` 路径。
- 头像为公开展示资源，不要上传敏感内容。CLI 暂无专用头像上传/设置参数，使用管理后台或 REST。

## 系统提示词版本（REST / 管理后台）

创建及更新提示词会自动保存版本；内容不变不新增版本。管理后台「Agent 管理 → 提示词版本」支持预览和确认回滚，详见 [admin.md](admin.md#系统提示词版本与回滚)。现有 Agent 在迁移时保留当前提示词为 v1，无法恢复迁移前已覆盖的内容。

以下接口均要求 `agent:write` 权限（路径相对于 `/api/v1`）；CLI 暂无专用子命令：

| 操作 | 接口 | 返回 |
|------|------|------|
| 历史列表 | `GET /agents/:id/prompt-versions` | 按版本倒序的数组，包含 `id`、`agentId`、`version`、`systemPrompt`、`operatorId`、`sourceVersion`、`createdAt` |
| 回滚 | `POST /agents/:id/prompt-versions/:version/rollback` | 最新 Agent 详情；`:version` 为正整数版本号，无需请求体 |

回滚仅恢复提示词并生成带 `sourceVersion` 的新版本，不删除历史、不改动其他 Agent 配置。目标内容与当前一致时不重复生成版本。普通 `agent create/update` 命令同样触发服务端自动版本记录。


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

## 命令：mao agent list

### 用途

列出当前用户可见的 Agent。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--keyword` | 否 | 字符串 | 按名称等关键词过滤，对应查询参数 `keyword` |

### 示例

```bash
mao agent list --keyword 助手 --json
```

---

## 命令：mao agent get

### 用途

按 ID 获取 Agent 详情（含 tags、skillNames、experiences）。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | Agent ID |

### 示例

```bash
mao agent get --id 1
```

---

## 命令：mao agent create

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
| `--is-default` | 否 | 布尔 `true/false` | 是否设为默认 Agent → `isDefault` |
| `--default-model-id` | 否 | 数字 | Agent 默认模型 ID（须为启用中的文本模型）→ `defaultModelId`；`0` 表示清除 |

### 参数约束

- `name`、`systemPrompt` 不能为空
- `--experiences-json` 必须是合法 JSON 数组

### 示例

```bash
mao agent create \
  --name '代码助手' \
  --system-prompt '你是资深工程师' \
  --tags 'dev,code' \
  --skill-names 'git-helper' \
  --experiences-json '[{"content":"优先读 README","sortOrder":0,"enabled":true}]'
```

---

## 命令：mao agent update

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
| `--is-default` | 否 | 布尔 | 是否设为默认 Agent |
| `--default-model-id` | 否 | 数字 | Agent 默认模型 ID；`0` 表示清除（回退系统默认模型） |

### 示例

```bash
mao agent update --id 1 --description '更新说明'
```

---

## 命令：mao agent delete

### 用途

删除 Agent。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | Agent ID |

### 示例

```bash
mao agent delete --id 1
```

---

## 命令：mao agent experience list

### 用途

列出某 Agent 的经验条目。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 是 | 数字 | Agent ID |

### 示例

```bash
mao agent experience list --agent-id 1
```

---

## 命令：mao agent experience create

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
mao agent experience create --agent-id 1 --content '先搜索再改代码' --sort-order 1 --enabled true
```

---

## 命令：mao agent experience update

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
mao agent experience update --agent-id 1 --id 9 --enabled false
```

---

## 命令：mao agent experience delete

### 用途

删除一条经验。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 是 | 数字 | Agent ID |
| `--id` | 是 | 数字 | 经验 ID |

### 示例

```bash
mao agent experience delete --agent-id 1 --id 9
```
