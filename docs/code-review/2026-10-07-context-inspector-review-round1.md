# 上下文透视与手动治理（Context Inspector，P1+P2+P3）代码审查 — 第 1 轮

- **日期**：2026-07-30
- **工作区**：`/Users/yangjiayi/AiProjects/mao/.worktrees/context-inspector`，分支 `feat/context-inspector`（基线 `0e40eff3`）
- **基线**：git 工作区未提交改动（`git status`：46 modified + 3 untracked）。核心对象：
  - 后端：`prompt-engine.ts`、`context-manifest.ts`（新）、`agent-loop.ts`、`harness-service.ts`、`compaction-service.ts`、`compaction-signal-bus.ts`（新）、`session-compaction-orchestrator.ts`、`context-manager.ts`、`composite/agent-event-listener.ts`、`streaming-ws-handler.ts`、`ws-streaming-event-listener.ts`、`read-file-tool.ts`、`tool-result.ts`、`memory.service.ts`/`types.ts`、`session.routes.ts`/`session.service.ts`/`session-vo.ts`/`types.ts`、`create-app.ts`、`V135__session_memory_injection_disabled.sql`
  - 桌面：`TaskInspector.vue`、`useStreamWS.ts`、`types/chat.ts`、`stores/session/{messages,types}.ts`、`utils/chatMessage.ts`、`components/chat/{ToolCallCard,CompactionMarker}.vue`、`api/index.ts`
- **审查方式**：只读审查业务代码，**未修改任何生产/业务代码**，未部署、未连环境。为验证疑似缺陷，新建了独立验证用测试文件（见第 4 节），跑出**因该缺陷而失败**的用例后方计入报告；不能复现的候选按"避免误报"原则丢弃，仅在附录留痕。
- **背景参考**（非审查对象）：`docs/plan/2026-10-06-context-inspector-technical-design.md`（尤其 §5 详细设计、§8 风险、§11 验收）。

## 1. 总体结论

- **基线全绿**：`cd backend-ts && npm test` → `Test Files 251 passed | 1 skipped (252)`、`Tests 2832 passed | 13 skipped (2845)`、`npm run build` exit 0；`cd desktop && npx vitest run` → `Test Files 25 passed (25)`、`Tests 303 passed (303)`、`npx vue-tsc -b` exit 0。本次新增的 spec（prompt-engine manifest、agent-loop 手动/截断、harness-service requestCompaction、ws-handler compact_now、ws-listener manifest/result_truncated、session compaction 端点、file-tools truncated、chatMessage resultTruncated）均通过。
- **确认 1 个可复现功能缺陷（BUG-1，严重度高）**：**空闲（会话不在本连接跑过任务后再点）手动压缩 `compact_now` 的合成 listener 事件（`compaction_start` / `compaction_end` / `compaction_marker` / `context_window`）在桌面端被"陈旧执行帧"门静默吞掉**，直接违反技术方案 §11.3 与决策 11（"UI 不失明、水位下降、消息区分隔线、过程事件实时可见"）。等价地，运行中路径（真实执行 listener，executionId=active）不受影响，P1 manifest 在正常执行中也正常下发。
- 其余高风险面（见第 3 节）逐项复核未发现可确证的功能 bug；两处口径/健壮性观察列入附录，未计入 bug。

## 2. 问题列表

### BUG-1【高】空闲手动压缩的合成事件被前端陈旧执行帧门吞掉，过程不可见、水位不刷新、无分隔线

**位置**

- 触发点（前端过滤门）：`desktop/src/composables/useStreamWS.ts:558`
  ```ts
  if (sessionId && type !== 'session_already_running' && STREAM_EVENT_TYPES.has(type) && isStaleExecution(sessionId, data)) {
    return // 丢弃
  }
  ```
