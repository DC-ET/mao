# settings — 系统设置

## 用途

列出系统配置项，并按 key 更新 value。需 `settings:read` / `settings:write` 权限（0.0.82 起）。

集成配置类 key（`auth.ldap.*`、`auth.feishu.*`、`upload.*`、`tools.*`、`oss.*` 等）已支持后台可视化编辑与热生效；secret 类项（`is_secret`）写入后仅返回掩码，不可读回明文。

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

## 成功失败判断

- 成功：`settings test *` 返回 `{ ok: true }`；set/batch 返回更新后的设置对象
- key 不存在或无权限：业务错误
