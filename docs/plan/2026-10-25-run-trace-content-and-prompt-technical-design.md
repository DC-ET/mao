# 运行轨迹消息内容与请求构成技术方案：轮次对话快照 + llm_call 请求构成采集

- 状态：待实施（2026-10-25 设计；决策记录见 §8）
- 日期：2026-10-25
- 提案来源：[docs/proposals/2026-10-22-run-trace-deep-dive.md](../proposals/2026-10-22-run-trace-deep-dive.md) §3.3（下钻扩展）与 §3.6（请求构成，本方案将其从「P2 待单独评审」转为具体设计）
- 前序方案：[docs/plan/2026-10-22-run-trace-deep-dive-technical-design.md](2026-10-22-run-trace-deep-dive-technical-design.md)（已实施，0.0.336/0.0.337；本方案只做增量，不改其口径）
- 外部参照：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) Trajectory 视图的记录检查器（消息原文 / 思考内容 / 系统提示词 / 工具目录）

## 1. 需求背景

深度下钻实施后的复盘确认了两个残留缺口（与外部参照逐项对比的结论）：

1. **消息内容看不到**。轨迹主列表的用户消息只有 80 字预览（`run-trace.service.ts` 的 `previewOf`），助手回复文本与思考内容在轨迹和抽屉里完全没有——轮次抽屉只有 llm_call 元信息加工具清单，想知道「这轮模型到底回了什么、想了什么」必须回聊天记录翻。而数据全在 `message` 表：`content` 与 `thinkingContent` 都落库，聊天侧本来就在渲染（`ThinkingBlock.vue`）。
2. **系统提示词看不到，且不是展示问题**。`prompt-engine.ts` 每轮从 Agent 人格、经验、长期记忆、技能、MCP / 自定义 HTTP 工具目录等分节现组装，组装结果直接进请求、不落库。唯一相近的视图是检查器「上下文详情」，但那是重算「下一轮」会发什么；「过去某一轮实际发了什么提示词」没有任何视图覆盖，因为历史快照根本不存在。

外部参照能同时看到两者，是因为它的 session 事件流把每条消息（含系统提示词节点、思考块、附件）作为持久事件记录，轨迹是纯客户端投影。mao 是服务端读模型，补齐路径不同：消息内容补「展示」，系统提示词补「存储」。

## 2. 需求描述

### 2.1 目标

1. **轮次抽屉加「回复」**：轮次抽屉展示本轮助手消息的正文（markdown 渲染，与聊天同源）与思考内容（折叠块）。正文 / 思考按需随 `call/:llmCallId` 详情一起返回，不进轨迹主 VO。
2. **用户消息抽屉**：run 摘要行的消息预览可点，打开该条用户消息的完整原文（多模态数组时合并文本分片并显示附件计数）。数据按 `messageId`（即 `runId`，run 锚点就是用户消息行）按需拉取。
3. **请求构成采集与展示**：`llm_call` 新增两列，记录每次调用实际发送的系统提示词原文（截断兜底）与工具名清单；抽屉新增「请求构成」tab 展示。历史行为 NULL，显示「未记录」，不猜。

### 2.2 非目标

| # | 不做的事 | 原因 |
|---|---|---|
| N1 | 分节构成 manifest 落库（各节 key / label / tokens） | 系统提示词原文自带 `## 分节头`（prompt-engine 的分节拼接是确定性的），需要构成统计时按头切分即可；省掉一条 harness → usage 的埋点管道 |
| N2 | 工具参数 schema 快照 | `tools_json` 只存工具名清单；schema 体积大且可从工具注册表重放，排障场景「这轮有哪些工具」用名字清单已够 |
| N3 | 提示词 diff（与上一轮 / 与 agent_prompt_versions 对比） | dsh 有「系统提示词已更新」diff，但那建立在它的事件流模型上；mao 的 diff 需要先有连续快照比对语义，列为后续可选 |
| N4 | 消息附件图片渲染 / 灯箱 | 用户消息抽屉显示文本分片合并 + 附件计数；图片渲染走聊天视图，抽屉是排障视图不重复做媒体展示 |
| N5 | assistant 回复的流式过程回放 | 抽屉只展示落库的最终消息；流式帧不经轨迹 |
| N6 | TOOL 消息内容进轮次抽屉 | 工具结果已经能通过「本轮工具」清单点进工具抽屉看到，轮次内再平铺一份是重复 |
| N7 | admin / android / mao-cli 功能改动 | 与前序方案同边界；mao-cli 仅同步文档 |
| N8 | 改轨迹主 VO 的既有字段语义、改导出结构 | 主列表与 JSON/CSV 导出继续不带正文；新字段只进按需详情 |

