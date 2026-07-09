# audit — 审计日志

## 用途

分页检索审计日志并查看单条详情。

## 命令选择

| 场景 | 命令 |
|------|------|
| 条件列表 | `audit list` |
| 单条详情 | `audit get` |

## 命令：audit list

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--page` | 否 | 整数 | 1 | 页码 | `page` |
| `--size` | 否 | 整数 | 20 | 每页 | `size` |
| `--user-id` | 否 | 整数 | — | 操作者用户 ID | `userId` |
| `--action` | 否 | 字符串 | — | 动作标识 | `action` |
| `--object-type` | 否 | 字符串 | — | 对象类型 | `objectType` |
| `--success` | 否 | 布尔/`true`/`false`/`0`/`1` | — | 是否成功 | `success` |
| `--start-date` | 否 | 字符串 | — | 开始日期 `YYYY-MM-DD` | `startDate` |
| `--end-date` | 否 | 字符串 | — | 结束日期 `YYYY-MM-DD` | `endDate` |

`GET /audit/logs`

成功 `data`：`records`、`total`、`page`、`size`。

```bash
mao-admin audit list --user-id 1 --success true --start-date 2026-07-01 --end-date 2026-07-09
mao-admin audit list --action login --object-type user
```

## 命令：audit get

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 审计日志 ID |

`GET /audit/logs/{id}`

```bash
mao-admin audit get --id 99
```

## 成功失败判断

- 成功：`code===0`
- 不存在或无权限：业务错误 message，exit 1
