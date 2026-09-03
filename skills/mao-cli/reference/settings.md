# settings — 系统设置

## 用途

列出系统配置项，并按 key 更新 value。需 `settings:read` / `settings:write` 权限（0.0.82 起）。

集成配置类 key（`auth.ldap.*`、`auth.feishu.*`、`upload.*`、`tools.*`、`oss.*`、`agent.*`、`notify.*`、`harness.*` 等）已支持后台可视化编辑（`agent.*`/`ws.*`/`harness.*` 为启动时构建，保存后需重启后端生效，其余即时生效）；secret 类项（`is_secret`）写入后仅返回掩码，不可读回明文。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列出设置 | `settings list` |
| 更新某项 | `settings set` |
| 批量保存 | `settings batch` |
| 测试集成配置连通性 | `settings test ldap\|feishu\|oss` |

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

`POST /system-settings/test/{ldap|feishu|oss}`

```bash
mao settings test ldap
mao settings test oss --region cn-hangzhou --access-key-id AK --access-key-secret SK
```

## 云端终端配置（`terminal.*`，0.0.97 起）

管理后台「系统设置 → 集成配置 → 云端终端」，均为**启动时构建，保存后需重启后端生效**。

| key | 默认 | 说明 |
|-----|------|------|
| `terminal.maxSessionsPerTask` | 5 | 单个任务同时存在的终端数上限 |
| `terminal.maxSessionsGlobal` | 50 | 全局终端数上限 |
| `terminal.idleTimeoutMinutes` | 120 | 无客户端接入且无输入的空闲回收时间（分钟） |
| `terminal.maxLifetimeHours` | 24 | 终端最长存活时间（小时），到点强制回收 |
| `terminal.outputBufferBytes` | 262144 | 断线重连回放用的输出环形缓冲字节数 |

值必须为正整数。终端使用还需 `terminal:use` 权限（默认只授管理员角色），详见 [desktop.md](desktop.md#终端)。

## 成功失败判断

- 成功：`settings test *` 返回 `{ ok: true }`；set/batch 返回更新后的设置对象
- key 不存在或无权限：业务错误
