# 任务运行轨迹透视技术方案：埋点补齐 → 读时聚合 → 轨迹 Tab

- 状态：待实施（2026-10-09 设计共识；同日按现码评审修订，修订点见 §8 带「修订」的行）
- 日期：2026-10-09
- 提案来源：[docs/proposals/2026-10-09-run-trace-timeline.md](../proposals/2026-10-09-run-trace-timeline.md)

## 1. 需求背景

引擎的执行过程今天散落在四类互不相通的数据里，没有一处能回答"这一轮到底发生了什么"：

1. **LLM 调用**：`llm_call`（V113）已记录 tokens、`duration_ms`、`retry_count`、`first_token_ms`、`scene`、`session_id`，成本 `cost_micros`（V138）与缓存 token 分项（`cached_tokens`，另有 V141 `cache_creation_tokens`）亦已落账，索引 `idx_llm_call_session_created` 齐备——但它只服务管理后台用量分析，是**管理视角的账本**，用户在会话里看不到任何一次调用的耗时、重试与花费。
2. **工具调用**：`session_activity`（V010）已按工具落库（`type` / `target` / `summary` / `status`），桌面端也消费 `activity` WS 事件渲染动态——但 `ws-streaming-event-listener.ts` 的 `recordActivity` 落库时 `durationMs` 与 `detailJson` 都传 `null`，列存在而数据缺失；且活动流是**平铺流水**，没有"第几轮、轮内顺序"的结构。
3. **压缩事件**：`session_compaction_event`（V071）有落库且带 `boundary_msg_id`，可精确定位到消息序列。
4. **预算 / 审批**：预算 WARN 走收件箱，但 `recordBudgetWarn` 写入时 `sessionId` 固定为 `null`（月度、按预算去重），**不能**按会话或 run 取回。审批结论已经随工具消息 `metadataJson` 落库（`agent-loop.ts` 的 `mergeApprovalMark`），并随 `tool_call_result` 推一次；缺的是轨迹视图，不是再造一份审批账。

引擎侧其实已发出轮边界事件：`agent-event-listener.ts` 的 `onRoundStart?/onRoundEnd?` 由 `agent-loop.ts` 成对调用（`closeRound()` 保证取消路径也收轮），`composite-agent-event-listener.ts` 已透传——但 `ws-streaming-event-listener.ts` 自己的 `AgentEventListener` 接口没有这两个方法，**轮事件到 WS 边界即被丢弃**。

时钟事实（归属规则都建立在这上面）：

- `RecordingLlmAdapter` 在 `finally` 里插入 `llm_call`，`created_at` 是 **调用结束时刻**，不是开始。`duration_ms` 含适配器重试全程。
- `session_activity.created_at` 同样是 `onToolCallResult` 时的插入时刻，即 **工具结束时刻**。`recordActivity` 是 `void` 异步写入，不与下一条用户消息的落库同步。
- 两张表的 `created_at` 都是 `DATETIME`（秒），不是 `DATETIME(3)`。同一秒内不能用 `created_at` 做跨表先后。

与相邻能力的边界：上下文透视（检查器「上下文详情」）解决**向未来看**（下一轮请求构成），本方案补**向过去看**（已发生轮次的事实）；Evals（已否决）做质量断言，本方案只呈现事实，不做任何通过率判断。

## 2. 需求描述

### 2.1 目标

