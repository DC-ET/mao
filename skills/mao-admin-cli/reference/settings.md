# settings — 系统设置

## 用途

列出系统配置项，并按 key 更新 value。

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
mao-admin settings list
mao-admin settings list --category runtime
```

## 命令：settings set

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--key` | 是 | 字符串 | 设置键（路径参数） | 路径 `{key}` |
| `--value` | 是 | 字符串 | 设置值 | body `value` |

`PUT /system-settings/{key}`  
Body: `{ "value": "..." }`

```bash
mao-admin settings set --key some.key --value '123'
```

## 成功失败判断

- 成功：返回更新后的设置对象
- key 不存在或无权限：业务错误
