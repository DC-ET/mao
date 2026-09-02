# analytics — 分析汇总

## 用途

获取管理端分析汇总指标（统计窗口内的趋势、结构与环比）。管理后台「用量分析」页消费的就是本接口。

## 命令选择

仅 `analytics summary`。

## 命令：analytics summary

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--days` | 否 | 整数 | 30 | 统计天数窗口，服务端 clamp 到 1–90 | `days` |

`GET /admin/analytics/summary`

### 统计口径

- 窗口以「今天」结尾，取最近 `days` 天；按半开区间 `[start 00:00:00, end+1 00:00:00)` 过滤 `created_at`
- 除 `overview` 外所有数字均为**窗口内新增**，不是全表累计
- 环比窗口是紧邻的上一个等长窗口（如 days=7 时为前 7 天）
- Token 分两类：`chatTokens` 来自 `message.token_count`（对话消耗），`backgroundTokens` 来自 `llm_usage`（后台调用，如会话标题、Git 提交信息生成），`totalTokens` 为两者之和

### 返回结构

| 字段 | 说明 |
|------|------|
| `period` | `days` / `start` / `end` / `previousStart` / `previousEnd`（均为 `YYYY-MM-DD`） |
| `overview` | 全局累计概览（用户、Agent、会话、消息总数等）+ `runningSessions` / `waitingSessions` / `failedSessions` / `cancelledSessions`（**实时快照**，非窗口内） |
| `periodTotals` | 窗口内合计：`sessions` / `messages` / `chatTokens` / `backgroundTokens` / `totalTokens` / `backgroundCalls` / `activeUsers` / `completedSessions` / `failedSessions` |
| `previousTotals` | 上一等长窗口同口径：`sessions` / `messages` / `chatTokens` / `backgroundTokens` / `totalTokens` / `activeUsers` |
| `trends[]` | 逐日补零：`date` / `sessions` / `messages` / `chatTokens` / `backgroundTokens` / `totalTokens` / `backgroundCalls` |
| `phaseDistribution[]` | 窗口内创建会话的阶段分布，固定 7 个阶段（IDLE / RUNNING / RESUMING / WAITING_APPROVAL / COMPLETED / FAILED / CANCELLED），无数据为 0 |
| `agentStats[]` | `agentId` / `agentName` / `sessionCount` / `messageCount` / `totalTokens`，按会话数降序，Top 20 |
| `userActivity[]` | `userId` / `username` / `displayName` / `sessionCount` / `messageCount` / `totalTokens` / `lastLoginAt`，剔除窗口内零活跃用户，按消息数降序，Top 20 |
| `modelStats[]` | `modelId` / `modelName` / `provider` / `status` / `isDefault` / `sessionCount` / `messageCount` / `chatTokens` / `backgroundTokens` / `totalTokens` / `backgroundCalls` / `contextWindowTokens`，按 Token 合计降序，返回全部模型 |
| `recentFailures[]` | 窗口内失败会话（最多 10 条）：`id` / `title` / `agentId` / `userId` / `executionMode` / `updatedAt` |

### 成功失败判断

- 成功：`code===0`，`data` 为上述汇总对象
- 失败：stderr `message`

### 示例

```bash
mao analytics summary
mao analytics summary --days 7 --raw
```

排查建议：只关心趋势时用 `--raw` 配合 `jq '.data.trends'`；核对环比用 `jq '{now:.data.periodTotals, prev:.data.previousTotals}'`。