1. **排障定位**：轨迹是排障工具而非常驻叙事。run 摘要条默认收起，异常（失败 / 重试 / 中断 / 慢 / 贵）高亮并引导展开；正常 run 用户不打开，不与消息流、活动流、Todo 清单争展示职责。
2. **run = 一条现存用户消息到下一条更新的用户消息**：复用 `MessageRepository.selectUserStarts`（`ORDER BY id DESC`）。`runId` = 锚点用户消息 id。
3. **轮级信息**：模型、耗时、首 token 延迟、重试次数、成败、输入 / 输出 / 缓存命中 / 缓存写入 token、**成本**（`cost_micros`；该行未配价，或产生了缓存读但 `price_cache_read` 为空，则该行 `costMicros` 为 null，只显示 token）。
4. **工具级信息**：名称、目标、状态、耗时、审批标记。耗时以执行层 `ToolResult.durationMs` 为权威（本地计量）；并行工具各自计时（`executeToolCalls` 是 `Promise.all`），UI 明示"并行工具耗时互相重叠、求和大于 run 耗时属正常"；run 汇总只给墙钟跨度。
5. **实时 + 回看**：执行中用已有的 `tool_call_start` 做客户端计时，回答"现在卡在哪个工具上、已经多久"（`activity.duration_ms` 要等工具结束才有，回答不了进行中）。`round_start` / `round_end` 只驱动"当前执行里的第几轮"这行临时状态。结束后或刷新走 REST。完成态以 REST 为准；进行中不另做一套 VO。
6. **事件标记**：压缩按 `boundary_msg_id` 硬归属。同一时间窗里的非 `agent` 调用（压缩、标题、记忆抽取、危险评估等）不占轮号，作为 run 内旁路调用列出，token 与成本进入 run 合计。用户取消且 `error_message` 含 `Cancelled by user` 的轮标「已中断」，不计失败。子代理只放链接行。
7. **慢 / 贵阈值**：轮级默认 60s 算慢、50k token 算贵（`>=` 即标记）。阈值是展示参数：REST 用 query 传入，桌面记在 localStorage。不新建偏好表。
8. **导出**：单会话轨迹支持 JSON（结构化）+ CSV（扁平）。CSV 的模型行口径对齐管理后台 `llm-calls` 导出（成本 = `cost_micros / 1e6`，六位小数，未配价留空；UTF-8 BOM，CRLF）。
9. **编辑重发留在同一个 run，并标出「编辑前」段**：`editMessageAndTruncate` 不新增用户消息，只改同一条并刷新 `updated_at`，再逻辑删除其后消息。`llm_call` / `session_activity` 不删。`updated_at > created_at` 时，`created_at < updated_at` 的 `scene=agent` 调用归「编辑前」（对应消息已删除，工具对不上是正常的）。多次编辑只留最后一次 `updated_at`，更早的执行合并进「编辑前」，不再拆开。秒级边界允许切错落在那一秒的调用。
10. **归属不上的不猜测**：见 §5.2 的「未挂到轮」和「未归属」。

### 2.2 非目标

- 不建 `run_round` 事实表、不做物化视图（读时聚合；性能超标再议，见 §7）。
- 不做 OpenTelemetry / Prometheus 导出。
- 不改 `llm_call` 历史口径、不动管理后台既有用量视图。
- 不做子代理 / 边路任务的跨会话轨迹串联。P1 的链接只解析 `delegate` / `delegate_followup` 工具结果里的 `child_session_id`（含失败结果上的同名字段）。不扫 `SIDE_TASK` 子会话。
- 不做记忆注入标记（上下文透视既有职责）。
- 不把 `message_file_change` 再挂进轨迹（提案里提过文件变更；文件变更已经在消息流里，轨迹不重复一份）。
- **不做 run 级预算 WARN 标记**。收件箱行没有 `session_id`，按会话查询是空的；按用户 + 时间窗去贴，会把同月所有 run 都打上警告，制造错误线索。预算仍只在收件箱。
- **不标「崩溃恢复」段**。恢复续跑不插入用户消息（自然落在同一个 run），也没有任何"这次是恢复"的落库行。用时间缝去猜违反"误判 = 错误线索"。恢复之后的调用就是这个 run 里更后面的轮。
- **排队消费不并进上一个 run**。`autoConsumeQueue` 会 `saveMessage(USER)` 再执行，这条新用户消息就是新 run。
- 不做移动端单独适配：轨迹 tab 的入口挂在检查器徽标区，检查器不可见的端轨迹同样不可见。
- 不做渠道端（飞书等）轨迹展示。渠道执行只要挂了 `WsStreamingEventListener`，数据仍进这张轨迹，只是没有渠道 UI。
- 轨迹不进只读分享快照。实施时不要把 `/trace` 挂进 `session-share` 的组装。

## 3. 范围界定

### 3.1 做什么

| 层 | 内容 |
|---|---|
| backend-ts | `recordActivity` 透传 `duration_ms` + `detail_json`（`toolCallId` / `approvalMark`），并放宽 `WsListenerDeps.activityService.record` 上被写成 `null` 字面量的参数类型；WS listener 接口补 `onRoundStart/onRoundEnd` 并下发 `round_start`/`round_end`；`activity` 事件带 `duration_ms`；新增 `RunTraceService` + `GET /v1/sessions/:id/trace` + VO |
| desktop | 对话区中心 tab 新增「轨迹」（`Tab.type` 加 `'trace'`，`openTraceTab()`，`CenterTabContainer` 渲染 `RunTracePanel.vue`）；入口在检查器徽标区；消费 `round_start`/`round_end`，进行中的工具计时用已有 `tool_call_start`；阈值放 localStorage；JSON/CSV 导出（P2） |
| admin | 「用量分析」新增运行轨迹聚合：最慢轮 / 最贵轮 / 工具失败率 Top（P2，默认 `scene=agent`） |
| 文档 | 实施发版时补 CHANGELOG；README 核心能力表 harness 行补轨迹；mao-cli desktop 手册补轨迹说明 |

