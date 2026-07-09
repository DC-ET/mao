# agent — Agent 与经验

## 用途

管理 Agent 配置（系统提示词、标签、技能名、经验），以及经验条目的独立 CRUD。

## 命令选择

| 场景 | 命令 |
|------|------|
| 搜索/列出 Agent | `agent list` |
| 查看详情 | `agent get` |
| 新建 | `agent create` |
| 更新 | `agent update` |
| 删除 | `agent delete` |
| 经验列表/增删改 | `agent experience ...` |

## 命令：agent list

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--keyword` | 否 | 字符串 | 名称关键词 | `keyword` |

`GET /agents`

```bash
mao-admin agent list --keyword 客服
```

## 命令：agent get

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | Agent ID |

`GET /agents/{id}`

```bash
mao-admin agent get --id 1
```

## 命令：agent create

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--name` | 是 | 字符串 | Agent 名称 | `name` |
| `--system-prompt` | 是 | 字符串 | 角色/系统提示词 | `systemPrompt` |
| `--description` | 否 | 字符串 | 描述 | `description` |
| `--tags` | 否 | 逗号分隔字符串 | 标签列表 | `tags` |
| `--skill-names` | 否 | 逗号分隔字符串 | 全局技能名列表 | `skillNames` |
| `--experiences-json` | 否 | JSON 数组字符串 | 经验对象数组 | `experiences` |

经验对象字段：

| 字段 | 类型 | 含义 |
|------|------|------|
| `content` | 字符串 | 经验正文 |
| `sortOrder` | 整数 | 排序，越小越靠前 |
| `enabled` | 布尔 | 是否启用 |
| `id` | 整数 | 更新时可选 |

`POST /agents`

```bash
mao-admin agent create \
  --name '客服助手' \
  --system-prompt '你是专业客服' \
  --description '处理售后' \
  --tags 客服,售后 \
  --skill-names bigdata-cli \
  --experiences-json '[{"content":"先确认订单号","sortOrder":0,"enabled":true}]'
```

## 命令：agent update

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | Agent ID | 路径 |
| `--name` | 否 | 字符串 | 名称 | `name` |
| `--system-prompt` | 否 | 字符串 | 系统提示词 | `systemPrompt` |
| `--description` | 否 | 字符串 | 描述 | `description` |
| `--tags` | 否 | 逗号分隔字符串 | 标签 | `tags` |
| `--skill-names` | 否 | 逗号分隔字符串 | 技能名 | `skillNames` |
| `--experiences-json` | 否 | JSON 数组 | 经验（传入则按服务端更新语义处理） | `experiences` |

`PUT /agents/{id}`

```bash
mao-admin agent update --id 1 --name '客服助手V2' --skill-names bigdata-cli,xlsx
```

## 命令：agent delete

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | Agent ID |

`DELETE /agents/{id}`

```bash
mao-admin agent delete --id 1
```

## 命令：agent experience list

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 是 | 整数 | Agent ID |

`GET /agents/{agentId}/experiences`

```bash
mao-admin agent experience list --agent-id 1
```

## 命令：agent experience create

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--agent-id` | 是 | 整数 | Agent ID | 路径 |
| `--content` | 否 | 字符串 | 经验内容 | `content` |
| `--sort-order` | 否 | 整数 | 排序 | `sortOrder` |
| `--enabled` | 否 | 布尔/`0`/`1` | 是否启用 | `enabled` |

`POST /agents/{agentId}/experiences`

```bash
mao-admin agent experience create --agent-id 1 --content '优先查知识库' --sort-order 1 --enabled true
```

## 命令：agent experience update

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--agent-id` | 是 | 整数 | Agent ID | 路径 |
| `--id` | 是 | 整数 | 经验 ID | 路径 |
| `--content` | 否 | 字符串 | 内容 | `content` |
| `--sort-order` | 否 | 整数 | 排序 | `sortOrder` |
| `--enabled` | 否 | 布尔 | 启用 | `enabled` |

`PUT /agents/{agentId}/experiences/{id}`

```bash
mao-admin agent experience update --agent-id 1 --id 10 --enabled false
```

## 命令：agent experience delete

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 是 | 整数 | Agent ID |
| `--id` | 是 | 整数 | 经验 ID |

`DELETE /agents/{agentId}/experiences/{id}`

```bash
mao-admin agent experience delete --agent-id 1 --id 10
```

## 成功失败判断

- 创建时缺少 `name` 或 `system-prompt` → CLI 本地报错或服务端参数错误
- 成功返回 Agent / Experience VO