## 3. 范围界定

### 3.1 做什么

| 层 | 文件 / 模块 | 内容 |
|---|---|---|
| 迁移 | `backend-ts/db/migration/V171__llm_call_request_capture.sql` | `llm_call` 加 `system_prompt` MEDIUMTEXT NULL、`tools_json` JSON NULL（§5.1） |
| backend-ts | `src/harness/llm/chat-request.ts` | 无改动（采集只读 `ChatRequest`） |
| backend-ts | `src/usage/recording-llm-adapter.ts` | 采集函数 `captureSystemPrompt` / `captureToolNames`，`chat` / `stream` 的 `record` 调用透传（§5.2） |
| backend-ts | `src/usage/llm-call.service.ts` | `LlmCallRecordInput` 加 `systemPrompt` / `toolsJson`，`record()` 透传 |
| backend-ts | `src/usage/llm-call.repository.ts` | insert 两列；`LlmCallRow` 加两个可选字段 |
| backend-ts | `src/session/session-vo.ts` | `TraceCallMetaVO` 加 `systemPrompt` / `toolsJson`；`TraceCallRecordVO` 加 `messages`；新增 `TraceMessageRecordVO` |
| backend-ts | `src/session/run-trace-record.service.ts` | `toCallMeta` 透出两字段；`buildCallRecord` 扩展本轮助手消息；新增 `buildMessageRecord`（§5.3） |
| backend-ts | `src/session/session.repository.ts` | 新增 `selectAssistantMessagesBetween(sessionId, lowerInclusive, upperExclusive)` 与 `selectMessageById(sessionId, messageId)`（§5.3） |
| backend-ts | `src/session/session.routes.ts` | 新增 `GET /v1/sessions/:id/trace/records/message/:messageId`；既有两个端点不动 |
| desktop | `src/types/trace.ts` | 同步 `TraceCallMeta` 两字段、`TraceCallRecord.messages`、新增 `TraceMessageRecord` 与 drawer target `message` 分支 |
| desktop | `src/components/center/RunTraceRecordDrawer.vue` | 轮次抽屉改四 tab（回复 / 工具 / 计时与元信息 / 请求构成）；工具抽屉加「请求构成」tab；新增 message 分支（§5.6） |
| desktop | `src/components/center/RunTraceRecordReply.vue`（新） | 思考折叠块 + markdown 正文渲染（复用聊天侧 markdown 渲染链路） |
| desktop | `src/components/center/RunTraceCallPrompt.vue`（新） | 「请求构成」tab：系统提示词原文（截断提示）+ 工具名清单 |
| desktop | `src/components/center/RunTracePanel.vue` | run 摘要行消息预览可点（stopPropagation），打开消息抽屉 |
| 文档 | `CHANGELOG.md`、`skills/mao-cli/reference/desktop.md` | 发版小节 + 运行轨迹说明同步 |

### 3.2 实现约束

- `TraceRoundVO` / `TraceToolVO` / `TraceSideCallVO` 主 VO **零改动**——消息内容与请求构成只存在于按需详情 VO。
- `/trace` 主接口查询、归属口径、分页、时间条带全部不动。
- `agent_prompt_versions`（V104）机制不动：它管人格版本管理，与运行时采集正交（D4）。

## 4. 技术选型与关键决策

新增一张迁移（V171），其余零迁移。塑形结论：

