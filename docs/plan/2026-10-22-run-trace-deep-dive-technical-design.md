# 运行轨迹深度下钻技术方案：VO 增量 → 时间概览条带 → 记录详情下钻 → 计时补全

- 状态：待实施（2026-10-22 设计共识；逐条决策见 §8）
- 日期：2026-10-22
- 提案来源：[docs/proposals/2026-10-22-run-trace-deep-dive.md](../proposals/2026-10-22-run-trace-deep-dive.md)
- 前序方案：[docs/plan/2026-10-09-run-trace-technical-design.md](2026-10-09-run-trace-technical-design.md)（已上线，本方案只做增量，不改其口径）
- 外部参照：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）的 Trajectory 视图

## 1. 需求背景

2026-10-09 的运行轨迹（下称「已上线部分」）已交付「会话总览 → run → 轮次 → 工具行」的渐进下钻：慢/贵阈值、审批标记、编辑前/当前分段、旁路调用、子代理链接、压缩标记、JSON/CSV 导出、执行中临时卡片。它回答「整体怎么样、哪一轮慢、哪个工具卡、花了多少钱」。

本方案补上它缺的三个维度，全部只做增量，不动已上线口径：

1. **时间不可见**：已上线部分只有数字，看不出「谁在等谁、并行还是串行、首字慢还是解码慢」。本次在 run 展开区顶部加时间概览条带，把轮次/工具/旁路按真实开始时刻与耗时投影出色条。
2. **记录不可钻**：工具行只有一行摘要（名称 / 目标 / 耗时），参数与结果要回聊天记录里翻。本次加按需拉取的记录详情抽屉。
3. **维度不全**：无解码耗时、吞吐量、provider。本次在轮次行补这三项展示（前端派生，零后端计算）。

对比外部参照的结论保持不变：mao 轨迹强在成本核算、审批标记、编辑前分段、导出与服务端归属兜底；本方案只补 mao 的差距，不照搬 dsh 的拖选/缩放/虚拟化等重交互形态。

## 2. 需求描述

### 2.1 目标

1. **run 内时间概览条带**：在 run 卡展开区顶部渲染 SVG 条带，与该 run 时间域对齐。轮次、工具（含未挂到轮）、旁路调用各一个色条，起点 `startedAtMs`、宽度 `durationMs`；助手轮次分「首字 / 解码」两段。悬停显示类型、起止时刻、耗时；点击色条展开该 run 并滚动定位到对应行。
2. **记录详情下钻**：点工具行或轮次行开抽屉，按需拉取参数 JSON、结果 JSON、完整计时与请求元信息（provider / protocol / stream / effort / retry / error）。轨迹主 VO 不带正文，防载荷膨胀。
3. **计时与用量补全**：轮次行增显 provider 徽标、解码耗时（`durationMs − firstTokenMs`）、吞吐量（输出 tok/s）。

### 2.2 非目标

以下全部**不做**，写入本节以免范围蔓延：

| # | 不做的事 | 原因 |
|---|---|---|
| N1 | 轨迹内搜索 | 提案 P2；纯前端过滤，单独排期价值更高 |
| N2 | 拖选时间区间聚焦、滚轮缩放、右键平移 | 提案明确 P1 只做悬停 + 点击定位；交互成本高 |
| N3 | 请求构成记录（提示词版本 + 工具目录进轨迹，`llm_call` 加 `prompt_version_id` / `tools_digest`） | 需动 harness 写入链路，写入成本 vs 排障价值需单独评审 |
| N4 | 外部可观测对接（OTLP / Prometheus） | 沿用 2026-10-09 边界 |
| N5 | 为色条新建 `started_at` 列 / 精确起点埋点 | 沿用 `created_at − duration_ms` 估算口径，秒级误差可接受 |
| N6 | 改归属口径、改导出结构语义、回填历史数据 | 已上线口径不动；新字段只做增量扩展 |
| N7 | 全会话服务端轨迹搜索 | 已有全局消息检索覆盖 |
| N8 | 跨 run 会话累计编号、「累计至本轮」用量、总览区「累计请求数」 | 跨页翻序 + 未归属组会让 UI 层累计值误导，收益不足以抵住口径风险 |
| N9 | 请求选项 JSON、系统提示词与工具目录快照及 diff、思考内容、附件灯箱、重试进度与上次尝试错误、错误码、`run_code` 源码高亮 | dsh 记录检查器的其余 tab；P1 抽屉只做参数 / 结果 / 计时与元信息 |
| N10 | admin / android / mao-cli 功能改动 | 提案边界；mao-cli 仅同步文档 |
| N11 | 时间条带全局固定化（总览下方跨 run 条带） | 需虚拟化与横向滚动；长 run 卡顿再评估 |

