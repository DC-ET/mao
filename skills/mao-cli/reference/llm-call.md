# llm-call — LLM 调用流水

## 用途

查询逐次 LLM 调用明细（场景、模型、Token、耗时、成败）。与 `analytics summary` 的聚合报表互补。

## 命令选择

| 场景 | 命令 |
|------|------|
| 当前用户自己的调用 | `llm-call me` |
| 管理员查全站 | `llm-call list` |

## 命令：llm-call me

`GET /llm-calls/me`

| 参数 | 必填 | 类型 | 默认 | 含义 |
|------|------|------|------|------|
| `--page` | 否 | 整数 | 1 | 页码 |
| `--size` | 否 | 整数 | 20 | 每页条数（最大 100） |
| `--scene` | 否 | 字符串 | | 场景：`agent` / `compaction` / `session_title` / `git_commit_message` / `danger_assess` / `voice_synthesis` / `feishu_summarize` / `connectivity_test` |
| `--success` | 否 | 布尔 | | 仅成功或失败 |
| `--session-id` | 否 | 整数 | | 会话 ID |
| `--model-id` | 否 | 整数 | | 模型 ID |
| `--start-date` | 否 | `YYYY-MM-DD` | | 开始日期 |
| `--end-date` | 否 | `YYYY-MM-DD` | | 结束日期 |

## 命令：llm-call list

`GET /admin/llm-calls`（需 `llm-call:read`）

额外支持 `--user-id`、`--agent-id`。

## 返回字段

| 字段 | 说明 |
|------|------|
| `records[]` | 调用记录 |
| `total` / `page` / `size` | 分页 |

单条记录主要字段：`createdAt`、`userId`、`sessionId`、`agentId`、`modelName`、`provider`、`scene`、`stream`、`promptTokens`、`completionTokens`、`cachedTokens`、`totalTokens`、`firstTokenMs`、`durationMs`、`success`、`errorMessage`，以及 `costMicros`（单次调用成本快照，**微单位** = 成本单位×1e6；模型未配价格或只配一个方向时为 `null`，`0` 表示该模型被配成免费）。价格在调用写入时快照，之后改价不影响历史行；管理后台「调用流水」页与 CSV 导出里的「成本」列为成本单位（`costMicros/1e6`）。

## 示例

```bash
mao llm-call me --page 1 --size 20 --raw
mao llm-call list --scene agent --start-date 2026-09-01 --end-date 2026-09-15
```
