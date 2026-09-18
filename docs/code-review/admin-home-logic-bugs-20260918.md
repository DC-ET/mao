# 管理后台首页（用量分析）逻辑 BUG 审查

- 日期：2026-09-18
- 审查范围：仅管理后台首页 `/analytics`（`admin/src/views/analytics/**`）及其直接依赖的数据链路（`backend-ts/src/admin/admin-analytics.service.ts`、`backend-ts/src/admin/admin.routes.ts`、`llm_call`/`llm_usage`/`message` 相关写入口径、`admin/src/router/index.ts` 守卫）。
- 方法：完整通读首页前端代码与后端聚合服务，交叉验证字段语义、SQL 过滤条件、token 口径与 UI 文案的一致性。

## 严重度汇总

| # | 标题 | 严重度 | 位置 |
|---|------|--------|------|
| 1 | 模型页 Token 合计三口径叠加，重复计算约一倍 | 高 | `admin-analytics.service.ts` `modelStats` + `ModelTab.vue` |
| 2 | 模型维度消息聚合漏掉软删除过滤 | 高 | `admin-analytics.service.ts` `selectMessageStatsByModel` |
| 3 | 首页全部 scope 默认把连通性测试计入质量指标，与文案矛盾 | 高 | `AnalyticsView.vue` `currentQuery`/`includeConnectivity` |
| 4 | 总览"运行态"卡片 `||` 回退把窗口统计当实时快照 | 中 | `OverviewTab.vue` `liveItems` |
| 5 | 路由守卫 fail-open：用户信息拉取失败时跳过全部权限检查 | 中 | `admin/src/router/index.ts` `beforeEach` |
| 6 | 用户/Agent Token 排行基于按消息数截断的 Top 20，排行失真 | 中 | `UserTab.vue` / `AgentTab.vue` + `usersScope`/`agentStats` |
| 7 | 模型筛选（sceneModelId）不写 URL，切 Tab 后筛选静默丢失 | 低 | `AnalyticsView.vue` `syncUrl`/`handleSceneModelChange` + `Layout.vue` keep-alive |

---

## 1. 模型页 Token 合计三口径叠加，重复计算约一倍（高）

**位置**：`backend-ts/src/admin/admin-analytics.service.ts` `modelStats()`（`totalTokens: chat + background + callTokens`）；前端展示于 `ModelTab.vue` 的环形图中心值、`periodTotals.totalTokens`、明细表"Token 合计"与"占比"列。

**根因**：`llm_call` 是"每次 chat/stream 一行"的全量流水（见 `V113__llm_call.sql` 表注释与 `RecordingLlmAdapter`），同一个 LLM 调用的 token 同时被记录在：

- `message.token_count`（`harness-service.ts:139` 持久化最终 assistant 消息时写入）→ 聚合为 `chat`；
- `llm_usage.total_tokens`（目前唯一写入方 `git-commit-message.service.ts:188`，而该调用走的 `llmAdapter` 正是 `RecordingLlmAdapter`）→ 聚合为 `background`；
- `llm_call.total_tokens` → 聚合为 `callTokens`。

三者并非互斥切片：`chat ⊂ callTokens`（对话调用），`background ⊂ callTokens`（后台调用）。`totalTokens = chat + background + callTokens` 把同一批 token 计了约两次。

**佐证**：总览页 `totalTokens = chatTokens + backgroundTokens`（`previousTotals()`/`sumTrends()` 口径，不含 `llm_call`），同一份数据在总览页与模型页数值差近一倍，两个页面对"Token 消耗"的定义互相矛盾。

**影响**：模型页"Token 总量"环形图、占比进度条全部虚高约一倍；跨页面对数时必然对不上。

**建议**：明确唯一口径。若以 `llm_call` 为准（维度最全），`totalTokens = callTokens`，`chat/background` 仅作辅助列展示；若沿用总览口径，则去掉 `callTokens` 叠加项。两个页面必须一致。

---

## 2. 模型维度消息聚合漏掉软删除过滤（高）