### 3.2 不做什么

- 不加数据库迁移。`session_activity.duration_ms` / `detail_json`、`llm_call`（含 `cache_creation_tokens`）、`session_compaction_event` 都已存在。历史活动的 `duration_ms` 保持 null，不回填；UI 显示「—」，不要显示 0。
- 不动 `agent-loop.ts` 的轮结构。
- 不改造既有 `/v1/sessions/:id/activities`。
- 不做独立抽屉。TaskInspector 的 tab 栏保持任务 / 文件 / Git 三栏不变。
- 不把 `recordActivity` 改成 await。归属以消息 id 和 `tool_call_id` 为准，不依赖活动行和下一条用户消息谁先提交。

## 4. 技术选型与关键决策

零新增依赖、零数据库迁移。决策及论证见 §8。五个塑形整体架构的结论：

| # | 决策 | 结论 |
|---|---|---|
| D1 | run 的定义 | 一条现存用户消息到下一条更新的用户消息。引擎 round 计数器不落库，也不做 REST 序号 |
| D2 | 事实存储 | 读时聚合，零新表。消息 id 区间是消息和工具的主干；`llm_call` 用结束时刻的 `created_at` 放进 run |
| D3 | 归属 | 有 `tool_call_id` 就按消息归；没有则不要按秒级 `created_at` 猜轮。对不上的留在 run 内「未挂到轮」，或会话级「未归属」 |
| D4 | 实时与回看 | REST 是完成态。进行中只在这份快照上叠临时行（当前轮、当前工具计时），IDLE 后整页重拉并丢掉临时行 |
| D5 | 工具耗时 | 执行层 `durationMs` 为权威；run 汇总只给墙钟。墙钟按「结束时刻 − duration」估算起点 |

## 5. 详细设计

### 5.1 埋点补齐（P1）

**（a）工具耗时与标记落库**——`ws-streaming-event-listener.ts`：

`ActivityService.record` 已经接受 `detailJson` 和 `durationMs`。listener 的 `WsListenerDeps` 把这两个参数类型写成了 `null` 字面量，要放宽，否则传真实值过不了类型检查。`onToolCallResult` 里把 `meta` 传进 `recordActivity`：

```ts
const detail = JSON.stringify({
  toolCallId,
  ...(meta?.approvalMark ? { approvalMark: meta.approvalMark } : {}),
});
const activity = await this.deps.activityService.record(
  this.sessionId, activityType, target, activitySummary, detail, status, meta?.durationMs ?? null,
);
this.send('activity', {
  id: activity.id, type: activityType, target, summary: activitySummary, status,
  duration_ms: meta?.durationMs ?? null,
});
```

- `duration_ms` 对 LOCAL 委托工具同样有效：耗时在桌面 LocalToolExecutor 侧计量，随 ToolResult 回传（`toolResultMeta`）。
- `activity` 事件新增 `duration_ms`。旧前端不读该字段即忽略。
- 审批的权威读路径仍是工具消息 `metadataJson`（历史数据已有）。`detail_json` 是新数据的冗余，消息上没有标记时才用它。

**（b）轮边界事件下发**——同文件：

- 本文件的 `AgentEventListener` 接口补 `onRoundStart?(round: number): void` 与 `onRoundEnd?(round: number): void`。
- 实现只发 `round_start { round }` / `round_end { round }`，不落库。`send()` 会带上已有的 `executionId`。
- 桌面 `useStreamWS.ts` 的 `STREAM_EVENT_TYPES` 加上这两个类型，并继续走现有的陈旧执行过滤。恢复续跑的帧不能被丢掉，上一执行的帧也不能画进当前 run。
- 这两个事件里的 `round` 是**本次执行**从 1 计的内存序号。崩溃恢复会从 1 再计。它只用于进行中的临时行，不是 REST 的 `seq`。

### 5.2 读模型：RunTraceService（P1）

新文件 `backend-ts/src/session/run-trace.service.ts` + `run-trace.service.spec.ts`，挂在 session 域，路由 deps 注入方式同现有 session 路由。