- 判定逻辑：`desktop/src/composables/useStreamWS.ts:79-91`（`isStaleExecution`：`suppressedStreamSessions.has(sessionId)` 直接返回 true）
- 置位来源：`desktop/src/composables/useStreamWS.ts:64-77`（`clearActiveExecution` 会 `suppressedStreamSessions.add(sessionId)`），而 `clearActiveExecution` 在任务终态 `COMPLETED/CANCELLED/FAILED` 时被调用：`useStreamWS.ts:684-686`
- 被过滤的事件类型：`desktop/src/composables/useStreamWS.ts:96`（`compaction_start` / `compaction_end` / `compaction_marker` / `context_window` 均在 `STREAM_EVENT_TYPES` 内）
- 后端合成事件携带全新 executionId：`backend-ts/src/session/ws/ws-streaming-event-listener.ts:259`（`send(...)` 统一附带 `executionId: this.executionId`），空闲手动压缩的 `executionId = manual_compact_<ts>`：`backend-ts/src/session/ws/streaming-ws-handler.ts`（`handleCompactNow`，约 1447-1462 行 `new WsStreamingEventListener(..., executionId=manual_compact_<ts>, ...)`）

**复现推理**

1. 同一 WS 连接内先正常跑完一轮任务：后端发 `session_status` `phase=RUNNING`（前端 `setActiveExecution`）→ 终态 `phase=COMPLETED`（`useStreamWS.ts:684`）→ `clearActiveExecution` → 该会话进入 `suppressedStreamSessions`，且 `activeExecutionIds` 被删除。
2. 用户随后在空闲态点「立即整理上下文」→ 后端 `handleCompactNow` 空闲路径合成一个执行级 listener（决策 11），以 `executionId=manual_compact_<ts>` 下发 `compaction_start` / `context_window` / `compaction_end` / `compaction_marker`。
3. 这些事件是"压缩全程唯一驱动 UI 的通道"，**但没有任何 `session_status RUNNING` 会把这个新的 `manual_compact_*` 登记为 active**（空闲压缩不经 `submitExecution`，不产生 RUNNING 帧）。于是前端 `isStaleExecution` 命中 `suppressedStreamSessions.has(sessionId)===true`（会话此前跑过并被 clear 过），或 `active` 为上一执行且 `manual_compact_*!==active` → 判定陈旧 → 整帧丢弃。
4. 结果：`compaction_start` 不落 `setCompacting(true)`（按钮不显示"正在整理上下文…"）、`context_window` 不落 `setContextWindow`（水位不刷新、manifest 不更新）、`compaction_marker` 不落 `addCompactionEvent`（消息区无"手动整理上下文"分隔线）。只有 `compaction_result`/`compaction_queued`（不在 `STREAM_EVENT_TYPES`，豁免过滤）弹一条 toast——与"过程实时可见 + 水位下降 + 分隔线"的 §11.3 验收不符。

这是"手动压缩最典型的使用时序"（跑完任务→上下文变长→点整理），因此影响面大。仅"全新连接、本连接尚未跑过任何任务"时手动压缩事件才可见（对照用例见第 4 节）。附带症状：因 `isCompacting` 无法被事件点亮，`TaskInspector.handleCompactNow` 里 `:disabled="isCompacting"` 守卫失效，800ms 去抖后二次点击会走"运行中"分支往 `CompactionSignalBus` 置一个无 loop 消费的信号（虽在下一次执行启动被双向清理丢弃、不致误压缩，但用户第二次请求静默落空）。

**验证测试（已写好并跑过，因该 bug 而失败）**

- 文件：`desktop/src/composables/__review__idle-compact-events.test.ts`
- 命令与结果：
  ```
  cd desktop && npx vitest run src/composables/__review__idle-compact-events.test.ts
  × 上一轮 COMPLETED 后空闲手动压缩的 compaction_start 应驱动「正在整理」态
      AssertionError: expected false to be true
  × 上一轮 COMPLETED 后手动压缩的 context_window 应刷新水位
      AssertionError: expected undefined to be 1234
  ✓ 对照：本连接从未运行过任务时，空闲手动压缩事件应正常进入 store
  Tests  2 failed | 1 passed (3)
  ```
  对照用例证明：同一 `compaction_start`/`context_window` 帧在"本连接未跑过任务"（`suppressed` 空、`active` 空）时能正常进入 store，故失败确由陈旧帧过滤门造成，而非用例脚手架/取值方式写错。