| # | 决策 | 结论 |
|---|---|---|
| D1 | 系统提示词存全文而非版本引用 | `llm_call` 存 `system_prompt` 原文（截断兜底），不存 `prompt_version_id`（§8 决策 2） |
| D2 | 采集点在 RecordingLlmAdapter | 从 `ChatRequest.messages` 取 system 消息、`request.tools` 取工具名；不穿透 prompt-engine 内部状态（§8 决策 3） |
| D3 | 全部场景统一采集 | 不区分 scene，`RecordingLlmAdapter` 是所有调用的必经点；旁路调用（压缩 / 起草等）的提示词同样有排障价值（§8 决策 4） |
| D4 | 轮次回复随 call 详情返回 | `TraceCallRecordVO.messages` 承载本轮窗口内助手消息；不新增第四个端点（§8 决策 5） |
| D5 | 用户消息走独立端点 | run 锚点 id 即 `runId`，新增 `/trace/records/message/:messageId`；回复与用户消息的读取语义不同（窗口推导 vs 主键直查），不强行合并（§8 决策 6） |

技术选型：

- **回复渲染**：复用聊天侧 markdown 渲染链路（`useMarkdown` 同源配置），不引新库；思考内容用可折叠块（视觉对齐聊天 `ThinkingBlock` 的收窄版）。不渲染工具调用块与图片——排障视图看文本与结构，媒体与工具块回到各自的抽屉。
- **系统提示词展示**：`<pre>` 原样 + 自动换行切换（与参数 / 结果 tab 的「格式化 / 原样」同款交互），不做 markdown 渲染——提示词是模板文本，渲染反而破坏可读性。
- **存储列型**：`system_prompt` 用 MEDIUMTEXT（上限 16MB，应用层另有截断）；`tools_json` 用 JSON 列，与 `message.tool_calls` 的 JSON 列先例一致（JSON_CONTAINS 类校验已有先例）。

## 5. 详细设计

### 5.1 迁移（V171，当前最新 V170）

```sql
ALTER TABLE `llm_call`
    ADD COLUMN `system_prompt` MEDIUMTEXT NULL
        COMMENT '本轮请求的系统提示词原文（全部 system 消息按序 join；超上限截断并带标记）。NULL = 未记录（历史行 / 无 system 消息）' AFTER `error_message`,
    ADD COLUMN `tools_json` JSON NULL
        COMMENT '本轮请求的工具名清单（request.tools 顺序的 JSON 字符串数组）。NULL = 未记录（历史行 / 无工具）' AFTER `system_prompt`;
```

- 存量行不回填：NULL 在前端有明确空态（「该调用未记录请求构成（历史行）」）。
- 体积核算：典型系统提示词 10–30KB（人格 + 经验 + 环境 + 工具指引 + MCP / 自定义工具目录），agent 场景占绝大多数；压缩等旁路场景 system 消息很小（对话在 user / assistant 消息里，不在采集范围）。按日均 1 万次调用估 ≈ 150–300MB/月量级，属可接受的自托管工作台存储；截断上限是兜底而非常态（§5.2）。

### 5.2 采集点（backend-ts，`recording-llm-adapter.ts`）

`RecordingLlmAdapter` 是全部 LLM 调用（CLOUD 与 LOCAL 的 agent 循环、标题 / 压缩 / 起草等旁路）的必经包装层，`chat` 与 `stream` 的 `finally` 里本来就在调 `callService.record`，手里持有完整 `ChatRequest`：

```ts
/** 超长截断上限（字符）。MEDIUMTEXT 上限 16MB，这里是应用层兜底，防极端 MCP 目录撑爆行。 */
export const SYSTEM_PROMPT_CAPTURE_MAX_CHARS = 262_144;

/** 全部 role=system 消息按序 join；多模态内容（理论不存在）JSON 序列化兜底。 */
export function captureSystemPrompt(request: ChatRequest): string | null {
  const parts: string[] = [];
  for (const message of request.messages ?? []) {
    if (message.role !== 'system') continue;
    parts.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
  }
  if (parts.length === 0) return null;
  const joined = parts.join('\n\n');
  return joined.length > SYSTEM_PROMPT_CAPTURE_MAX_CHARS
    ? `${joined.slice(0, SYSTEM_PROMPT_CAPTURE_MAX_CHARS)}…[已截断，原长 ${joined.length} 字符]`
    : joined;
}

/** 工具名清单（OpenAI 形态 function.name），保序；无工具返回 null。 */
export function captureToolNames(request: ChatRequest): string | null {
  const names = (request.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === 'string' && name !== '');
  return names.length > 0 ? JSON.stringify(names) : null;
}
```