**分页**

`selectUserStarts(sessionId, beforeRunId, limit+1)` 已是 `id DESC`。`limit` 默认 5、上限 50。

- 多取的那一条只用来判断 `hasMore`，然后丢掉。它不裁剪本页最老一个 run。
- 本页 run 从新到旧。对页内锚点 `U[i]`（`i` 从 0 起，0 是本页最新）：消息 id 区间为 `[U[i].id, U[i-1].id)`。`i = 0` 且没有更新的用户消息时，上界开放。
- 下一页的 `beforeRunId` = 本页最老一个 run 的用户消息 id（`id < beforeRunId`）。
- `hasMore` 是页级字段，不放进每个 run。

**一个 run 里装什么**

消息：`selectRange`，id 落在上面的区间里，已逻辑删除的不算（编辑重发截掉的旧回复不会回来）。

LLM 调用：`session_id` + 时间窗 `[anchor.created_at, nextNewerUser.created_at)`，走 `idx_llm_call_session_created`。最新一个 run 的上界开放。`created_at` 相同则再按 `id` 升序。

- `scene = 'agent'` 的调用才是轮，`seq` 从 1 按这个顺序编号。这不是引擎内存 round。
- 其余 scene（`compaction`、`session_title`、`memory_extract`、`danger_assess`、`git_commit_message`、`proxy_approve`、`feishu_summarize`、`voice_synthesis` 等）放进 `sideCalls`，不占 `seq`。它们的 token 和成本仍然进入 run 合计，否则压缩或标题调用会让「为什么贵」对不上账本。
- 空响应重试：循环里每次 `stream()` 各记一行，`success = 1`，`retry_count` 不加（`retry_count` 只统计适配器内部重试）。轨迹上就是连续多轮，不另打重试徽标。
- 取消：`RecordingLlmAdapter` 的 `finally` **总会**落库。`error_message` 含 `Cancelled by user` 的行标 `interrupted`，不计失败，即使 `success = 0`。不要按"没有落库调用"来识别——取消调用是有行的。
- 工具阶段才取消：LLM 行已经按成功写入，助手消息在工具执行之后才持久化，回滚后消息主干上没有这轮。这和空响应一样，都是「有调用、无助手消息」。二者无法用现有列区分，**不把这种情况标成中断**。

工具：

1. 现存助手消息的 `tool_calls` 与现存工具消息、以及 `detail_json.toolCallId`，按 `tool_call_id` 配成一组，挂到这条助手消息上。消息在哪个 run，工具就在哪个 run，**不看** activity 的 `created_at`（异步插入可能晚于下一条用户消息）。
2. 这一组挂到哪一轮：在本 run 的 `scene=agent` 调用里，找 `created_at` 严格早于该助手消息 `created_at`、且尚未被占用的最后一条。找到就挂上。同一秒里有多条候选，或一条都对不上：工具组留在 run 的 `unplacedTools`，不猜。
3. 历史活动没有 `tool_call_id`：不对轮。能靠时间放进某个 run（见下）就放进该 run 的 `unplacedTools`，否则进会话级「未归属」。

审批标记：先读工具消息 `metadataJson.approvalMark`，没有再用 activity `detail_json`。

子代理链接：解析本 run 内 `delegate` / `delegate_followup` 工具消息 content（JSON）的 `child_session_id`。解析失败就不出链接。

压缩：`session_compaction_event.boundary_msg_id` 落在本 run 消息 id 区间内则挂标记。不拿它的 `created_at` 去对 `llm_call`。压缩调用的钱在 `sideCalls` 和合计里，标记本身不重复计费。

编辑前段：锚点用户消息 `updated_at > created_at` 时，`created_at < updated_at` 的 `scene=agent` 调用放进 `segments: [{ kind: 'before_edit', rounds }]`，其余为 `{ kind: 'current' }`。没有编辑过则只有 `current`，不造空的「编辑前」。被截断的旧工具没有现存消息，留在「编辑前」段的 `unplacedTools`（用 activity.`created_at < updated_at`，且 `tool_call_id` 对不上任何现存消息）。对得上现存消息的工具永远归当前段。

**墙钟**

`created_at` 是结束时刻。对窗口内每条带 `duration_ms` 的 `llm_call` 和 `session_activity`：`start = created_at - duration_ms`，`end = created_at`。`wallClockMs = max(end) - min(start)`，小于 0 记 0。秒级截断带来约 1 秒误差，UI 不展示亚秒。没有 duration 的点不参与。不要用「`created_at` 极值差 + 末条 duration」——那是把结束时刻当成了起点。