**修复方向建议（未改动生产代码）**

- 首选：让空闲手动压缩的合成事件豁免陈旧帧过滤——后端在 `handleCompactNow` 空闲路径对 `compaction_*` / `context_window` 使用当前活动执行 id（若无可视为 `null` 下发），或前端为"会话无 active 执行时携带 `manual_compact_*` 的 `compaction_*`/`context_window`"放行。
- 备选：前端在收到 `compaction_queued`/`compaction_result` 或手动压缩回执后，对该会话临时解除 `suppressedStreamSessions`（类似 `setActiveExecution` 的清位），使随后的过程事件不被丢弃。
- 无论哪种，需保证：`isCompacting` 能被空闲手动压缩过程事件点亮（`TaskInspector` 按钮"正在整理上下文…"态与 `:disabled` 守卫随之恢复），并避免去抖窗口内二次点击置入无人消费的 `CompactionSignalBus` 信号。

## 3. 已复核、未发现可确证功能 bug 的高风险面

- **① buildSystemPrompt 分节 join 逐字节等价**：`prompt-engine.ts:221-303` 各节 push 顺序与重构前 `sb +=` 追加顺序完全一致（system-prompt → experiences → memories → environment(embed 分支) → current-date → tools-usage/incoming → skills → task-mgmt → subagent → weixin-media → embed → workspace-rules）；空节"跳过 push"与原"`sb += ''`"等价；`longTermMemoriesHint`/`currentDateHint`/`incomingFileHint`/`workspaceRules` 空返回时两侧均不产生文本。既有 13 个通道组合用例（普通/embed/微信/LOCAL/CLOUD、memories/experiences 有无、AGENTS.md 200 行截断）全绿。
- **② messages 节 / handoff 节来源**：`buildRequest` 传入 `buildContextManifest(context, sections, normalized)` 的是最终 `request.messages`（quick command 展开、媒体注入、`normalizeChatMessages` 之后），扣除 `role==='system'`，非组装前 `context.messages`；handoff 以 `context.sessionSummary` 驱动、token 取 `buildHandoffUserContent(summary)` 内核（与 `CompactionService.buildHandoffUserMessage` 同一函数，无复制漂移），未做前缀嗅探。
- **③ manifest 8KB 裁剪一致性**：`ws-streaming-event-listener.ts` `trimManifest` 仅裁剪 `memoryIds`，`sections` 原样保留；sections（≤15 条）+ ≤20 个 memoryIds 实际不可能超 8KB，裁剪/整体丢弃分支为防御；超限丢弃时 `estimated/actual` 水位字段照常下发。
- **④ 空闲压缩 claim 与判定无 await 竞态**：`handleCompactNow` 属主 `await` 之后，`hasExecutionClaim`→`executionClaims.add` 同拍完成（单线程无 await），claim 全程持有至 `finally` 释放；`send_message` 走 `executionClaims.has`→`session_already_running` 拒绝（用例 `空闲路径：先占 claim 再动作…` 断言 `claimDuringCompaction===true`、结束后 `hasExecutionClaim===false`）；合成 listener `finally dispose()`；云 MCP 成功/失败路径均在 `requestCompaction` 的 `finally` 里 `closeBoundCloudMcp`（两条 harness-service 用例覆盖）。
- **⑤ SignalBus 双向清理与消费点位置**：`agent-loop.ts:164` 执行启动 `bus.clear`（丢弃陈旧信号）、`:524` finally 再 `bus.clear`；`:470-490` 消费点在 `midLoopAllowed`（`:491`）**之前**、门槛之外，前提仅 `sessionId/persistenceCallback/loopConfig` 齐备即 `consume`，与决策 6"enabled=false 不禁止手动"一致（用例 `手动信号在工具轮边界执行压缩，即使 enabled=false` 通过）。
- **⑥ triggerMode 显式传参无回归**：`session-compaction-orchestrator.ts:43` 默认 `compactCurrentTurn?'mid_loop':'request_start'` 向后兼容；既有两处调用点分别补 `'request_start'`（harness-service L425）/`'mid_loop'`（agent-loop L503），手动两处显式 `'manual'`（空闲 L476 处经 requestCompaction、loop 边界 L479）；`force` 参数贯穿 `context-manager.compactSession`→`compaction-service.compactSession`，仅旁路 `enabled` 门与阈值判定，交接/纠偏/前缀校验/CAS/归档/锚点重置复用不变（`compaction-service.ts:100,115`）。
- **⑦ 记忆开关 false/true 均可写 + 短路 + 生效口径**：PATCH `body.memoryInjectionDisabled != null` 对 `false` 亦触发写入（`session.routes.spec.ts` `含 false` 断言）；`updateMemoryInjectionDisabled` 落 `1/0`，`toSnakeRow` 映射 `memory_injection_disabled`；V135 列号紧接 V134、无冲突，`DEFAULT 0 NOT NULL`；`loadMemories` 用 `boolish(...)===true` 短路返回 null（`memoryInjectionDisabled=1` 用例：`memories===null` 且 `listForInjection` 未被调用），下一次执行生效、运行中不回灌（口径与决策 14 一致）。
- **⑧ 截断双通道**：`read_file` 截断分支返回顶层 `truncated:true`、正常返回不含该键（`file-tools.spec.ts` 两用例）；`processToolResult` 用 `sniffResultTruncated(rawResult)`（仅 JSON 对象顶层 `truncated===true`，非 JSON/数组/缺字段返回 false）；`mergeResultTruncated(mergeApprovalMark(...))` 与 approvalMark 共存互不覆盖（`agent-loop.spec.ts` 断言两者并存）；实时 meta（`onToolCallResult(..., { ...toolResultMeta, resultTruncated })`）与历史 metadata（`metadataJson`）双通道同源、口径一致；`ws-streaming-event-listener` 仅 `meta.resultTruncated===true` 时落 `result_truncated`，历史回放 `extractResultTruncatedFromMetadata` 解析 `resultTruncated`；`ToolCallCard.vue` 徽标消费 `toolCall.resultTruncated`。
- **⑨ TaskInspector 状态清理与渲染**：切会话 `watch(()=>props.sessionId)` 清 `compactionSummary/memorySnippetById/summaryPanel*`；`showContextTab` 门控 + `watch([showFileTreeTab,showGitTab])` 增加 `context` 落到不可见时回落 `workspace`；记忆 chip 按 id 本地匹配 `listMemories` content、缺内容回退 `记忆 #id`；摘要面板懒加载/空态；`context_window` prop 由 `TaskView.vue:44 :context-window="inspectorContextWindow"` 传入且含 `manifest`；`vue-tsc -b` 严格通过。