- 采集是纯读取，不改请求、不影响调用与缓存行为（prompt 前缀缓存的确定性由 prompt-engine 保证，采集不动它）。
- `chat` / `stream` 的 `record` 入参各加 `systemPrompt: captureSystemPrompt(request)`、`toolsJson: captureToolNames(request)`。
- `LlmCallRecordInput`（`llm-call.service.ts`）加两个可选字段，`record()` 透传给 `repo.insert`；`LlmCallRow` 加 `systemPrompt?: string | null`、`toolsJson?: string | null`（`selectById` 为全列查询，自然带出）。
- 不穿透 prompt-engine 的 `PromptSection[]`：分节文本已按 `## 标题` 拼进原文，需要构成统计时按头切分即可（N1）。

### 5.3 记录详情读模型扩展（backend-ts，`run-trace-record.service.ts`）

**`toCallMeta` 透出两字段**（工具抽屉与轮次抽屉共用 `TraceCallMetaVO`，请求构成在两处都可见）：

```ts
export interface TraceCallMetaVO {
  // ...既有字段不动
  /** 本轮系统提示词原文（截断带标记）；NULL = 未记录（历史行） */
  systemPrompt: string | null;
  /** 本轮工具名清单（JSON 字符串数组）；NULL = 未记录 */
  toolsJson: string | null;
}
```

**轮次对话快照**——`TraceCallRecordVO` 加 `messages`，复用 `findRoundTools` 的窗口推导（本轮调用结束时刻（含同刻）→ 下一轮 agent 调用结束时刻（排他）；最后一轮上界开放）：

```ts
export interface TraceCallRecordVO {
  call: TraceCallMetaVO | null;
  tools: Array<{ toolCallId: string; name: string; target: string | null }>;
  /** 本轮窗口内的助手消息（含 thinkingContent），按 id 升序；通常一条，崩溃恢复可能零条 */
  messages: Array<{
    messageId: number;
    content: string | null;
    thinkingContent: string | null;
    tokenCount: number | null;
    createdAt: string | null;
  }>;
}
```

窗口语义与 `findRoundTools` 完全一致（依据同一段注释：本轮助手消息在工具执行完之后落库，`created_at` 晚于本轮 `llm_call.created_at`，早于下一轮 agent 调用），差别只在取的行与列：

```ts
/** 窗口内助手消息（含正文与思考），id 升序。窗口上界缺失（最后一轮 / 时钟不可用）时上界开放。 */
selectAssistantMessagesBetween(
  sessionId: number,
  lowerCreatedAtInclusive: string | null,
  upperCreatedAtExclusive: string | null,
): Promise<Array<Pick<Message, 'id' | 'content' | 'thinkingContent' | 'tokenCount' | 'createdAt'>>>
```

- 时钟缺失退化：与 `findRoundTools` 同口径——下界缺失时不猜，返回空数组并在抽屉提示「该轮回复暂无法定位（时钟缺失）」；上界缺失开放（最后一轮被中断时回复仍可能落在窗外之后，开放上界能接住）。
- 崩溃恢复轮（调用已落库、回复未落库）→ `messages` 为空数组，抽屉显示「该轮回复未落库（崩溃恢复 / 中断）」，不出假数据。

**用户消息详情**——新端点对应的新方法：

```ts
export interface TraceMessageRecordVO {
  messageId: number;
  role: string;
  /** 原文；多模态数组时为 JSON 分片数组原样，前端合并文本分片 + 附件计数 */
  content: string | null;
  thinkingContent: string | null;
  tokenCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** 编辑重发的更新时刻；与 createdAt 相同视为未编辑 */
  edited: boolean;
}
```

`buildMessageRecord(sessionId, messageId)`：`messageRepo.selectMessageById(sessionId, messageId)`，行不存在或 `sessionId` 不符 → 空态 VO（`messageId` 带回、其余 null），与既有「视为不存在」口径一致。`edited = updatedAt != null && updatedAt !== createdAt`。

### 5.4 路由（backend-ts）