**慢 / 贵**

query：`slowMs` 默认 60000，钳制在 1000–3600000；`expensiveTokens` 默认 50000，钳制在 1000–10000000。`durationMs >= slowMs` 为慢。`prompt + completion + cached + cacheCreation >= expensiveTokens` 为贵。贵看 token，不看有没有配价。服务端算好布尔，桌面不要再用另一套阈值重算。

**合计**

窗口内**全部** `llm_call`（含旁路 scene）求和。任一行 `cost_micros` 为 null，则 run 级 `costMicros` 为 null（与「有缓存读但未配缓存价则整行不计」的既有口径一致）。工具成败只数挂上了轮或挂在 `unplacedTools` 里、且状态明确的活动；`null` duration 不影响成败计数。

**未归属**

只在 `beforeRunId` 缺省（第一页）返回，作为页级字段，不塞进 run 列表，也不使用 `runId = 0`（那会让 `id < 0` 的翻页直接空掉，并且每页重复一份）。

判定前先取出该会话全部现存用户消息的 `id, created_at, updated_at`（一条查询，不是只看本页）：

- `created_at` 早于第一条现存用户消息的 `llm_call` / `session_activity`，或会话里没有用户消息：进未归属。
- 最后一条用户消息之后的调用属于那个 run（上界开放），不是未归属。
- 定时任务和开放 API 都会先 `saveMessage(USER)`，是正常 run。生产上的桌面发送、崩溃恢复、飞书、钉钉、微信、定时任务 / 开放 API 的 `liveExecution` 都挂了 `WsStreamingEventListener`，工具活动会落库。只有 `liveExecution` 缺失时的 noop 兜底才只有 LLM 调用、没有工具行；P1 不特殊处理。
- `tool_call_id` 对得上现存消息的活动，按消息归 run，即使 `created_at` 落在窗外。

**VO**（`session-vo.ts`，风格对齐 `toActivityVO`）：

```ts
interface RunTracePageVO {
  runs: RunTraceVO[];          // 本页，新到旧
  hasMore: boolean;
  unattributed: UnattributedGroupVO | null; // 仅第一页；没有则 null
}
interface UnattributedGroupVO {
  count: number;
  startedAt: string | null;
  endedAt: string | null;
  rounds: TraceRoundVO[];      // 这里的「轮」只是未归属的 llm_call，seq 在组内从 1
  tools: TraceToolVO[];
}
interface RunTraceVO {
  runId: number;               // 锚点用户消息 id
  userMessagePreview: string;
  startedAt: string | null;    // 锚点消息 created_at
  segments: TraceSegmentVO[];  // 未编辑过时只有一个 current
  sideCalls: TraceSideCallVO[];
  subagentLinks: { sessionId: number; title: string | null }[];
  markers: TraceMarkerVO[];    // kind: 'compaction' | 'interrupted' 已在轮上，标记列表只放 compaction
  totals: {
    wallClockMs: number;
    costMicros: number | null;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    toolSuccess: number;
    toolError: number;
  };
}
interface TraceSegmentVO {
  kind: 'before_edit' | 'current';
  rounds: TraceRoundVO[];
  unplacedTools: TraceToolVO[];
}
interface TraceRoundVO {
  seq: number;
  modelName: string | null;
  scene: 'agent';
  durationMs: number;
  firstTokenMs: number | null;
  retryCount: number;
  success: boolean;
  interrupted: boolean;        // error_message 含 Cancelled by user
  errorMessage: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costMicros: number | null;
  slow: boolean;
  expensive: boolean;
  tools: TraceToolVO[];
}
interface TraceSideCallVO {
  scene: string;
  modelName: string | null;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costMicros: number | null;
  success: boolean;
}
interface TraceToolVO {
  toolCallId: string | null;
  name: string;
  target: string | null;
  status: string;
  durationMs: number | null;   // 历史行与未回填行为 null，UI 显示「—」
  approvalMark: string | null;
}
interface TraceMarkerVO {
  kind: 'compaction';
  atMessageId: number;
  detail: string;
}
```

**路由**（`session.routes.ts`，紧邻 `/activities`）：