## 3. 范围界定

### 3.1 做什么

| 层 | 文件 / 模块 | 内容 |
|---|---|---|
| backend-ts | `src/session/session-vo.ts` | `TraceRoundVO` / `TraceToolVO` / `TraceSideCallVO` / `UnattributedGroupVO` 共用的 VO 增量（§5.1） |
| backend-ts | `src/session/run-trace.service.ts` | `toRoundVO` / `toToolVO` / `toSideCallVO` 补 `startedAtMs` / `provider`；`toRoundVO` 补 `llmCallId`；新增 `buildToolRecord` / `buildCallRecord` 两个只读查询方法 |
| backend-ts | `src/session/run-trace-record.service.ts`（新） | 记录详情读模型：按 `tool_call_id` / `llm_call_id` 取详情并做会话归属校验 |
| backend-ts | `src/session/session.repository.ts` | 补 `selectAssistantByToolCallId(sessionId, toolCallId)`（反查声明该调用的助手消息）与 `selectToolMessageByCallId(sessionId, toolCallId)` |
| backend-ts | `src/usage/llm-call.repository.ts` | 补 `selectById(id)`（`llm_call` 主键查询，服务 `buildCallRecord`） |
| backend-ts | `src/session/session.routes.ts` | 新增 `GET /v1/sessions/:id/trace/records/tool/:toolCallId` 与 `GET /v1/sessions/:id/trace/records/call/:llmCallId`，权限复用 `requireSessionOwner` |
| backend-ts | `src/create-app.ts` | 注入 `RunTraceRecordService`（新实例） |
| desktop | `src/types/trace.ts` | 同步 VO 新字段；新增 `TraceToolRecord` / `TraceCallRecord` 类型 |
| desktop | `src/components/center/RunTraceTimeBand.vue`（新） | 时间概览条带（SVG + 悬停 tooltip + 点击定位） |
| desktop | `src/components/center/RunTraceRecordDrawer.vue`（新） | 记录详情抽屉（面板内 absolute 定位，不挂全局侧边栏） |
| desktop | `src/components/center/RunTracePanel.vue` | run 展开区顶部挂条带；轮次行 / 工具行加下钻入口与 provider / 解码 / 吞吐展示；行 DOM 加 `id` 锚点供定位 |
| desktop | `src/utils/trace-display.ts` | 新增纯函数：`decodingMs` / `throughput` / `runTimeWindow` / 色条坐标计算（供单测） |
| desktop | `src/utils/trace-export.ts` | CSV 表头追加 `provider` 一列（模型行填值，工具行留空） |
| desktop | `src/stores/session.ts` | 记录详情抽屉的加载态缓存（`traceRecords`，按 `sessionId` + key 缓存，切会话不串） |
| 文档 | `CHANGELOG.md` | 顶部 `## 0.0.336 (2026-10-22)` 新增「后端」+「前端（桌面 / Web / 安卓）」小节 |
| 文档 | `skills/mao-cli/reference/desktop.md` | 「运行轨迹」小节补条带、下钻、计时三项说明 |

### 3.2 不做什么

同 §2.2 的 N1–N11。另加两条实现层面的约束：

- 不加任何数据库迁移（`V143+` 不出）。`llm_call` 的 `provider` / `protocol` / `stream` / `effort` / `retry_count` / `first_token_ms` / `duration_ms` / `error_message` 与 `message` 的 `tool_calls` / `tool_call_id` / `content` / `metadata` 全都已存在。
- 不改 `RunTraceQuery`、不改 `/trace` 的 query 参数、不改分页与归属逻辑、不改 `RunTraceService.buildTrace` 的既有分支。

## 4. 技术选型与关键决策

零新增依赖、零数据库迁移。决策及论证见 §8。五个塑形整体架构的结论：

| # | 决策 | 结论 |
|---|---|---|
| D1 | 范围 | 严格按提案 P1 四项：VO 增量 + 时间条带 + 记录详情下钻 + 计时补全。搜索、埋点、拖选缩放明确不做 |
| D2 | 详情 API 形状 | 两个端点按 key 分流：`/trace/records/tool/:toolCallId` 与 `/trace/records/call/:llmCallId`，共用一段 `llm_call` 查询逻辑 |
| D3 | 条带位置与范围 | run 展开区顶部；轮次 + 工具（含未挂到轮）+ 旁路调用三类都画色条 |
| D4 | 时间口径 | `startedAtMs` 由服务端按 `created_at − duration_ms` 估算（复用 `run-window.ts` 语义）；条带横轴取 run 内全部节点估算起止的 min/max，不直接用 `totals.wallClockMs` |
| D5 | 计时补全范围 | 只补 provider 徽标 + 解码耗时 + 吞吐量；跨 run 累计编号与累计 token 不做 |