## 4. 本次审查新建的验证测试文件清单

- `desktop/src/composables/__review__idle-compact-events.test.ts`（BUG-1：2 个失败用例 + 1 个对照通过用例）

> 说明：该文件是"能复现 bug 的失败用例"。修好生产代码（使空闲手动压缩过程事件不被陈旧帧过滤门丢弃）后，前两个用例应变绿；若判定为误报则删除该文件。文件仅使用与既有 `useStreamWS.test.ts` 相同的 mock/脚手架，未改动任何业务代码。

## 5. 附录：不构成 bug 的观察（避免误报，未写失败用例）

- **manifest 的 handoff 双计**：`buildContextManifest` 的 `messages` 节取自最终 `request.messages`（含 `prependSessionSummary` 注入的交接 user 消息），同时又单列 `handoff` 节，交接文本 token 在构成条形列表里被两条节各计一次。技术方案 §5.2 明确要求"handoff 作为独立节"，且全部为字节估算口径、UI 已标"估算"与口径差 tooltip，属设计取舍而非缺陷，不计入 bug。
- **`trimManifest` 的"整体丢弃"**：仅当 sections 自身超 8KB 才发生，实际不可能触发；为防御分支，不影响正常功能。
- **`ws-streaming-event-listener.ts` 中 `isErrorResult` 声明行 `function isErrorResult(...): boolean {  if (result == null)...` 挤作一行**：纯排版，语法/类型均合法（`npm run build` 通过），无功能影响。
