# analytics — 分析汇总 / 分维度

## 用途

获取管理端用量分析数据。管理后台「用量分析」页按维度分 Tab，前端只拉当前 Tab 对应接口；CLI 提供相同 scope，便于脚本核对。

逐次 LLM 调用明细见 [llm-call.md](llm-call.md) 与「调用流水」页，本组命令只做窗口内聚合，不返回单次 HTTP 调用列表。

## 命令选择

| 命令 | 对应管理后台 | 说明 |
|------|--------------|------|
| `analytics overview` | 总览 Tab | 运行态（实时/窗口）+ 窗口合计 + 环比 + Token spark + 构成与规则洞察 |
| `analytics trends` | 趋势 Tab | 日序列（会话/消息/Token/后台调用） |
| `analytics models` | 模型 Tab | 模型用量聚合 |
| `analytics users` | 用户 Tab | 用户活跃排行/明细，支持 `--limit` |
| `analytics agents` | Agent Tab | Agent 排行，支持 `--limit` |
| `analytics sessions` | 会话 Tab | phase 分布 + 会话类型/执行模式 + 实时运行态 |
| `analytics summary` | （旧）一页聚合 | 管理后台已切换分维度接口；CLI 仍保留全量汇总 |

## 公共参数

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--days` | 否 | 整数 | 30 | 统计天数窗口，服务端 clamp 到 1–90 | `days` |
| `--end-offset` | 否 | 整数 | 0 | 窗口结束日相对今天的前移天数（0=今日结尾，1=昨日结尾），服务端 clamp 到 0–365 | `endOffset` |
| `--limit` | 否 | 整数 | 20 | 仅 `users` / `agents`：排行条数，服务端 clamp 到 1–100 | `limit` |

### 统计口径

- 默认窗口以「今天」结尾，取最近 `days` 天；`--end-offset 1 --days 1` 即「昨日」
- 按半开区间 `[start 00:00:00, end+1 00:00:00)` 过滤 `created_at`
- 除 `overview` 中的实时运行态外，所有数字均为**窗口内新增**，不是全表累计
- 环比窗口是紧邻的上一个等长窗口（如 days=7 时为前 7 天；昨日的环比为前日）
- Token 分两类：`chatTokens` 来自 `message.token_count`（对话消耗），`backgroundTokens` 来自 `llm_usage`（后台调用，如会话标题、Git 提交信息生成），`totalTokens` 为两者之和；管理后台 UI 紧凑展示用 K/M/B（千/百万/十亿）
- 会话结局：窗口内**创建**的会话按 phase 分布；`livePhases` / `overview.runningSessions` 等为实时快照，不与窗口分布混算
- 环比色约定：红=上升、绿=下降（纯方向口径，不区分指标好坏）

## 接口路径

| 命令 | Path |
|------|------|
| `analytics overview` | `GET /admin/analytics/overview` |
| `analytics trends` | `GET /admin/analytics/trends` |
| `analytics models` | `GET /admin/analytics/models` |
| `analytics users` | `GET /admin/analytics/users` |
| `analytics agents` | `GET /admin/analytics/agents` |
| `analytics sessions` | `GET /admin/analytics/sessions` |
| `analytics summary` | `GET /admin/analytics/summary` |

## 返回结构（公共）

所有 scope 响应均带：

| 字段 | 说明 |
|------|------|
| `period` | `days` / `start` / `end` / `previousStart` / `previousEnd`（均为 `YYYY-MM-DD`） |

### overview

| 字段 | 说明 |
|------|------|
| `overview` | 全局累计概览 + `runningSessions` / `waitingSessions` / `failedSessions` / `cancelledSessions`（**实时快照**） |
| `periodTotals` | 窗口内合计：`sessions` / `messages` / `chatTokens` / `backgroundTokens` / `totalTokens` / `backgroundCalls` / `activeUsers` / `completedSessions` / `failedSessions` |
| `previousTotals` | 上一等长窗口同口径 |
| `spark[]` | Token 日走势：`date` / `totalTokens` |
| `phaseDistribution[]` | 窗口内创建会话的阶段分布（固定 7 阶段，无数据为 0） |
| `insights[]` | 规则洞察：`level`（info/warn）/ `text` / 可选 `path` |

### trends

| 字段 | 说明 |
|------|------|
| `trends[]` | 逐日补零：`date` / `sessions` / `messages` / `chatTokens` / `backgroundTokens` / `totalTokens` / `backgroundCalls` |
| `periodTotals` / `previousTotals` | 同 overview 口径 |

### models

| 字段 | 说明 |
|------|------|
| `modelStats[]` | `modelId` / `modelName` / `provider` / `status` / `isDefault` / `sessionCount` / `messageCount` / `chatTokens` / `backgroundTokens` / `totalTokens`（含 llm_call 调用 Token）/ `backgroundCalls` / `contextWindowTokens`，以及质量列：`callCount` / `callFailCount` / `callSuccessRate` / `callTokens` / `promptTokens` / `cachedTokens` / `cacheHitRate` / `avgFirstTokenMs` / `avgDurationMs` / `retryCallCount`。按 Token 合计降序；窗口内完全未被调用的模型不返回 |
| `periodTotals` | `{ totalTokens }`（模型明细合计） |
| `sceneStats[]` | `{ key, callCount, failCount, callTokens }`，默认全部模型；可传 `modelId` 按模型过滤 |
| `protocolStats[]` | 同上，按 `llm_call.protocol` 分组 |
| `excludeConnectivity` | 是否排除了 `connectivity_test`（默认 true） |

可选查询参数：`excludeConnectivity=true|false`、`modelId`。

### users

| 字段 | 说明 |
|------|------|
| `userActivity[]` | `userId` / `username` / `displayName` / `sessionCount` / `messageCount` / `totalTokens` / `lastLoginAt` / `callCount` / `callFailCount` / `callTokens`，剔除零活跃用户，按消息数降序 |
| `periodTotals` | `{ activeUsers }` |

### agents

| 字段 | 说明 |
|------|------|
| `agentStats[]` | `agentId` / `agentName` / `sessionCount` / `messageCount` / `totalTokens` / `callCount` / `callFailCount` / `callTokens` / `callSuccessRate` |

### sessions

| 字段 | 说明 |
|------|------|
| `phaseDistribution[]` | 窗口内创建会话 phase 分布 |
| `sessionTypes[]` | `{ sessionType, count }`：NORMAL / SUBAGENT / SIDE_TASK |
| `executionModes[]` | `{ executionMode, count }`：CLOUD / LOCAL |
| `livePhases[]` | 实时 phase 快照（全表，不随周期变） |
| `periodTotals` | `{ sessions, activeUsers, completedSessions, failedSessions }` |
| `callQuality` | `callCount` / `successCount` / `failCount` / `retryCallCount` / `promptTokens` / `cachedTokens` / `callTokens` / `successRate` / `retryRatio` / `cacheHitRate` / `firstTokenP50` / `firstTokenP95` / `durationP50` / `durationP95` |
| `failTop` | `{ byModel[], byScene[] }`：失败次数 Top5，字段 `key` / `name` / `failCount` / `callCount` |

### trends（补充）

| 字段 | 说明 |
|------|------|
| `trends[]` 额外字段 | `callCount` / `callFailCount` / `callTokens` / `promptTokens` / `cachedTokens` / `callSuccessRate` / `cacheHitRate` |
| `callQuality` | 窗口合计的质量摘要，同 sessions 口径（不含延迟分位） |

### summary（旧）

一页返回 overview + periodTotals + trends + phaseDistribution + agentStats + userActivity + modelStats。管理后台已改走分维度接口；字段与上表对应项一致（不含 Phase 2 质量列）。

## 成功失败判断

- 成功：`code===0`，`data` 为上述对象
- 失败：stderr `message`

## 示例

```bash
mao analytics overview
mao analytics trends --days 7 --raw
mao analytics models --days 30 --raw
mao analytics models --days 7 --raw   # 质量列与 sceneStats
mao analytics users --days 7 --limit 50 --raw
mao analytics agents --days 7 --raw
mao analytics sessions --days 1 --end-offset 1 --raw
mao analytics summary --days 7 --raw
```

排查建议：只关心趋势时用 `--raw` 配合 `jq '.data.trends'`；核对环比用 `jq '{now:.data.periodTotals, prev:.data.previousTotals}'`；总览洞察用 `jq '.data.insights'`；模型慢/贵/易失败用 `jq '.data.modelStats[] | {modelName,totalTokens,callSuccessRate,avgDurationMs,cacheHitRate}'`。