**位置**：`backend-ts/src/admin/admin-analytics.service.ts` `selectMessageStatsByModel()`。

```sql
SELECT model_id AS id, COUNT(*) AS messageCount, COALESCE(SUM(token_count), 0) AS totalTokens
FROM message
WHERE created_at >= ? AND created_at < ? AND model_id IS NOT NULL
GROUP BY model_id
```

**根因**：`message.deleted` 列自 `V051__add_session_message_logical_delete.sql` 起存在，同文件中所有其他消息聚合（`selectMessageStatsByAgent`、`selectMessageStatsByUser`、`sumMessages` 等）都带 `m.deleted = 0 AND s.deleted = 0`，唯独这一条既不过滤消息软删除，也未 join `session` 排除已删除会话下的消息。

**影响**：删除消息/删除会话的 token 与消息数仍计入模型页"对话 Token""消息"列，模型用量虚高；与其他维度（Agent、用户）口径不一致。

**建议**：补齐 `deleted = 0` 过滤；如需与 Agent/用户口径完全对齐，join `session` 并过滤 `s.deleted = 0`。

---

## 3. 首页全部 scope 默认把连通性测试计入质量指标（高）

**位置**：`admin/src/views/analytics/AnalyticsView.vue` `currentQuery()` 与 `includeConnectivity = ref(true)`。

**根因**：`currentQuery()` 对**所有** scope 恒定发送 `excludeConnectivity: !includeConnectivity.value`，而 `includeConnectivity` 默认 `true`，即默认发送 `excludeConnectivity: false`。后端 `parseAnalyticsQuery` 收到 `'false'` 后关闭 `scene != 'connectivity_test'` 过滤（`admin-analytics.service.ts` `llmCallWhere`），连通性自检调用进入全部质量指标。

这与三处明确的既定语义矛盾：

- 后端注释："默认排除连通性测试，避免模型配置自检污染质量指标"（`admin.routes.ts`）；
- 趋势页文案："llm_call 调用次数与失败次数（默认排除连通性测试）"（`TrendsTab.vue`）；
- 会话页文案："llm_call 窗口聚合，默认排除连通性测试"（`SessionTab.vue`）。

此外，`includeConnectivity` 本是模型 Tab 复选框"含自检调用"的 UI 状态，却泄漏进其他 5 个 Tab 的查询参数：用户在模型页取消勾选后，趋势/会话等页的质量指标口径随之静默变化。

**影响**：成功率、失败次数、调用次数、缓存命中率、首 token 延迟分位等指标被连通性测试污染，且 UI 文案承诺的"默认排除"实际未生效。

**建议**：非模型 Tab 不发送 `excludeConnectivity`（走后端默认排除），或将其默认值改为排除并仅限模型 Tab 传递。

---

## 4. 总览"运行态"卡片把窗口统计当实时快照回退（中）

**位置**：`admin/src/views/analytics/tabs/OverviewTab.vue` `liveItems`。

```ts
{ label: '运行中', value: live('runningSessions') || fromPhase('RUNNING'), tone: 'run' },
{ label: '等待审批', value: live('waitingSessions') || fromPhase('WAITING_APPROVAL'), tone: 'wait' },
```

**根因**：`overview.runningSessions` 是实时快照（`selectLivePhaseCounts`，后端字段恒存在、0 是合法值），`phaseDistribution.RUNNING` 是**窗口内创建会话**的 phase 计数（`selectPhaseCounts(range)`）。`||` 在实时值为 0 时回退到窗口统计——但 0 是有效业务值，不应触发回退。卡片头部明确标注"实时快照，不随统计周期变化"，回退后展示的却是随周期变化的数据。

**影响**：当实时运行数为 0、而窗口内存在曾处于 RUNNING/WAITING_APPROVAL 的历史会话时，"运行中/等待审批"显示窗口期数字并被误读为当前实时状态。

**建议**：改为仅在字段缺失时回退（`overview[key] ?? fromPhase(...)`），或直接移除回退。

---

## 5. 路由守卫 fail-open：用户信息拉取失败时跳过权限检查（中）