技术选型：

- **条带渲染**：手写 SVG，不引图表库。条带节点数 = 轮数 + 工具数 + 旁路数（单 run 内通常 < 100），SVG 直接渲染足够；dsh 的虚拟化只在其全局固定条带形态下才必要，本方案不做全局形态（D3）。
- **JSON 展示**：不引 JSON 树库。结果 JSON 用 `<pre>` 原样展示 + 「换行 / 原样」切换；参数 JSON 同样两档。理由：抽屉是排障视图，原样文本最利于复制比对；树形折叠在深嵌套大对象上反而更难定位。
- **抽屉容器**：面板内 `position: absolute` 的自绘抽屉，不用 `el-drawer`。理由：`el-drawer` 默认 append-to-body，会挂到全局 body 下，正是 0.0.3xx 修过的「轨迹 Tab 打开时边栏会话错配」类问题的温床；本方案要求抽屉的 `sessionId` 上下文严格属于面板自身。

## 5. 详细设计

### 5.1 VO 增量（backend-ts，零迁移）

`session-vo.ts` 的轨迹读模型 VO 增补字段。全部为增量可选语义字段，旧桌面忽略即无影响。

```ts
export interface TraceRoundVO {
  // ...既有字段不动
  /** llm_call 主键：轮次行下钻的定位 key；历史行理论上恒有值（llm_call 才有这一行） */
  llmCallId: number | null;
  /** 估算开始时刻（epoch ms）= Date.parse(created_at) − duration_ms；两侧任一缺失为 null */
  startedAtMs: number | null;
  /** llm_call.provider 冗余快照列（V113 建表即有），轮次行展示用 */
  provider: string | null;
}

export interface TraceSideCallVO {
  // ...既有字段不动
  startedAtMs: number | null;
  provider: string | null;
}

export interface TraceToolVO {
  // ...既有字段不动
  /** 估算开始时刻（epoch ms）= Date.parse(created_at) − duration_ms；两侧任一缺失为 null */
  startedAtMs: number | null;
}
```

字段语义与空值口径（写进 VO 注释，前端不许猜）：

- `startedAtMs`：`createdAt == null || durationMs == null` → `null`。前端不画色条、tooltip 不显示，显示「—」。**不为 null 补 0、不用 `createdAt` 冒充起点。**
- `provider`：`llm_call.provider` 原样透出；null 时前端不渲染徽标。
- `llmCallId`：`call.id`。理论上 `llm_call` 行恒有自增 id，为兜底仍声明 `| null`。

`decodingMs` 与吞吐量**不进 VO**（前端用 `durationMs − firstTokenMs`、`completionTokens ÷ 解码秒` 现算），理由：二者是纯派生量，进 VO 会让「同一数字两处真相」，且 `firstTokenMs` 为 null 时服务端只能填 null，与前端算 null 等价，却多一次跨端契约变更。

### 5.2 `RunTraceService` 增量

`toRoundVO` / `toSideCallVO` / `toToolVO` 各补字段，从已有的 `LlmCallRow` / `SessionActivity` 上取，不新增查询：

```ts
function toRoundVO(call: LlmCallRow, seq: number, query: RunTraceQuery): TraceRoundVO {
  return {
    // ...既有字段
    llmCallId: call.id ?? null,
    startedAtMs: estimatedStartMs(call.createdAt, call.durationMs),
    provider: call.provider ?? null,
  };
}
```

`estimatedStartMs` 放进 `run-window.ts`（与 `wallClockMs` 同文件的估算语义集中一处，避免两处各写一份 `Date.parse(...replace(' ','T'))`）：

```ts
/** 「结束时刻 − duration」的估算起点（epoch ms）；任一侧缺失或解析失败为 null。 */
export function estimatedStartMs(createdAt: string | null | undefined, durationMs: number | null | undefined): number | null {
  if (createdAt == null) return null;
  const end = toEpochMs(createdAt);
  if (end == null) return null;
  return end - Math.max(0, durationMs ?? 0);
}
```

`wallClockMs` 内部改为复用 `estimatedStartMs`，保持「墙钟」与「色条」同一估算口径（这是 D4 的一部分：两者不一致会出现色条画出墙钟右边界）。

### 5.3 记录详情读模型（backend-ts，新 service）

新文件 `backend-ts/src/session/run-trace-record.service.ts`。只读，不写任何表。

