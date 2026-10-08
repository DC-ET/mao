# settings — 系统设置

## 用途

列出系统配置项，并按 key 更新 value。需 `settings:read` / `settings:write` 权限（0.0.82 起）。

集成配置类 key（`auth.ldap.*`、`auth.feishu.*`、`upload.*`、`tools.*`、`oss.*`、`agent.*`、`notify.*`、`harness.*` 等）已支持后台可视化编辑（`agent.*`/`ws.*`/`harness.*` 为启动时构建，保存后需重启后端生效，其余即时生效）；secret 类项（`is_secret`）写入后仅返回掩码，不可读回明文。

## 公司 SSO 配置（0.0.111 起）

推荐通过管理后台「系统设置 → 登录认证 → 公司 SSO」维护。也可使用现有 `settings set`，键为 `auth.companySso.config`，value 必须是包含以下五个字段的完整 JSON 字符串：

```json
{"enabled":false,"allowedDomains":[],"allowedOrigins":[],"accessTtlSeconds":1800,"timeoutMs":3000}
```

启用时两个白名单均必填，校验域名匹配自身及子域；宿主 Origin 支持精确 HTTPS Origin、`https://*.example.com` 子域模式（不含根域，端口严格匹配）或 `*` 全来源。TTL 为 60–3600 秒，timeout 为 1–30000 毫秒；未知字段、缺失字段及非法值拒绝保存，不接受 `requireHttps` 开关。保存后新换票即时生效，`SSO_*` 环境变量不再读取或导入。校验 URL 仍由业务系统 `MaoChat.init` 指定。详见 [配置参考](config.md#公司-ssoweb-embed-sdk)。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列出设置 | `settings list` |
| 更新某项 | `settings set` |
| 批量保存 | `settings batch` |
| 测试集成配置连通性 | `settings test ldap\|feishu\|oss\|jev` |

## 命令：settings list

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--category` | 否 | 字符串 | 按分类过滤 | `category` |

`GET /system-settings`

```bash
mao settings list
mao settings list --category runtime
```

## 命令：settings set

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--key` | 是 | 字符串 | 设置键（路径参数） | 路径 `{key}` |
| `--value` | 是 | 字符串 | 设置值 | body `value` |

`PUT /system-settings/{key}`  
Body: `{ "value": "..." }`

```bash
mao settings set --key some.key --value '123'
```

## 命令：settings batch

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--items` | 是 | JSON 数组 | 批量项，如 `'[{"key":"a.b","value":"1"}]'` | body `items: [{key, value}]` |

`PUT /system-settings/batch`

```bash
mao settings batch --items '[{"key":"weixin.agentId","value":"1"},{"key":"session.titleModelId","value":"2"}]'
```

## 命令：settings test

测试集成配置连通性，需 `settings:write`。所有参数可省略：留空回落已存配置，仅传部分参数可测「未保存的修改」。

| 目标 | 参数（均可选） | 说明 |
|------|----------------|------|
| `ldap` | `--url` `--base-dn` `--user-dn` `--password` `--user-search-base` | LDAP 连接测试 |
| `feishu` | `--app-id` `--app-secret` | 飞书 OAuth 凭证测试 |
| `oss` | `--region` `--access-key-id` `--access-key-secret` `--bucket` `--sts-region-id` `--sts-endpoint` `--sts-access-key-id` `--sts-access-key-secret` `--sts-role-arn` | OSS 凭证与 STS 试签 |
| `jev` | `--endpoint` `--model` `--api-key` | Jev 前置决策端点与 API Key：发一次只读探测，校验 Key 与决策协议响应 |

`POST /system-settings/test/{ldap|feishu|oss|jev}`

```bash
mao settings test ldap
mao settings test oss --region cn-hangzhou --access-key-id AK --access-key-secret SK
mao settings test jev --endpoint https://api.typesafe.ai/v1/systemone --model jev-latest --api-key sk-...
```

## 云端终端配置（`terminal.*`，0.0.97 起）

管理后台「系统设置 → 工具与终端 → 云端终端」，均为**启动时构建，保存后需重启后端生效**。

| key | 默认 | 说明 |
|-----|------|------|
| `terminal.maxSessionsPerTask` | 5 | 单个任务同时存在的终端数上限 |
| `terminal.maxSessionsGlobal` | 50 | 全局终端数上限 |
| `terminal.idleTimeoutMinutes` | 120 | 无客户端接入且无输入的空闲回收时间（分钟） |
| `terminal.maxLifetimeHours` | 24 | 终端最长存活时间（小时），到点强制回收 |
| `terminal.outputBufferBytes` | 262144 | 断线重连回放用的输出环形缓冲字节数 |

值必须为正整数。终端使用还需 `terminal:use` 权限（默认只授管理员角色），详见 [desktop.md](desktop.md#终端)。

## 审批配置（`approval.*`，0.0.223 起）

管理后台「系统设置 → Agent 与模型 → 审批」，即时生效（每次工具审批决策时读取，无需重启）。

| key | 默认 | 说明 |
|-----|------|------|
| `approval.modelId` | 空 | LOCAL 模式工具审批（智能预审/替我审批）使用的 LLM 模型；留空则使用会话模型 |
| `approval.jev.endpoint` | `https://api.typesafe.ai/v1/systemone` | Jev 前置决策端点；OpenRouter 通道填 `https://openrouter.ai/api/alpha/decisions` |
| `approval.jev.model` | `jev-latest` | Jev 前置决策模型名；OpenRouter 通道填 `typesafe/jev-1.13` |
| `approval.jev.apiKey` | 空（secret） | Jev 前置决策 API Key；留空则关闭前置决策，直接由审批模型推理 |

Jev 前置决策：低风险工具调用直接放行（跳过审批模型推理），高风险才交审批模型；工具名与参数会发往该第三方服务，配置 apiKey 即视为开启。前置决策异常/未配置时自动降级为直接走审批模型。

管理后台「审批」卡片提供「测试连接」：用当前表单（可未保存）向端点发一次只读探测，校验 API Key 与决策协议响应。留空的端点 / 模型名 / API Key 回落已存配置。等价命令：`mao settings test jev`。

## 上下文压缩模型（`compaction.modelId`，0.0.243 起）

管理后台「系统设置 → Agent 与模型」，即时生效（每次压缩前读取，无需重启）。

| key | 默认 | 说明 |
|-----|------|------|
| `compaction.modelId` | 空 | 上下文压缩（长会话自动摘要）使用的 LLM 模型；留空则使用会话主模型 |

压缩是长任务里 token 量最大的辅助调用（把整段对话喂进去做摘要），用主模型跑摘要通常是最贵的组合，配一个便宜模型收益最直接；压缩产生的调用开销按该配置计入成本（见 [analytics.md](analytics.md)）。

留空、填非数字、或指向的模型已删除 / 已停用 / 非文本模型时，自动回退会话主模型并照常压缩。

## 成功失败判断

- 成功：`settings test *` 返回 `{ ok: true }`；set/batch 返回更新后的设置对象
- key 不存在或无权限：业务错误
