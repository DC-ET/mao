# model — LLM 模型

## 用途

配置 OpenAI 兼容模型、测试连通性、启停与删除。

## 命令选择

| 场景 | 命令 |
|------|------|
| 分页筛选模型 | `model list` |
| 详情 | `model get` |
| 已有提供商名 | `model providers` |
| 新建 | `model create` |
| 更新 | `model update` |
| 删除 | `model delete` |
| 启停 | `model set-status` |
| 连通性测试 | `model test` |

**重要**：`create`/`update` 的 `--base-url` 是**模型服务商 API 地址**。管理后台地址请用环境变量 `MAO_ADMIN_BASE_URL`，不要同时用全局 `--base-url`。

## 命令：model list

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
mao-admin model list --provider openai --status 1
```

## 命令：model get

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 模型 ID |

`GET /models/{id}`

```bash
mao-admin model get --id 1
```

## 命令：model providers

无参数。`GET /models/providers` → 字符串数组。

```bash
mao-admin model providers
```

## 命令：model create

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
export MAO_ADMIN_BASE_URL=https://maoadmin.etarch.cn/api/v1
mao-admin model create \
  --name 'GPT-4o' \
  --provider openai \
  --base-url 'https://api.openai.com/v1' \
  --api-key 'sk-xxx' \
  --model-id 'gpt-4o' \
  --context-window-tokens 128000 \
  --supports-vision 1 \
  --is-default 0
```

## 命令：model update

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | 模型 ID | 路径 |
| `--name` | 否 | 字符串 | 显示名 | `name` |
| `--provider` | 否 | 字符串 | 提供商 | `provider` |
| `--base-url` | 否 | 字符串 | 模型 API 地址 | `baseUrl` |
| `--api-key` | 否 | 字符串 | API Key | `apiKey` |
| `--model-id` | 否 | 字符串 | 模型 ID | `modelId` |
| `--context-window-tokens` | 否 | 整数 | 上下文窗口 | `contextWindowTokens` |
| `--supports-vision` | 否 | `0`/`1` | 视觉 | `supportsVision` |
| `--is-default` | 否 | `0`/`1` | 默认 | `isDefault` |

`PUT /models/{id}`

```bash
mao-admin model update --id 1 --name 'GPT-4o-prod' --is-default 1
```

## 命令：model delete

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 模型 ID |

`DELETE /models/{id}`

```bash
mao-admin model delete --id 1
```

## 命令：model set-status

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | 模型 ID | 路径 |
| `--status` | 是 | 整数 | 状态（通常 `1` 启用 / `0` 停用） | `status` |

`PATCH /models/{id}/status`

```bash
mao-admin model set-status --id 1 --status 1
```

## 命令：model test

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 模型 ID |

`POST /models/{id}/test`

- 成功：`code===0`（连通正常）
- 失败：stderr 输出错误信息（Key/URL/网络等）

```bash
mao-admin model test --id 1 --raw
```