```ts
export interface TraceToolRecordVO {
  toolCallId: string;
  /** 助手消息 tool_calls 数组里该次调用的元素：name + argumentsJson 原文 */
  toolName: string | null;
  argumentsJson: string | null;
  /** TOOL 消息 content 原文（含 metadata 的审批标记由调用方从 toolMetadata 读） */
  resultContent: string | null;
  resultMetadata: string | null;
  /** 配对 llm_call 的完整元信息；配不上为 null */
  call: TraceCallMetaVO | null;
}

export interface TraceCallMetaVO {
  llmCallId: number | null;
  provider: string | null;
  protocol: string | null;
  stream: boolean | null;
  effort: string | null;
  scene: string | null;
  modelName: string | null;
  retryCount: number;
  firstTokenMs: number | null;
  durationMs: number;
  errorMessage: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costMicros: number | null;
  createdAt: string | null;
}

export interface TraceCallRecordVO {
  call: TraceCallMetaVO | null;
  /** 该轮已声明且现存于会话内的工具（toolCallId + 名称 + 目标摘要），供抽屉内跳转 */
  tools: Array<{ toolCallId: string; name: string; target: string | null }>;
}
```

查询流程：

- `buildToolRecord(sessionId, toolCallId)`：
  1. `messageRepo.selectToolMessageByCallId(sessionId, toolCallId)` 取 TOOL 消息（结果 + metadata）；没有则 `tool` 侧全 null。
  2. `messageRepo.selectAssistantByToolCallId(sessionId, toolCallId)` 取声明该调用的助手消息，从 `tool_calls` 数组里按 id 取 `name` 与 `argumentsJson`。
  3. 配对 `llm_call`：用助手消息的 `created_at` 与 TOOL 消息的 `created_at` 夹一个时间窗，`llmCallRepo.selectBySessionWindow(sessionId, start, end)` 取窗口内调用，取 `scene = 'agent'` 的最后一条（与 `buildRun` 的工具组挂轮同一「最后一条未占用候选」精神）。窗口取不到则为 null，**不跨窗猜**。
- `buildCallRecord(sessionId, llmCallId)`：
  1. `llmCallRepo.selectById(llmCallId)`；`row.sessionId !== sessionId` 视为不存在（防越权读他人会话的调用行）。
  2. 该轮工具清单：复用 `selectAssistantToolCalls(sessionId)`（已有方法）按 `created_at` 落在 `[row.created_at − duration, row.created_at]` 内的助手消息，展开其 `tool_calls`。**这是近似归属，仅用于抽屉内跳转链接**，跳过去仍以 `buildToolRecord` 的按 `tool_call_id` 精确查询为准——近似只决定「列出哪些可点的链接」，不决定内容。

会话归属校验：路由层已 `requireSessionOwner(userId, sessionId)`；`buildCallRecord` 内再校验 `row.sessionId === sessionId`（双保险，`llm_call.session_id` 与 message 表同源，理论上一致）。

`session.repository.ts` 新增两个方法（都不加索引——`tool_call_id` 反查是点开抽屉时的一次性查询，`message` 表按 session 过滤后行数可控）：

```ts
/** 按 tool_call_id 反查声明该调用的助手消息（详情下钻用；tool_calls 是 JSON，走 LIKE 前缀匹配）。 */
selectAssistantByToolCallId(sessionId: number, toolCallId: string): Promise<Message | null>

/** 按 tool_call_id 取 TOOL 行（详情下钻用；与 selectToolMessagesByCallIds 的区别是单条 + 不限消息 id 上界）。 */
selectToolMessageByCallId(sessionId: number, toolCallId: string): Promise<Message | null>
```

`selectAssistantByToolCallId` 的 `tool_call_id` 要做 LIKE 转义（`%` / `_` / `\`），用 `message-search.ts` 已有的 `escapeLike` 思路；`tool_call_id` 本身来自后端 VO（不是用户输入），仍按边界输入统一处理。

### 5.4 路由（backend-ts）

```ts
// run 轨迹记录详情（技术方案 2026-10-22-run-trace-deep-dive §5.3）。
// 按需拉取，轨迹主 VO 不带正文；找不到返回空态 VO（200），不抛 404。
app.get('/v1/sessions/:id/trace/records/tool/:toolCallId', async (request, reply) => {
  const userId = requireUserId(request);
  const id = pathId(request);
  await requireSessionOwner(userId, id);
  return sendOk(reply, await deps.runTraceRecordService.buildToolRecord(id, pathId(request, 'toolCallId') as unknown as string));
});