```ts
// run 轨迹消息详情（技术方案 2026-10-25 §5.3）。找不到 / 跨会话返回空态 VO（200），不抛 404。
app.get('/v1/sessions/:id/trace/records/message/:messageId', async (request, reply) => {
  const userId = requireUserId(request);
  const id = pathId(request);
  await requireSessionOwner(userId, id);
  return sendOk(reply, await deps.runTraceRecordService.buildMessageRecord(id, pathId(request, 'messageId')));
});
```

`messageId` 非正整数 → 空态 VO，与 `llmCallId` 同款钳制。既有 `tool` / `call` 两个端点不动。

### 5.5 前端类型（desktop，`types/trace.ts`）

```ts
export interface TraceCallMeta {
  // ...既有字段不动
  systemPrompt: string | null
  toolsJson: string | null
}

export interface TraceCallRecord {
  call: TraceCallMeta | null
  tools: Array<{ toolCallId: string; name: string; target: string | null }>
  messages: Array<{ messageId: number; content: string | null; thinkingContent: string | null; tokenCount: number | null; createdAt: string | null }>
}

export interface TraceMessageRecord { /* 与 TraceMessageRecordVO 对齐 */ }

export type TraceDrawerTarget =
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'call'; llmCallId: number }
  | { kind: 'message'; messageId: number }
```

抽屉缓存 key 追加 `message:${messageId}` 分支；store 的分桶与跨会话桶上限逻辑复用（0.0.337 已有桶上限，消息记录同受其管）。

### 5.6 抽屉扩展（desktop，`RunTraceRecordDrawer.vue`）

**轮次抽屉**从单页改四 tab：

1. `回复`（默认 tab）：`RunTraceRecordReply.vue`——`thinkingContent` 非空时顶部渲染折叠块（默认收起，标题「思考 N 字」）；`content` 用 markdown 渲染（与聊天同源渲染链路，DOMPurify 白名单既有约束不变）。`messages` 为空 → 「该轮回复未落库（崩溃恢复 / 中断）」或时钟缺失提示（区分两种空态，字段可判：`call == null` 与窗口推导失败的组合）。
2. `工具`：现有「本轮工具（N）」清单整段迁入，行点击跳工具抽屉。
3. `计时与元信息`：现有 `CallMetaTable` 原样。
4. `请求构成`：`RunTraceCallPrompt.vue`（与工具抽屉共用）。

**工具抽屉**加第五个 tab `请求构成`：配对 `call` 的 `systemPrompt` / `toolsJson`；`call == null` 时显示「未配对到模型调用记录」。

**`RunTraceCallPrompt.vue`**：上半是工具名 chips（`toolsJson` 解析失败按原样文本展示，不报错）；下半是系统提示词原文 `<pre>` + 自动换行切换 + 截断标记提示（原文尾部带 `…[已截断，原长 N 字符]` 时展示「已截断」徽标）。两者皆 NULL → 「该调用未记录请求构成（历史行）」。

**消息抽屉**（`kind: 'message'`）：单页。多模态数组时合并文本分片展示，非文本分片按类型计数（「图片 ×2」）；合法 JSON 时提供「格式化 / 原样」切换（复用 `RunTraceRecordJsonText`）；`edited` 时在头部标注「编辑于 HH:mm:ss」。标题「用户消息详情」。

**主面板入口**：run 摘要行的 `run-preview` span 加 click（`stopPropagation`，不触发卡片折叠）打开消息抽屉；光标与悬停提示（「查看完整消息」）。执行中临时卡片不加入口（临时态无消息行可查）。

### 5.7 兼容与导出

- 主 VO、`/trace` 接口、JSON 导出结构零改动；CSV 不加列（正文与提示词不进导出，与「导出 = 落库事实清单」定位一致）。
- `toolsJson` / `systemPrompt` 只随记录详情按需返回，单次响应最坏 ~256K 字符（截断上限内），一次抽屉打开一条调用行，可控。
- 抽屉缓存桶上限（0.0.337）覆盖新 key 分支，无需改策略。

## 6. 落地清单

按依赖顺序，每步可独立验证。