**位置**：`admin/src/router/index.ts` `beforeEach`。

**根因**：`fetchUserInfo()` 抛出非 401/403 异常（如网络抖动、超时、502）时，守卫直接 `next()` 放行——位于其后的 `meta.permission` 与 `meta.adminOnly` 检查全部被跳过，任何用户都能进入 `/analytics`、`/llm-calls` 等管理员专属页面（后端 API 层 `requireAdmin` 仍会拦截数据请求，但页面骨架、菜单与无数据状态已暴露）。

权限守卫应默认 fail-closed：无法确认身份时不应放行受保护路由。

**建议**：非 401/403 异常时对受保护路由重定向到登录页或 `/forbidden`（仅放行明确允许匿名浏览的页面），而非 `next()`。

---

## 6. 用户/Agent Token 排行基于按消息数截断的 Top 20，排行失真（中）

**位置**：`admin/src/views/analytics/tabs/UserTab.vue`（`tokenItems`）、`AgentTab.vue`（`tokenItems`）；后端 `usersScope`/`agentsScope`。

**根因**：后端 `userActivity()` 按 `messageCount DESC, totalTokens DESC` 排序后 `slice(0, limit=20)`；前端"用户 Token 排行"图再从这 20 行里按 `totalTokens` 重排取 Top 10。消费维度（Token）与截断维度（消息数）不一致：窗口内 Token 消耗很高但消息数排在 20 名以外的用户/Agent 根本不在返回集中，Token 排行图会系统性遗漏真正的头部消耗者。Agent 排行同理。

**影响**：Token 排行图展示的不是真实的 Token Top 10，重消耗、少消息的用量（如长上下文压缩、后台任务密集的 Agent）被隐藏。

**建议**：后端按展示维度分别排序截断（Token 排行图单独取 `totalTokens` Top N），或前端排行图改用与后端一致的截断维度并调整文案。

---

## 7. 模型筛选（sceneModelId）不写 URL，切 Tab 后筛选静默丢失（低）

**位置**：`admin/src/views/analytics/AnalyticsView.vue` `handleSceneModelChange`/`syncUrl`；`admin/src/components/Layout.vue` keep-alive `:key="viewRoute.fullPath"`。

**根因**：`handleSceneModelChange` 只更新内存 `sceneModelId`，`syncUrl` 不把 `modelId` 写入路由；而 `Layout.vue` 用 `fullPath` 作为 keep-alive key，切 Tab（`syncUrl` 的 `router.replace` 改变 fullPath）会导致 `AnalyticsView` 整个组件销毁重建，重建时 `sceneModelId` 从 URL 重新初始化——URL 里没有，筛选即丢失。反向问题同样存在：URL 中残留的旧 `modelId`（从外部带进来后）不会被清理，刷新页面后会"复活"一个用户以为已取消的筛选。

**影响**：模型页点选某行切换筛选 → 切到其他 Tab 再切回 → 筛选被静默重置，场景分布数据与用户预期不一致；带 `?modelId=N` 进入后无法通过界面操作彻底清除该筛选。

**建议**：`modelId` 与 `tab`/`period` 一样纳入 `syncUrl` 双向同步（清空筛选时从 query 中删除该键）。

---

## 附：已排查、确认不是问题的点

- `dateStrings` 时区链路：`db.ts` 配置 `timezone: '+08:00'`，`shanghaiYmd`/`DATE(created_at)` 与日期窗口拼接一致，无跨日偏移。
- `llm_call.scene` 列为 `NOT NULL DEFAULT 'unknown'`，`scene != 'connectivity_test'` 不会误丢 NULL 行。
- 缓存键 `periodKey` 已包含 `days/endOffset/limit/modelId/excludeConnectivity`，换周期/筛选自然 miss；`useScopeQuery` 的 seq 竞态防护与 module 级 `inflight` 去重正确。
- 延迟分位 `OFFSET` 计算做了 `count-1` 钳制，不会越界。
- `countActiveUsers` 用 `UNION`（去重）统计活跃用户，符合"有会话或消息"的文案语义。