app.get('/v1/sessions/:id/trace/records/call/:llmCallId', async (request, reply) => {
  const userId = requireUserId(request);
  const id = pathId(request);
  await requireSessionOwner(userId, id);
  return sendOk(reply, await deps.runTraceRecordService.buildCallRecord(id, queryOptInt(request, 'llmCallId') ?? 0));
});
```

`toolCallId` 是路径字符串，需先校验非空与长度上限（如 128），非法直接返回空态 VO 而非 500。`llmCallId` 走 `queryOptInt` 同款钳制，非正整数返回空态 VO。

空态 VO（前端据此提示，不静默）：

```ts
const EMPTY_TOOL_RECORD: TraceToolRecordVO = {
  toolCallId, toolName: null, argumentsJson: null, resultContent: null, resultMetadata: null, call: null,
};
const EMPTY_CALL_RECORD: TraceCallRecordVO = { call: null, tools: [] };
```

### 5.5 时间概览条带（desktop）

新组件 `RunTraceTimeBand.vue`，props：`run: RunTrace`、`activeKey: string | null`（当前定位到的节点 key）、`emits('locate', key: string)`。

**数据准备**（纯函数放 `trace-display.ts`，供单测）：

```ts
export interface TimeBandNode {
  /** 定位 key：round 用 `round:${seq}`，工具用 `tool:${toolCallId ?? name}`，旁路用 `side:${index}` */
  key: string;
  kind: 'round' | 'tool' | 'side';
  label: string;
  startedAtMs: number | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  status: 'ok' | 'error' | 'interrupted';
}

export function runTimeNodes(run: RunTrace): TimeBandNode[]
export function runTimeWindow(nodes: TimeBandNode[]): { startMs: number; endMs: number } | null
export function timeBandGeometry(node: TimeBandNode, window: { startMs: number; endMs: number }, width: number, lane: number): {
  x: number; width: number; segments: Array<{ x: number; width: number; part: 'ttft' | 'decode' }> | null
} | null
```

- `runTimeNodes`：轮次取 `segment.rounds`（`before_edit` 与 `current` 都取），工具取 `segment.rounds[].tools` 与 `segment.unplacedTools`，旁路取 `run.sideCalls`。`startedAtMs == null || durationMs == null` 的节点**仍进数组**（用于 tooltip 说明与总数），但 `timeBandGeometry` 返回 null → 不画色条。这与已上线「未挂到轮不猜」同口径。
- `runTimeWindow`：全部节点的 `[startedAtMs, startedAtMs + durationMs]` 的 min/max；全 null 返回 null → 组件整体不渲染（与「没有可投影的行」一致，不画空条）。
- 横轴宽度 = `endMs - startMs`；`startMs === endMs`（单点）时给一个最小宽度（如 2px）避免除零。
- 泳道：轮次一条泳道、工具一条泳道、旁路一条泳道，共 3 行 + 一条时间刻度行。同一泳道内并行色条自然重叠（`executeToolCalls` 是 `Promise.all`，重叠即表达并行），**不做堆叠避让**——堆叠会让「谁在等谁」读不出来。

**渲染与交互**：

- SVG `viewBox="0 0 100 高"` + `preserveAspectRatio="none"`，宽度 100% 自适应面板；色条 `x` / `width` 用百分比，文字与 tooltip 用像素容器定位。面板宽度约 320–480px，3 泳道 × 最多约 40px 高。
- 助手轮次分两段：`firstTokenMs != null && firstTokenMs > 0 && firstTokenMs < durationMs` 时画 `[0, firstTokenMs)`（首字，实色）+ `[firstTokenMs, durationMs)`（解码，同色 55% 透明）；否则单段。两段宽度和恒等于总宽（单测断言）。
- 悬停：色条 `mouseenter` 后 300ms 显示 tooltip（复用项目里 `el-tooltip` 的 `:show-after` 习惯，但条带是 SVG，直接用自绘绝对定位 div 更可控）。tooltip 内容：`类型 · 标签`、`起 估算 HH:mm:ss.SSS`、`止 估算 HH:mm:ss.SSS`、`耗时 X`。起止都带「估算」标注（D4：估算口径必须对用户可见）。
- 点击：`emit('locate', key)`。父组件 `RunTracePanel` 收到后：确保该 run 已展开（`expandedRuns` 加入 `runId`）→ `nextTick` 后 `document.getElementById(rowAnchorId)` → `scrollIntoView({ block: 'center', behavior: 'smooth' })` → 该行加 1.2s 的高亮 class 后移除。
- 未归属组不画条带（`unattributed` 没有 run 上下文，且其行不展开轮次明细）。

**行锚点**：`RunTracePanel.vue` 的轮次行与工具行各加 `:id="rowAnchorId(kind, key)"`。id 规则 `trace-${sessionId}-${kind}-${key}`，带 sessionId 防多轨迹 Tab 并存时串锚。

### 5.6 记录详情抽屉（desktop）

新组件 `RunTraceRecordDrawer.vue`。结构：`RunTracePanel.vue` 内 `position: absolute; inset: 0`（覆盖面板内容区，不盖面板外）的自绘抽屉，右侧滑入 380px，左侧留遮罩只挡面板内。

- **数据**：打开时 `api.get(...)`，加载态存 session store 的 `traceRecords`（`Map<string, TraceToolRecordVO | TraceCallRecordVO>`，key = `tool:${toolCallId}` / `call:${llmCallId}`），按 `sessionId` 分桶；切会话清空。已缓存的记录再点直接展开，不重复请求。
- **工具记录抽屉**：三个 tab。
  - `参数`：`argumentsJson` 原文。合法 JSON 时提供「格式化 / 原样」切换（`JSON.stringify(JSON.parse(x), null, 2)` vs 原文）；非法 JSON 按原样文本展示，不报错、不显示「解析失败」红字。
  - `结果`：`resultContent` 原文，同样两档切换。多模态 JSON 数组（图片分片）也按原样展示——排障要看的就是服务端存的原文。
  - `计时与元信息`：`call` 的 `TraceCallMetaVO` 全字段表格 + 派生三行（解码耗时、吞吐量、请求编号 `#llmCallId`）。`call == null` 时显示「未配对到模型调用记录」。