```ts
app.get('/v1/sessions/:id/trace', async (request, reply) => {
  const userId = requireUserId(request);
  const id = pathId(request);
  await requireSessionOwner(userId, id);
  const limit = Math.min(queryOptInt(request, 'limit') ?? 5, 50);
  const beforeRunId = queryOptInt(request, 'beforeRunId');
  const slowMs = clamp(queryOptInt(request, 'slowMs') ?? 60_000, 1_000, 3_600_000);
  const expensiveTokens = clamp(queryOptInt(request, 'expensiveTokens') ?? 50_000, 1_000, 10_000_000);
  return sendOk(reply, await deps.runTraceService.buildTrace(id, { beforeRunId, limit, slowMs, expensiveTokens }));
});
```

### 5.3 桌面端（P1）

- **形态：对话区中心 tab**，与边路对话、子代理、文件查看并列：
  - `types/file-browser.ts` 的 `Tab.type` 加 `'trace'`。
  - `useCenterTabs.ts` 加 `openTraceTab()`：每会话单例（`id = 'trace'`），已存在则激活。
  - `CenterTabContainer.vue` 加 `RunTracePanel` 分支，沿用 KeepAlive `:max="20"`。被逐出后按当前会话重拉，与首次打开同一条路径。
  - `recordActiveTabFor` 的通用分支能把 `{ type: 'trace', tabId: 'trace' }` 落盘。`restoreActiveTab` **不会**自己把轨迹 tab 建出来：它只在已有 `state.tabs` 里按 id 找，找不到就留在主会话。刷新还原必须在 `restoreActiveTab` 之前，若持久化类型是 `trace`，先 `openTraceTab()`。这不是零改动。
  - `closeOtherTabs` 只关 file / diff。轨迹 tab 会留下来，与边路任务、子代理一样。不要在实现时把它当成文件 tab 清掉。
- **入口**：检查器徽标区（上下文详情入口旁）加「轨迹」，点击 `openTraceTab()`。不放 ChatInput 工具栏。
- **面板**：
  - 顶部：慢 / 贵阈值（localStorage，改完带 query 重拉）、并行耗时说明、导出（P2）。
  - run 摘要条默认收起：用户消息预览、墙钟、token、成本、工具成败、徽标（压缩 / 失败 / 重试 / 中断 / 慢 / 贵 / 编辑前）。展开后按 segment 显示轮，轮内是工具。`unplacedTools` 单独一行「未挂到轮」。未归属组只在第一页、列表末尾。
  - 摘要条按最高严重度描边：失败红，重试与中断黄，慢与贵用中性色。
  - 历史 `durationMs == null` 显示「—」。`costMicros == null` 不显示金额。
- **实时态**：`tool_call_start` 记下工具名和起始时刻，本地走表，直到 `tool_call_result` 或执行结束。`round_start` / `round_end` 只更新「本次执行第 N 轮、是否仍在模型调用中」。`session_status` 变为 IDLE / COMPLETED / FAILED / CANCELLED 后，按当前锚点重拉 REST，丢掉临时行。恢复续跑时 WS 的 round 会从 1 再计，不允许把它写进已有 run 的 `seq`。
- **状态**：放在 session store 里与活动相邻的位置：`runTraces`、`traceHasMore`、`traceUnattributed`、进行中的临时轮 / 工具计时、阈值。进行中状态按 `executionId` 隔离。

### 5.4 admin 聚合（P2）

- `GET /v1/admin/analytics/run-trace?scope=&days=&scene=`。直接聚合 `llm_call` 与 `session_activity`，不经过 `RunTraceService`。
- `scene` 默认 `agent`。不默认的话，标题生成和连通性测试会占据「最慢轮」。
- 三个榜：最慢（`duration_ms`）、最贵（`cost_micros IS NOT NULL`）、工具失败率（`session_activity.status = 'ERROR'` 按 `type` 分组）。失败率沿用活动表现有状态，不另发明口径。
- 权限对齐现有 analytics。

### 5.5 导出（P2）

`GET /v1/sessions/:id/trace?limit=50` 按 `beforeRunId` 翻完，前端组两种下载：

- **JSON**：`RunTracePageVO` 逐页拼成 `{ runs, unattributed }`，结构与接口一致。
- **CSV**：模型行与 `admin` `LlmCallView` 的导出口径对齐，并加上轨迹列。表头：

  `runId, 段, 序号, 种类, 时间, 模型, 场景, 输入 Token, 输出 Token, 缓存 Token, 缓存写 Token, 成本, 耗时(ms), 状态, 错误信息, 名称, 目标, 审批`

  成本用 `cost_micros / 1e6` 的六位小数，null 留空。状态：中断写「已中断」，不要写成「失败」。工具行的 token / 成本 / 场景留空，`种类=tool`。旁路调用 `种类=side`，`序号` 留空。UTF-8 BOM，CRLF，单元格双引号转义，与现有 `csvCell` 一致。

