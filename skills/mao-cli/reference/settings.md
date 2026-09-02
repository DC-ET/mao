# settings — 系统设置

## 用途

列出系统配置项，并按 key 更新 value。需 `settings:read` / `settings:write` 权限（0.0.82 起）。

集成配置类 key（`auth.ldap.*`、`auth.feishu.*`、`upload.*`、`tools.*`、`oss.*` 等）已支持后台可视化编辑与热生效；secret 类项（`is_secret`）写入后仅返回掩码，不可读回明文。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列出设置 | `settings list` |
| 更新某项 | `settings set` |

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

> 后端另有 `PUT /system-settings/batch`（批量保存）与 `POST /system-settings/test/{ldap|feishu|oss}`（集成配置测试连接，需 `settings:write`），mao-cli 暂未封装，可用 `--raw` 场景外直接调 REST。

## 成功失败判断

- 成功：返回更新后的设置对象
- key 不存在或无权限：业务错误