- **轮次记录抽屉**：单页，无 tab。
  - 上部：`call` 的完整元信息 + token 明细（输入 / 缓存读 / 缓存写 / 输出）+ 派生三行（解码、吞吐、编号）。
  - 下部：「本轮工具（N）」清单，每行 `状态图标 · 中文工具名 · target`，点击跳转到对应工具记录抽屉（`emit('open-tool', toolCallId)` → 父组件切 key 重新拉取）。
- **关闭**：右上角 × + 点遮罩 + `Esc`。关闭不清缓存。
- **敏感面**：参数 / 结果正文仅会话所属用户可见（路由已校验）；导出仍不带正文（`trace-export.ts` 不动 JSON 结构语义，只加 CSV 的 `provider` 列）。

### 5.7 计时与用量补全展示（desktop）

`RunTracePanel.vue` 轮次行 `round-metrics` 增补（顺序：耗时 → 解码 → 吞吐 → 首字 → tokens → 成本）：

- `provider` 徽标：`round.provider` 非空时在 `round-model` 后渲染一个小徽标（`badge-neutral` 样式，复用现有 class）。
- 解码耗时：`decodingMs(round)` = `firstTokenMs != null && firstTokenMs <= durationMs ? durationMs - firstTokenMs : null`；null → 「—」。
- 吞吐量：`throughput(round)` = 解码秒 > 0 ? `completionTokens / (decodingMs/1000)` : null；null → 「—」。取 1 位小数 + `tok/s`。

三个纯函数进 `trace-display.ts` 并补单测（`firstTokenMs` 为 null、`firstTokenMs > durationMs`（时钟异常）、`completionTokens` 为 0、`decodingMs` 为 0 四类边界）。

`decodingMs > durationMs` 不可能（有 `firstTokenMs <= durationMs` 前置），但 `firstTokenMs > durationMs` 的异常行要显示「—」而不是负数——这是「不猜」原则的延伸。

### 5.8 导出兼容

- JSON：`buildTraceJson` 不动，逐页拼的 VO 自然带上 `llmCallId` / `startedAtMs` / `provider`（提案「新字段增量扩展」）。
- CSV：`CSV_HEADER` 追加 `provider`（放在 `模型` 之后），模型行填 `row.provider ?? ''`，工具行留空。列数 18 → 19。
- `startedAtMs` / `llmCallId` / 解码 / 吞吐**不进 CSV**：前者是 epoch ms 与主键，对人类复盘无意义；后两者是前端派生量，与 CSV 的「落库事实」定位冲突。
- 同步更新 `desktop/src/utils/trace-export.test.ts` 的表头断言。

## 6. 落地清单

按依赖顺序，每步可独立验证。