## 6. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 埋点 + WS 轮事件 + RunTraceService + `/trace` + 轨迹 tab（摘要 / 展开 / 徽标 / 进行中计时 / 编辑前段）+ 阈值 query 与 localStorage | 中 |
| P2 | admin 三个榜 + JSON/CSV 导出 | 小 |
| P3 | 从子会话看父 run、边路任务链接、OTLP（按需，另案） | 中 |

## 7. 风险与开放问题

- **秒级时钟**（V142 已解决）：`message` / `llm_call` 的 `created_at` 与 `message.updated_at` 已提升为 `DATETIME(3)`，列默认值同步 `CURRENT_TIMESTAMP(3)`，存量数据不回填。同一秒内的多条模型调用现在可区分先后，工具组挂轮不再依赖「同秒也认」的兜底；`session_activity.created_at` 仍是秒级（工具结束时刻），它的归属仍以 `tool_call_id` 为准，秒级相等时留 `unplacedTools`。
- **同秒落库**：`llm_call.created_at`（调用结束）与 `message.created_at`（消息落库）同为秒级，流收尾与 `afterStream` 落库在同一个程序块先后执行，几乎总落在同一秒。挂轮候选判定因此是「不晚于」（`<=`）而非「严格早于」，否则工具组几乎永远挂不上。同秒仍有多条未占用候选（空响应重试等）时不猜，留 `unplacedTools`。
- **编辑重发的旧调用还在**：它们被收进「编辑前」，而不是混进当前段，也不是丢掉。多次编辑无法再细分，这是零 DDL 的上限。
- **工具阶段取消看起来像成功的空工具轮**：只认 `Cancelled by user`。不把「有 llm_call 无助手消息」判成中断。
- **异步活动插入**：可能晚于下一条用户消息。有 `tool_call_id` 时按消息 id 纠正，不按 `created_at` 改挂。
- **并行耗时求和**：UI 只展示墙钟，并写明重叠是正常的。
- **KeepAlive 逐出**：重挂载时重拉。激活态持久化要先 `openTraceTab()` 再 `restoreActiveTab`。
- **大会话**：一页 5 个 run，外加一次「全部用户消息 id + created_at」查询（未归属和编辑段都要用，不要按页各查一遍全表 `llm_call`）。单页组装超过 500ms 再优化：先把按 run 的调用改成窗口合并查询，再考虑物化表。本期不建物化表。
- **已关闭的问题**：排队消费是新 run。崩溃恢复不打段标记。预算 WARN 不进轨迹。定时任务在生产路径上是正常 run，不是未归属。

## 8. 决策记录

| # | 决策点 | 结论 | 论证摘要 |
|---|---|---|---|
| 1 | 产品定位 | 排障工具，非常驻叙事 | 默认收起、异常高亮 |
| 2 | run 单元 | 用户消息 id 区间 | `selectUserStarts` 已按 id 倒序。引擎 round 每次执行重置，不能当持久序号 |
| 3 | 排队 / 重发 / 重跑 | **修订**：排队是新的用户消息，因此是新 run。编辑重发留在同一 run，并用 `updated_at` 切开「编辑前」。崩溃恢复留在同一 run，不打段标记 | 排队路径会 `saveMessage(USER)`。恢复路径没有可落库的「这是恢复」事实。用时间缝猜段会制造错误线索 |
| 4 | 成本展示 | 轮级、旁路调用、run 合计都显示 | 合计包含窗口内全部 scene。任一行未配价则合计为 null。缓存写入 token 单独列出 |
| 5 | 失败 / 重试 / 中断 | **修订**：`error_message` 含 `Cancelled by user` 才是中断。`retry_count` 只表示适配器重试。空响应是多行成功调用 | 取消也会在 `finally` 落库。工具阶段取消与空响应无法区分，不猜测 |
| 6 | 实时性 | **修订**：完成态只认 REST。进行中用 `tool_call_start` 走表，轮事件只做临时行 | `duration_ms` 在工具结束才有，回答不了「卡了多久」。恢复后续跑的 WS round 从 1 重计，不能写进 `seq` |
| 7 | 子代理 / 边路 | 只放 `delegate` / `delegate_followup` 的 `child_session_id` 链接 | 不扫边路子会话，不串联 |
| 8 | 分享快照 | 轨迹不进分享 | 含成本与错误细节 |
| 9 | 对不上的数据 | run 内「未挂到轮」+ 第一页会话级「未归属」 | 不使用 `runId = 0`。不对秒级边界做就近猜测 |
| 10 | 工具耗时 | 执行层 `durationMs` + 按结束时刻估算的墙钟 | 见 §5.2 墙钟公式 |
| 11 | 慢 / 贵阈值 | **修订**：query 参数，默认 60s / 50k，桌面 localStorage | 现有 preference 只有微信和任务面板，没有通用键值。新建偏好表会破坏零 DDL |
| 12 | 导出 | JSON + CSV | CSV 成本列与 `llm-calls` 导出相同 |
| 13 | admin 范围 | 三个榜，默认 `scene=agent` | 不经 RunTraceService |
| 14 | 记忆注入标记 | 不做 | 属上下文透视 |
| 15 | 桌面入口 | 中心 tab `'trace'`，入口在检查器徽标区 | 刷新还原要先创建 tab 再 `restoreActiveTab` |
| 16 | 预算标记 | **修订**：不做 | `BUDGET_WARN.session_id` 恒为 null |
| 17 | 文件变更 | 不进轨迹 | 消息流已展示。相对提案的收窄 |
| — | 性能底线 | 5 run/页、上限 50；单页 >500ms 才优化 | 同上 |
| — | 移动端 | 不单独适配 | 跟随检查器是否可见 |