| # | 步骤 | 文件 | 验证 |
|---|---|---|---|
| 1 | V171 迁移 | `db/migration/V171__llm_call_request_capture.sql` | 本地起库 Flyway 执行；`llm_call` 列存在、存量行 NULL |
| 2 | 采集函数 + record 透传 | `recording-llm-adapter.ts`、`llm-call.service.ts`、`llm-call.repository.ts` | 扩 `recording-llm-adapter.spec.ts`：多 system 消息 join、无 system → null、截断标记、工具名提取（含缺 function 的条目跳过）；`llm-call.service.spec.ts` 透传断言 |
| 3 | `toCallMeta` / `buildCallRecord` 扩展 + 新 `buildMessageRecord` + repository 两方法 | `run-trace-record.service.ts`、`session.repository.ts` | 扩 `run-trace-record.service.spec.ts`：messages 窗口归属（含最后一轮开放上界、崩溃恢复空数组、时钟缺失空数组）、message 跨会话空态、edited 判定、`systemPrompt` / `toolsJson` 透出 |
| 4 | 路由 message 端点 | `session.routes.ts` | 扩 `session.routes.spec.ts`：归属拒绝、非法参数空态 |
| 5 | desktop types + 抽屉扩展 + 两个新组件 + 面板入口 | `types/trace.ts`、`RunTraceRecordDrawer.vue`、`RunTraceRecordReply.vue`、`RunTraceCallPrompt.vue`、`RunTracePanel.vue` | 扩 `run-trace-record-drawer.test.ts`：四 tab 切换、空态文案、chips 解析失败原样、截断徽标、消息抽屉多模态合并与编辑标注；`run-trace-panel-session.test.ts`：预览点击开抽屉且不折叠卡片 |
| 6 | `vue-tsc -b --force` + `npm run build`（desktop） | desktop | 类型与构建通过 |
| 7 | `npm test`（backend-ts） | backend-ts | 全量通过（含 V171 迁移后既有用例） |
| 8 | CHANGELOG + mao-cli 文档 | `CHANGELOG.md`、`skills/mao-cli/reference/desktop.md` | 小节归属正确（后端 / 前端） |

## 7. 风险与开放问题

- **存储增长**：`system_prompt` 按 agent 调用量线性增长（§5.1 估算 150–300MB/月 @ 日均 1 万调用）。缓解：截断上限兜底；开放问题——若实例量大，后续可加「仅保留最近 N 天 / 按 scene 采样」的清理策略（数据保留提案已否决，不主动重启，仅在容量成为问题时单独评估）。
- **采集与缓存行为**：采集只读请求，不改 `ChatRequest`，不影响前缀缓存键与确定性拼接。回归断言：`recording-llm-adapter.spec.ts` 现有用例全绿。
- **窗口推导的近似边界**：`messages` 复用工具窗口语义，理论上多助手消息（重试 / 补发）会全部进快照——这是期望行为（排障要看全）；崩溃恢复的空数组有空态文案，不出假数据。
- **系统提示词的敏感面**：含人格、经验、记忆内容，均属会话所属用户自己的数据，`requireSessionOwner` + `buildMessageRecord` 的会话校验双保险；不进导出、不进 admin。
- **截断标记的可读性**：截断发生在任意字符边界（UTF-8 安全——JS 字符串按码元切，代理对可能被切开产生孤立代理项）。缓解：切完 `slice` 后用 `String.fromCodePoint` 修正或直接容忍（展示层 `<pre>` 对孤立代理项不崩溃）；实施时以简单方案为先，测试覆盖含 emoji 的超长文本。
- **开放问题**：提示词 diff（N3）与分节统计（N1）是否排期，待本方案上线后按使用反馈评估。
- **开放问题**：`captureSystemPrompt` 对 `role` 大小写 / 变体（如 `developer`）不做兼容——适配器层已归一为 `system`；若未来协议适配引入新系统角色，采集函数需同步（写入 §5.2 注释提醒）。

## 8. 决策记录

