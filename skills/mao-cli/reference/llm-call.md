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

## 用户端用量汇总与趋势（我的用量抽屉）

桌面/Web 顶栏「我的用量」抽屉的数据源，仅需登录、按 JWT userId 过滤、无额外权限码：

| 接口 | 用途 |
|------|------|
| `GET /llm-calls/me/summary?range=last30` | 窗口总账（调用数/成败/token 四项/成本）+ 按模型 + 按场景 + 按 Agent |
| `GET /llm-calls/me/trends?range=last30&granularity=day` | 趋势序列（按天/小时分桶） |

- `range`：统计周期，取值 `today` / `yesterday` / `week` / `month` / `last7` / `last30`，参数缺失时回落 `last30`（客户端抽屉默认传 `today`）；均为 Asia/Shanghai 日历口径（本周按周一起算，本月从 1 号起算至今天）。
- `granularity`：`day`（默认）或 `hour`；客户端对今日/昨日自动传 `hour`。`hour` 桶在窗口含今天时不超过当前整点，窗口已结束（如昨日）则补满全天 24 个整点。
- 趋势由后端补零：返回的 `buckets[]` 是连续完整序列，无数据时段为 0，前端不做日期运算。每桶字段 `{ bucket, callCount, failCount, promptTokens, cachedTokens, totalTokens, cost }`，`promptTokens`/`cachedTokens` 支撑前端算每个时间点的缓存命中率。
- 成本口径：`SUM(cost_micros)/1e6`，未配价的调用不计入（总账 cost 可能为 0）。
- CLI 暂无子命令封装这两个接口（由客户端「我的用量」抽屉直接消费）；需要脚本化时用 curl 带 JWT 调 `GET {base}/api/v1/llm-calls/me/summary?range=today`。

## 返回字段

| 字段 | 说明 |
|------|------|
| `records[]` | 调用记录 |
| `total` / `page` / `size` | 分页 |

单条记录主要字段：`createdAt`、`userId`、`sessionId`、`agentId`、`modelName`、`provider`、`scene`、`stream`、`promptTokens`、`completionTokens`、`cachedTokens`、`totalTokens`、`firstTokenMs`、`durationMs`、`success`、`errorMessage`，以及 `costMicros`（单次调用成本快照，**微单位** = 成本单位×1e6；模型未配价格或只配一个方向时为 `null`，`0` 表示该模型被配成免费）。价格在调用写入时快照，之后改价不影响历史行；管理后台「调用流水」页与 CSV 导出里的「成本」列为成本单位（`costMicros/1e6`）。流被上游截断或用户取消时，若用量已经返回，失败行仍按这些 token 计价。飞书群聊溢出摘要（`feishu_summarize`）记在会话所用模型上。

`summary` 返回 `{ range, totals: { callCount, successCount, failCount, promptTokens, completionTokens, cachedTokens, totalTokens, cost }, byModel[], byScene[], byAgent[] }`；`byAgent[]` 行为 `{ agentId, agentName, callCount, failCount, totalTokens, cost }`（`agentId`/`agentName` 为 null 分别表示无归属调用与已删 Agent）；`trends` 返回 `{ range, granularity, buckets: [{ bucket, callCount, failCount, promptTokens, cachedTokens, totalTokens, cost }] }`。

## 示例

```bash
mao llm-call me --page 1 --size 20 --raw
mao llm-call list --scene agent --start-date 2026-09-01 --end-date 2026-09-15
```
