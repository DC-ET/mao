# analytics — 分析汇总 / 分维度

## 用途

获取管理端用量分析数据。管理后台「用量分析」页按维度分 Tab，前端只拉当前 Tab 对应接口；CLI 提供相同 scope，便于脚本核对。

逐次 LLM 调用明细见 [llm-call.md](llm-call.md) 与「调用流水」页，本组命令只做窗口内聚合，不返回单次 HTTP 调用列表。

## 命令选择

| 命令 | 对应管理后台 | 说明 |
|------|--------------|------|
| `analytics overview` | 总览 Tab | 运行态（实时/窗口）+ 窗口合计 + 环比 + Token spark + 构成与规则洞察 |
| `analytics trends` | 趋势 Tab | 按天或按小时的序列（会话/消息/Token/后台调用）；`--granularity hour\|day`，默认 day |
| `analytics models` | 模型 Tab | 模型用量聚合 |
| `analytics users` | 用户 Tab | 用户活跃排行/明细，支持 `--limit` |
| `analytics agents` | Agent Tab | Agent 排行，支持 `--limit` |
| `analytics sessions` | 会话 Tab | phase 分布 + 会话类型/执行模式 + 实时运行态 |
| `analytics run-trace` | 运行轨迹 Tab | 最慢的轮 / 最贵的轮 / 工具失败率三个榜；`--scene` 选场景（默认 agent），`--scope` 选排行维度（agent\|user，默认 agent） |
| `analytics summary` | （旧）一页聚合 | 管理后台已切换分维度接口；CLI 仍保留全量汇总 |