## 9. 测试要点

- **埋点**：成功、失败、LOCAL 委托三条路径的 `session_activity.duration_ms` 等于 `toolResultMeta.durationMs`；`detail_json` 含 `toolCallId`；有审批时含 `approvalMark`。`WsListenerDeps` 允许传入这两个参数。WS `activity` 带 `duration_ms`。历史行仍为 null 时 API 返回 null。
- **轮事件**：取消路径也成对。`executionId` 随 `send()` 带上。陈旧执行的 `round_*` 被丢掉。IDLE 后临时行被 REST 结果替换，且 REST `seq` 不采用 WS round。
- **进行中计时**：`tool_call_start` 之后、结果回来之前，面板上的耗时来自本地时钟，不来自 `duration_ms`。
- **归属**：同一助手消息上的多个工具（含并行）归同一轮；`tool_call_id` 对得上时，即使 activity.`created_at` 落入下一条用户消息之后，仍归原 run。对不上且同一秒有多条候选的，进 `unplacedTools`。
- **排队**：队列消费产生的新用户消息是新 run，不进上一个 run 的段。
- **编辑重发**：`updated_at` 之前的 `scene=agent` 调用在 `before_edit`；现存消息上的工具在 `current`。只编辑过一次和编辑过多次都只有一个「编辑前」。
- **崩溃恢复**：同一用户消息区间里的恢复后调用出现在 `current`，没有「恢复」标记。
- **取消与空响应**：`Cancelled by user` 为 `interrupted` 且不计入失败。空响应多行均为成功轮，`retry_count` 为 0。工具阶段取消留下的成功调用不标中断。
- **旁路调用**：窗口内 `scene=compaction`（或标题）不占 `seq`，token 与成本进入 `totals`。合计在任一调用 `costMicros == null` 时为 null。`cacheCreationTokens` 单独累计。
- **压缩**：标记只跟 `boundary_msg_id` 走。
- **未归属**：早于第一条用户消息的调用出现在第一页的 `unattributed`；第二页为 null；最后一条用户消息之后的调用属于该 run。定时任务保存的用户消息是正常 run。
- **阈值**：恰好等于边界即标记。非法 query 被钳制。贵看四类 token 之和，与是否配价无关。
- **分页**：`beforeRunId` 不重不漏；`hasMore` 只在页上；`limit` 上限 50。
- **子代理**：`delegate` 成功和失败结果里的 `child_session_id` 都变成链接；没有该字段则没有链接。
- **导出**：JSON 与接口一致；CSV 成本格式与 `LlmCallView` 一致，中断不写成失败。
- **tab**：`openTraceTab()` 单例；持久化 `{type:'trace', tabId:'trace'}` 后，不先 `openTraceTab()` 则 `restoreActiveTab` 留在主会话；先打开再还原能回到轨迹 tab。`closeOtherTabs` 不关闭轨迹 tab。既有 file / diff / side_task / subagent 行为不变。
- **回归**：`/activities` 的既有字段不变，`durationMs` 从 null 变为真实值只作用于新写入。