| # | 步骤 | 文件 | 验证 |
|---|---|---|---|
| 1 | `run-window.ts` 加 `estimatedStartMs`，`wallClockMs` 改为复用 | `backend-ts/src/session/run-window.ts` | `npm test`（`run-window` 相关用例） |
| 2 | VO 加三字段 + `toRoundVO`/`toToolVO`/`toSideCallVO` 补值 | `session-vo.ts`、`run-trace.service.ts` | 扩 `run-trace.service.spec.ts`：`startedAtMs` 换算、null 行为、`provider` 透出、`llmCallId` |
| 3 | repository 补 `selectAssistantByToolCallId` / `selectToolMessageByCallId` / `llmCallRepo.selectById` | `session.repository.ts`、`llm-call.repository.ts` | 扩 `session.repository.spec.ts`（或按现有 mock 风格补） |
| 4 | 新 `run-trace-record.service.ts` + 两个 VO + spec | 新文件 | 新 `run-trace-record.service.spec.ts`：配对成功 / 配不上 / 越权 sessionId / toolCallId 不存在 |
| 5 | 路由两个端点 + deps 注入 | `session.routes.ts`、`create-app.ts` | 扩 `session.routes.spec.ts`：路径参数非法、归属拒绝、空态 VO |
| 6 | desktop types 同步 + `trace-display.ts` 纯函数 | `types/trace.ts`、`utils/trace-display.ts` | 扩 `trace-display.test.ts` |
| 7 | `RunTraceTimeBand.vue` + 面板挂载 + 行锚点 + 点击定位 | 新组件、`RunTracePanel.vue` | 扩 `run-trace-panel-session.test.ts`：条带节点数、null 不画、点击定位 emit |
| 8 | `RunTraceRecordDrawer.vue` + store 缓存 + 入口 | 新组件、`stores/session.ts`、`RunTracePanel.vue` | 扩 `run-trace-panel-session.test.ts`：抽屉打开 / 空态提示 / tab 切换 |
| 9 | 轮次行 provider / 解码 / 吞吐展示 | `RunTracePanel.vue` | 扩 `run-trace-panel-session.test.ts` 或 `trace-display.test.ts` |
| 10 | CSV 加 `provider` 列 | `utils/trace-export.ts` | 扩 `trace-export.test.ts` 表头断言 |
| 11 | `vue-tsc -b --force` + `npm run build`（desktop） | desktop | 类型与构建通过 |
| 12 | CHANGELOG + mao-cli 文档 | `CHANGELOG.md`、`skills/mao-cli/reference/desktop.md` | 目视核对小节归属（后端 / 前端） |

## 7. 风险与开放问题

- **估算起点有误差**：`created_at − duration_ms` 在工具并行 / 时钟偏差下色条起点不准。缓解：tooltip 标注「估算」；不新建列（N5）。开放问题：若未来要精确色条，在 tool 执行 WS 事件带 start timestamp 落 `session_activity`（需加列 + 动写入链路），单独评审。
- **历史数据退化**：秒级 `created_at` 的历史行、`first_token_ms` 为 null 的非流式调用，色条退化为单段或不画。不回填、不猜，与已上线「未挂到轮」同口径。
- **条带横轴与墙钟不一致**：若有人后来把横轴改成 `totals.wallClockMs`，色条会溢出。缓解：`wallClockMs` 与 `estimatedStartMs` 共用同一换算（步骤 1），并在 §5.5 的注释里写明「横轴必须取节点 min/max」。
- **抽屉布局**：自绘 absolute 抽屉在 `CenterTabContainer` 内需自理滚动与 z-index；不用 `el-drawer`（append-to-body 会带出跨会话错配类问题，见 §4 选型）。
- **`selectAssistantByToolCallId` 走 LIKE**：`message.tool_calls` 是 JSON 文本，没有索引。单次点开抽屉才查，`session_id` 过滤后行数可控；若 profiling 发现慢，再评估加生成列 + 索引（不在本期）。
- **轮次工具清单是近似归属**：`buildCallRecord` 的 `tools` 用时间窗近似，可能与 `buildTrace` 的挂轮结果不同。缓解：清单只做跳转链接，内容一律以 `buildToolRecord` 按 `tool_call_id` 的精确查询为准；抽屉内不展示「本轮工具」的成败汇总，避免把近似值当事实。
- **开放问题**：请求构成埋点（N3）与拖选/缩放（N2）是否排期，需单独评审；本方案不依赖它们。

## 8. 决策记录

