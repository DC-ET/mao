# runtime — 运行监控

## 用途

查看运行相关会话列表，以及会话陈旧阈值（分钟）。

## 命令选择

| 场景 | 命令 |
|------|------|
| 运行态会话列表 | `runtime sessions` |
| 陈旧判定阈值 | `runtime stale-threshold` |

与 `session list` 的区别：未传 `--phase` 时，服务端默认聚焦  
`RUNNING,RESUMING,WAITING_APPROVAL,FAILED,CANCELLED`。

## 命令：runtime sessions

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--page` | 否 | 整数 | 1 | 页码 | `page` |
| `--size` | 否 | 整数 | 20 | 每页 | `size` |
| `--user-id` | 否 | 整数 | — | 用户 ID | `userId` |
| `--agent-id` | 否 | 整数 | — | Agent ID | `agentId` |
| `--execution-mode` | 否 | 字符串 | — | `CLOUD`/`LOCAL` 等 | `executionMode` |
| `--phase` | 否 | 字符串 | 见上默认 | 阶段过滤（可逗号多值，由服务端解析） | `phase` |
| `--keyword` | 否 | 字符串 | — | 关键词 | `keyword` |
| `--status` | 否 | 字符串 | — | 状态 | `status` |

`GET /admin/runtime/sessions`

```bash
mao-admin runtime sessions --page 1 --size 20
mao-admin runtime sessions --phase RUNNING --execution-mode LOCAL
```

## 命令：runtime stale-threshold

无参数。`GET /admin/runtime/stale-threshold`

成功 `data` 形如 `{ "staleMinutes": <number> }`。结合会话 `lastActivityAt` 判断是否陈旧。

```bash
mao-admin runtime stale-threshold
```

## 成功失败判断

- `code===0` 成功
- 列表结构与管理端会话列表一致（`records`/`total`/`page`/`size`）
