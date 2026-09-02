# 模型模块（model）

## 模块职责

查询用户端可用的 LLM 模型，以及管理端的模型增删改、启停与连通性测试。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列出启用中的模型 | `model list-active` |
| 获取默认模型 | `model default` |
| 分页筛选（含停用） | `model list` |
| 按 ID 查询 | `model get` |
| 列出提供商 | `model providers` |
| 新建模型配置 | `model create` |
| 更新模型配置 | `model update` |
| 删除 | `model delete` |
| 启停 | `model set-status` |
| 连通性测试 | `model test` |

`create`/`update` 的 `--base-url` 是**模型服务商 API 地址**。服务端地址请用环境变量 `MAO_BASE_URL`，不要同时用全局 `--base-url`。

---

## 命令：mao model list-active

### 用途

获取状态为启用的模型列表，创建会话时常用。

### 参数说明

无业务参数。需要鉴权。

### 返回结果

数组，元素常见字段：`id`、`name`、`provider`、`modelId`、`supportsVision`、`isDefault`、`contextWindowTokens`、`status`。

### 示例

```bash
mao model list-active --json
```

---

## 命令：mao model default

### 用途

获取系统默认模型；若无默认可能返回 `null`。

### 参数说明

无。

### 示例

```bash
mao model default
```

---

## 命令：mao model get

### 用途

按主键 ID 获取模型详情。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 模型主键 ID，对应路径 `/models/{id}` |

注意：这里的 `--id` 是数据库主键，不是模型厂商的 `modelId` 字符串。

### 示例

```bash
mao model get --id 3
```

---

## 命令：mao model providers

### 用途

列出已配置的模型提供商名称列表。

### 参数说明

无。

### 示例

```bash
mao model providers
```

---

## 命令：mao model list

### 用途

分页筛选全部模型（含停用）。管理端常用。

### 参数说明

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--page` | 否 | 整数 | 1 | 页码 | `page` |
| `--size` | 否 | 整数 | 10 | 每页 | `size` |
| `--keyword` | 否 | 字符串 | — | 关键词 | `keyword` |
| `--provider` | 否 | 字符串 | — | 提供商 | `provider` |
| `--status` | 否 | 整数 | — | 状态 | `status` |
| `--supports-vision` | 否 | 整数 | — | 是否支持视觉 `0/1` | `supportsVision` |
| `--is-default` | 否 | 整数 | — | 是否默认 `0/1` | `isDefault` |

`GET /models`

```bash
mao model list --provider openai --status 1
```

---

## 命令：mao model create

### 用途

新建 OpenAI 兼容模型配置。需要管理权限。

### 参数说明

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--name` | 是 | 字符串 | 显示名称 | `name` |
| `--provider` | 是 | 字符串 | 提供商标识 | `provider` |
| `--base-url` | 是 | 字符串 | 模型 API Base URL | `baseUrl` |
| `--api-key` | 是 | 字符串 | API Key | `apiKey` |
| `--model-id` | 是 | 字符串 | 上游模型 ID | `modelId` |
| `--context-window-tokens` | 否 | 整数 | 上下文窗口 token 数 | `contextWindowTokens` |
| `--supports-vision` | 否 | `0`/`1` | 是否支持视觉 | `supportsVision` |
| `--is-default` | 否 | `0`/`1` | 是否默认模型 | `isDefault` |

`POST /models`

```bash
export MAO_BASE_URL=https://mao.etarch.cn/api/v1
mao model create \
  --name 'GPT-4o' \
  --provider openai \
  --base-url 'https://api.openai.com/v1' \
  --api-key 'sk-xxx' \
  --model-id 'gpt-4o' \
  --context-window-tokens 128000 \
  --supports-vision 1 \
  --is-default 0
```

---

## 命令：mao model update

### 用途

更新已有模型配置。需要管理权限。

### 参数说明

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | 模型 ID | 路径 |
| `--name` | 否 | 字符串 | 显示名 | `name` |
| `--provider` | 否 | 字符串 | 提供商 | `provider` |
| `--base-url` | 否 | 字符串 | 模型 API 地址 | `baseUrl` |
| `--api-key` | 否 | 字符串 | API Key；**留空表示不修改**（0.0.84 起编辑弹窗不回填掩码值，误提交掩码会被拦截提示） | `apiKey` |
| `--model-id` | 否 | 字符串 | 模型 ID | `modelId` |
| `--context-window-tokens` | 否 | 整数 | 上下文窗口 | `contextWindowTokens` |
| `--supports-vision` | 否 | `0`/`1` | 视觉 | `supportsVision` |
| `--is-default` | 否 | `0`/`1` | 默认 | `isDefault` |

`PUT /models/{id}`

```bash
mao model update --id 1 --name 'GPT-4o-prod' --is-default 1
```

---

## 命令：mao model delete

### 用途

删除模型。需要管理权限。

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 模型 ID |

`DELETE /models/{id}`

```bash
mao model delete --id 1
```

---

## 命令：mao model set-status

### 用途

启停模型。需要管理权限。

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | 模型 ID | 路径 |
| `--status` | 是 | 整数 | 状态（通常 `1` 启用 / `0` 停用） | `status` |

`PATCH /models/{id}/status`

```bash
mao model set-status --id 1 --status 1
```

---

## 命令：mao model test

### 用途

测试模型连通性。需要管理权限。

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 模型 ID |

`POST /models/{id}/test`

```bash
mao model test --id 1 --raw
```

## 与会话的关系

创建/更新会话时可传 `--model-id`（模型主键）。不传则服务端使用默认模型。