| # | 决策点 | 结论 | 论证摘要 |
|---|---|---|---|
| 1 | 本轮范围 | 严格按提案 P1 四项；搜索 / 埋点 / 拖选缩放明确不做 | 搜索与埋点价值真实但需独立评审与写入链路改动；拖选缩放交互成本高。写进非目标避免 P2 永不落地也避免范围蔓延 |
| 2 | 下钻入口 | 工具行 + 轮次行都能下钻 | 提案目标 2 即如此；轮次行缺 protocol/stream/effort 等元信息，只有下钻能给全 |
| 3 | 详情 API 形状 | 两个端点按 key 分流：`/trace/records/tool/:toolCallId`、`/trace/records/call/:llmCallId` | key 语义不同（一个查 message 表、一个查 llm_call 表），单端点 + query kind 会让路由分派依赖可选参数、易漏校验 |
| 4 | 条带位置 | run 展开区顶部，不全局固定 | 全局条带需虚拟化 + 横向滚动，长会话才值得；run 内条带零虚拟化成本，且与现有展开态天然衔接 |
| 5 | 条带绘制范围 | 轮次 + 工具（含未挂到轮）+ 旁路调用都画 | 旁路计入 run 墙钟，不画会出现「墙钟 30s 却有色条空白」的观感 |
| 6 | 时间口径 | `startedAtMs` 由服务端按 `created_at − duration_ms` 估算，零迁移 | 提案明确不新建列；毫秒级 `created_at`（V142）下误差可接受；tooltip 标「估算」 |
| 7 | 条带横轴 | 取 run 内全部节点估算起止 min/max，不用 `totals.wallClockMs` | 直接拿墙钟当总宽会让最后一条色条溢出右边界（墙钟是跨度、不是右端点） |
| 8 | 计时补全范围 | 只做 provider + 解码耗时 + 吞吐量；跨 run 累计编号与累计 token 不做 | 累计值随翻页漂移、未归属组无 run 上下文，UI 层累计会制造错误线索，违背「只呈现事实」 |
| 9 | VO 增量兼容面 | JSON 自然带新字段；CSV 只追加 `provider` 一列 | 提案「新字段增量扩展」；`startedAtMs`/`llmCallId` 是 epoch ms 与主键，对人类复盘无意义 |
| 10 | 抽屉内容 | 工具抽屉三个 tab（参数 / 结果 / 计时与元信息）；轮次抽屉 = 完整元信息 + token 明细 + 本轮工具清单（可跳转） | 轮次没有参数/结果，其价值全在元信息；工具清单让「这轮发了哪些工具」可继续下钻，不必回列表 |
| 11 | 空态与降级 | 找不到记录返回空态 VO（200），前端提示「记录不存在或已删除」；参数/结果非法 JSON 按原样展示；`firstTokenMs` null 或异常时解码/吞吐显示「—」 | 轨迹是排障视图，静默忽略会让用户以为按钮坏了；原样展示保证原文可复制 |
| 12 | 交付边界 | 代码 + 测试 + CHANGELOG 小节 + mao-cli desktop.md 同步；admin / android / agent-cli 不动 | AGENTS.md 硬性约定；提案 P1 边界 |

## 9. 测试要点

- **VO 增量**：`startedAtMs` = `Date.parse(createdAt) − durationMs`；`createdAt` 或 `durationMs` 缺失 → null；`provider` 与 `llm_call.provider` 一致；`llmCallId` = 行 id；历史秒级行（`2026-10-01 10:00:00`）换算不 NaN。
- **墙钟回归**：`wallClockMs` 行为与改动前一致（`estimatedStartMs` 复用不改语义）。
- **条带**：并行工具色条 x 区间互相重叠（不相加）；助手轮次两段宽度和 = 总宽；`firstTokenMs` 为 null 时单段；`startedAtMs` 为 null 的节点不画色条但仍在 `runTimeNodes` 里；`runTimeWindow` 全 null 时组件不渲染；单点窗口（`startMs === endMs`）不除零。
- **定位**：点色条 → run 展开 + 目标行滚动 + 高亮 class 后移除；行锚点 id 含 sessionId。
- **解码 / 吞吐**：`firstTokenMs` 为 null →「—」；`firstTokenMs > durationMs` →「—」（不出负数）；解码 0 → 吞吐「—」；`completionTokens` 为 0 →「—」。
- **下钻 API**：会话归属校验（他人会话拒绝）；`tool_call_id` 不存在 → 空态 VO；`llm_call` 的 `sessionId` 与会话不符 → 空态 VO；参数 / 结果与 `message` 表原文一致；TOOL 消息 `metadata` 的审批标记带出；`llm_call` 配不上时 `call` 为 null 而非抛错。
- **抽屉**：打开时发一次请求；同一 key 二次打开不重复请求；切会话不清空已缓存但 key 分桶不串；空态 VO 时显示提示而非空白；`Esc` / 遮罩 / × 三种关闭都生效。
- **导出**：CSV 表头含 `provider` 且在 `模型` 之后；模型行填 provider、工具行留空；JSON 结构与接口一致（含新字段）。
- **回归**：导出 JSON / CSV 既有列与口径不变；慢 / 贵阈值、编辑前分段、未挂到轮、执行中卡片、终态重拉行为不变（跑既有 `run-trace-panel-session.test.ts` 与 `trace-token.bugcheck.test.ts` 全绿）。