| # | 决策点 | 结论 | 论证摘要 |
|---|---|---|---|
| 1 | 系统提示词存什么 | 全文（截断兜底），不存分节 manifest、不存 `prompt_version_id` | 提案 3.6 原设想 `prompt_version_id` 只覆盖人格——人格是分节里最不常变的部分，经验 / 记忆 / MCP 目录每轮都可能变，版本引用的信息量最低；manifest 又要新建 harness → usage 埋点管道。全文一次性回答「这轮发了什么」，`## 分节头` 天然可切分 |
| 2 | 采集点 | `RecordingLlmAdapter`（`ChatRequest` 读取），不动 prompt-engine | 它是全部调用的必经点、手里已有完整请求；prompt-engine 的分节是组装期概念，穿透它会引入跨层耦合。适配器归一化后的 system 消息即实际发送内容，比组装期快照更「事实」 |
| 3 | 采集范围 | 全部 scene 统一采集 | 分 scene 白名单会漏掉未来新增场景（三处同改清单又要加一项）；旁路调用的提示词同样有排障价值；存储增量集中在 agent 场景，旁路本身行数少 |
| 4 | 轮次回复的返回形状 | 随 `call/:llmCallId` 详情返回（`TraceCallRecordVO.messages`），不加第四个端点 | 回复与调用是同一次因果的两半，抽屉同屏看最顺；单独端点会让抽屉多一次串行请求，缓存 key 也要多一套 |
| 5 | 用户消息的返回形状 | 独立端点 `/trace/records/message/:messageId` | 用户消息的定位 key 是消息主键（= runId），与窗口推导语义不同；强行塞进 call 详情会让「编辑前」消息无处安放，且消息抽屉未来可服务任何消息行 |
| 6 | 回复渲染方式 | markdown 与聊天同源；思考折叠块；不做工具块 / 图片 | 排障看文本与结构；工具块与图片回到各自抽屉，避免抽屉内再造一个迷你聊天视图 |
| 7 | 请求构成放哪个 tab | 工具抽屉与轮次抽屉共用「请求构成」tab | 两处配对到的是同一行 llm_call；共用组件（`RunTraceCallPrompt.vue`）一处实现，口径一致 |
| 8 | 历史行 NULL 的空态 | 明确文案「该调用未记录请求构成（历史行）」，不猜、不回填 | 与「未挂到轮」同款「不猜」原则；回填既无数据来源也无必要 |
| 9 | 主 VO 与导出 | 主 VO 零改动；JSON 导出自然不带；CSV 不加列 | 正文与提示词是按需详情，进主 VO 违背 0.0.336 立下的防膨胀口径；导出定位是落库事实清单 |
| 10 | 交付边界 | 代码 + 测试 + CHANGELOG + mao-cli 文档同步；admin / android 不动 | AGENTS.md 硬性约定 |

## 9. 测试要点

- **采集**：单 / 多 system 消息 join 顺序；无 system → null；超长截断且尾带 `…[已截断，原长 N 字符]`；含 emoji 的超长文本不抛错；工具名提取跳过缺 `function.name` 的条目；无工具 → null；采集不改 `request`（引用与内容不变）。
- **落库**：`record()` 透传后 `llm_call.system_prompt` / `tools_json` 与采集值一致；既有字段与用例不受影响（全量回归）。
- **详情读模型**：`toCallMeta` 透出两字段；`buildCallRecord.messages` 窗口归属（首轮 / 中间轮 / 最后一轮开放上界 / 崩溃恢复空数组 / 时钟缺失空数组）；`buildMessageRecord` 会话归属（跨会话 → 空态）、`edited` 判定（`updatedAt === createdAt` → false）、多模态原文原样返回。
- **路由**：`messageId` 非正整数 → 空态 VO；他人会话拒绝；`tool` / `call` 既有端点回归。
- **抽屉**：轮次四 tab 切换与默认 tab；回复空态两种文案区分（未落库 vs 时钟缺失）；思考折叠默认收起；请求构成 tab 的 chips / 原样降级 / 截断徽标 / 历史行空态；消息抽屉多模态合并、附件计数、编辑标注、JSON 格式化切换；预览点击开抽屉且不触发卡片折叠；Esc / 遮罩 / × 关闭回归。
- **缓存**：`message:` key 进桶且受跨会话桶上限约束；同一 key 二次打开不重复请求。
- **回归**：`/trace` 主接口响应结构与既有桌面测试（`run-trace-panel-session.test.ts`、`trace-token.bugcheck.test.ts`）全绿；JSON / CSV 导出结构与列不变；时间条带行为不变。