## 公共参数

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--days` | 否 | 整数 | 30 | 统计天数窗口，服务端 clamp 到 1–90 | `days` |
| `--end-offset` | 否 | 整数 | 0 | 窗口结束日相对今天的前移天数（0=今日结尾，1=昨日结尾），服务端 clamp 到 0–365 | `endOffset` |
| `--limit` | 否 | 整数 | 20 | 仅 `users` / `agents`：排行条数，服务端 clamp 到 1–100 | `limit` |
| `--granularity` | 否 | `hour` \| `day` | `day` | 仅 `trends`：横轴粒度。`hour` 为 Asia/Shanghai 整点；窗口含今天时停在当前整点 | `granularity` |

### 统计口径

- 默认窗口以「今天」结尾，取最近 `days` 天；`--end-offset 1 --days 1` 即「昨日」
- 按半开区间 `[start 00:00:00, end+1 00:00:00)` 过滤 `created_at`
- 除 `overview` 中的实时运行态外，所有数字均为**窗口内新增**，不是全表累计
- 环比窗口是紧邻的上一个等长窗口（如 days=7 时为前 7 天；昨日的环比为前日）
- Token 分两类：`chatTokens` 来自 `message.token_count`（对话消耗），`backgroundTokens` 来自 `llm_usage`（后台调用，如会话标题、Git 提交信息生成），`totalTokens` 为两者之和；管理后台 UI 紧凑展示用 K/M/B（千/百万/十亿）
- 成本口径（0.0.243 起）：所有 `cost` / `totalCost` 字段均为**成本单位**（与模型价格填写口径一致），后端为 `COALESCE(SUM(llm_call.cost_micros),0)/1e6`。模型未配价格、或价格缺一个方向时该次调用成本为 NULL、不计入合计（不按 0 计），因此「没配价格的模型」在成本口径下等于没有开销，不等于免费。`connectivity_test` 等 scene 默认排除（`excludeConnectivity=true`）。子代理与边路任务会话的成本同样计入所属用户 / Agent
- 会话结局：窗口内**创建**的会话按 phase 分布；`livePhases` / `overview.runningSessions` 等为实时快照，不与窗口分布混算
- 环比色约定：红=上升、绿=下降（纯方向口径，不区分指标的好坏）
- 运行轨迹三个榜（`run-trace`）同为窗口内新增；前两个榜默认只统计 `scene=agent` 的轮（Agent 主循环），工具失败率全局按类型聚合、按比例排序（分母不同，直接比次数会让小样本工具霸榜）

## 接口路径

| 命令 | Path |
|------|------|
| `analytics overview` | `GET /admin/analytics/overview` |
| `analytics trends` | `GET /admin/analytics/trends` |
| `analytics models` | `GET /admin/analytics/models` |
| `analytics users` | `GET /admin/analytics/users` |
| `analytics agents` | `GET /admin/analytics/agents` |
| `analytics sessions` | `GET /admin/analytics/sessions` |
| `analytics run-trace` | `GET /admin/analytics/run-trace` |
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
| `periodTotals` | 窗口内合计：`sessions` / `messages` / `chatTokens` / `backgroundTokens` / `totalTokens` / `backgroundCalls` / `activeUsers` / `completedSessions` / `failedSessions` / `totalCost` |
| `previousTotals` | 上一等长窗口同口径 |
| `spark[]` | Token 日走势：`date` / `totalTokens` |
| `phaseDistribution[]` | 窗口内创建会话的阶段分布（固定 7 阶段，无数据为 0） |
| `insights[]` | 规则洞察：`level`（info/warn）/ `text` / 可选 `path` |

### trends

| 字段 | 说明 |
|------|------|
| `granularity` | `day` 或 `hour`。`date` 在 day 下为 `YYYY-MM-DD`，在 hour 下为 `YYYY-MM-DD HH:00` |
| `trends[]` | 按粒度补零：`date` / `sessions` / `messages` / `chatTokens` / `backgroundTokens` / `totalTokens` / `backgroundCalls` / `cost` |
| `periodTotals` / `previousTotals` | 同 overview 口径 |

### models

| 字段 | 说明 |
|------|------|
| `modelStats[]` | `modelId` / `modelName` / `provider` / `status` / `isDefault` / `sessionCount` / `messageCount` / `chatTokens` / `backgroundTokens` / `totalTokens`（含 llm_call 调用 Token）/ `backgroundCalls` / `contextWindowTokens`，以及质量列：`callCount` / `callFailCount` / `callSuccessRate` / `callTokens` / `promptTokens` / `cachedTokens` / `cacheHitRate` / `avgFirstTokenMs` / `avgDurationMs` / `retryCallCount`，以及成本列 `cost`（成本单位）。按 Token 合计降序；窗口内完全未被调用的模型不返回 |
| `periodTotals` | `{ totalTokens, totalCost }`（模型明细合计） |
| `sceneStats[]` | `{ key, callCount, failCount, callTokens }`，默认全部模型；可传 `modelId` 按模型过滤 |
| `protocolStats[]` | 同上，按 `llm_call.protocol` 分组 |
| `excludeConnectivity` | 是否排除了 `connectivity_test`（默认 true） |

可选查询参数：`excludeConnectivity=true|false`、`modelId`。

### users

| 字段 | 说明 |
|------|------|
| `userActivity[]` | `userId` / `username` / `displayName` / `sessionCount` / `messageCount` / `totalTokens` / `lastLoginAt` / `callCount` / `callFailCount` / `callTokens` / `cost`，剔除零活跃用户，按消息数降序 |
| `periodTotals` | `{ activeUsers }` |

### agents

| 字段 | 说明 |
|------|------|
| `agentStats[]` | `agentId` / `agentName` / `sessionCount` / `messageCount` / `totalTokens` / `callCount` / `callFailCount` / `callTokens` / `callSuccessRate` / `cost` |

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

### run-trace

运行轨迹三个榜，直接聚合 `llm_call` 与 `session_activity`，不返回单次调用列表。可选查询参数：`scene`（默认 `agent`，只统计 Agent 主循环的轮，排除边路/后台调用）、`scope`（`agent` 或 `user`，前两个榜的排行维度，默认 `agent`）。

| 字段 | 说明 |
|------|------|
| `scene` / `scope` | 本次统计使用的场景与维度 |
| `slowestRounds[]` | 最慢的轮：每个 Agent / 用户取其窗口内最慢的一轮，按该轮 `durationMs` 降序取前 N 个实体 |
| `mostExpensiveRounds[]` | 最贵的轮：口径同上，按 `costMicros` 降序，只统计有成本的轮 |
| `toolFailureRates[]` | 工具失败率：`toolType` / `totalCount` / `errorCount` / `failRate`（百分数，保留一位小数），按 `failRate` 降序；全局按工具类型聚合，不区分 scene / 维度 |
| `period` | 同公共 `period` 口径 |

两排行内每行字段：`scopeKey`（Agent / 用户 ID）、`scopeName`、`sessionId`（可跳会话）、`modelName`、`createdAt`（该轮结束时间）、`durationMs`、`totalTokens`、`costMicros`（NULL 表示未配价格）、`callCount`（该实体窗口内轮数）。

未关联 Agent / 用户的轮在榜上显示占位名「未关联 Agent」/「未关联用户」，仍可点进对应会话。

### summary（旧）

一页返回 overview + periodTotals + trends + phaseDistribution + agentStats + userActivity + modelStats。管理后台已改走分维度接口；字段与上表对应项一致（不含 Phase 2 质量列）。

## 成功失败判断

- 成功：`code===0`，`data` 为上述对象
- 失败：stderr `message`

## 示例

```bash
mao analytics overview
mao analytics trends --days 7 --raw
mao analytics trends --days 1 --granularity hour --raw
mao analytics models --days 30 --raw
mao analytics models --days 7 --raw   # 质量列与 sceneStats
mao analytics users --days 7 --limit 50 --raw
mao analytics agents --days 7 --raw
mao analytics sessions --days 1 --end-offset 1 --raw
mao analytics run-trace --days 7 --raw
mao analytics run-trace --days 7 --scope user --raw
mao analytics summary --days 7 --raw
```

排查建议：只关心趋势时用 `--raw` 配合 `jq '.data.trends'`；核对环比用 `jq '{now:.data.periodTotals, prev:.data.previousTotals}'`；总览洞察用 `jq '.data.insights'`；模型慢/贵/易失败用 `jq '.data.modelStats[] | {modelName,totalTokens,callSuccessRate,avgDurationMs,cacheHitRate}'`；运行轨迹三个榜用 `jq '.data.slowestRounds, .data.mostExpensiveRounds, .data.toolFailureRates'`。
