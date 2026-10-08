# 上下文透视与手动治理（Context Inspector，P1+P2+P3）代码审查 — 第 2 轮

- **日期**：2026-10-07
- **工作区**：`/Users/yangjiayi/AiProjects/mao/.worktrees/context-inspector`，分支 `feat/context-inspector`（基线 `0e40eff3`）
- **审查对象**：git 工作区未提交改动（46 modified + 5 untracked），聚焦 round1 之后的增量与 round1 修复本身的回归验证
- **审查方式**：只读审查业务代码，**未改动任何生产/业务代码**。为验证疑似缺陷新建独立验证测试文件，跑出**因该缺陷而失败**的用例后方计入报告；无法用真实代码复现的候选按"避免误报"原则丢弃，仅在附录留痕。
- **背景参考**：`docs/plan/2026-10-06-context-inspector-technical-design.md`（§5 详细设计、§8 风险、§11 验收）、round1 报告 `docs/code-review/2026-10-07-context-inspector-review-round1.md`。

## 1. 总体结论

- **基线全绿**：`cd backend-ts && npm test` → `Test Files 251 passed | 1 skipped (252)`、`Tests 2832 passed | 13 skipped (2845)`；`cd desktop && npx vitest run` → `Test Files 26 passed (26)`、`Tests 307 passed (307)`（含 round1 回归 `idleManualCompactionEvents.test.ts` 4 例全绿）；`cd desktop && npx vue-tsc -b` exit 0。
- **round1 BUG-1 修复判定：方向正确、未见回归**。sentinel 前缀判定对 `undefined`/非字符串 `executionId` 安全（`typeof data?.executionId === 'string'` 前置守卫）；真实执行 id 为 `randomUUID()`（`streaming-ws-handler.ts:1189`），绝不以 `manual_compact_` 开头，运行中路径的真实 id 仍按原逻辑判陈旧/放行；`suppressedStreamSessions` 语义未被破坏（放行仅针对 sentinel 前缀，被取消执行的迟到残留帧仍被丢弃——对照用例通过）。
- **确认 1 个可复现功能缺陷（BUG-2，严重度中）**：**空闲手动压缩失败时，后端 `handleCompactNow` 复用通用 `error` 事件回传失败；round1 的 sentinel 放行使该 `error` 帧不再被陈旧帧门丢弃，直达前端 `case 'error'`，把一次"整理上下文"维护动作的失败误标成整条会话执行失败（phase→FAILED、挂"执行异常" banner）。** 修复本身放大了该缺陷的影响面（覆盖了"跑过任务后的空闲会话"这一最常见场景）。
- 其余高风险面（见第 3 节）逐项复核，未发现可用真实代码确证的功能 bug；两处无法证明的候选列入附录。

## 2. 问题列表

### BUG-2【中】空闲手动压缩失败被通用 error 事件误标为会话执行 FAILED

**位置**

- 触发点（后端失败回传复用 error 事件）：`backend-ts/src/session/ws/streaming-ws-handler.ts:1461-1462`
  ```ts
  } catch (e) {
    const message = e instanceof Error ? e.message : '手动整理上下文失败';
    this.deps.registry.send(userId, wsEvent('error', sessionId, { message, executionId })); // executionId = manual_compact_<ts>
  }
  ```
- 被放行（round1 修复）：`desktop/src/composables/useStreamWS.ts:85-87`（`isStaleExecution` 顶部对 `manual_compact_` 前缀无条件返回 false，未按事件类型收窄；`error` 亦在 `STREAM_EVENT_TYPES` 内）
- 误标发生（前端把 error 当执行失败）：`desktop/src/composables/useStreamWS.ts:1122-1123`
  ```ts
  sessionStore.setExecutionError(sessionId, message)      // 红色"执行异常" banner
  sessionStore.updateSessionPhase(sessionId, 'FAILED')    // 会话 phase 被改成执行失败
  ```

**复现推理**

1. 同一连接内先正常跑完一轮（RUNNING→COMPLETED）→ 会话空闲、phase=COMPLETED、进入 `suppressedStreamSessions`。
2. 空闲态点「立即整理上下文」→ `handleCompactNow` 空闲路径合成 listener、占 claim、调 `requestCompaction`。若压缩的 LLM 调用失败（模型不可用 / 网络 / 语义纠偏后仍失败抛错），异常传播到 `handleCompactNow` 的 catch。
3. catch 用通用 `error` 事件回传，`executionId = manual_compact_<ts>`；`error` 在 `STREAM_EVENT_TYPES` 内，`isStaleExecution` 因 sentinel 前缀无条件放行。
4. 前端 `case 'error'` 不区分"这是手动压缩失败"还是"agent 执行失败"，一律 `updateSessionPhase(FAILED)` + `setExecutionError(...)`。一条空闲会话因"整理上下文"这一维护动作失败，被误标为执行失败、侧栏/检查器显示红色失败态与"执行异常"横幅，直到下一次真实执行或刷新才自愈。
5. 失败过程事件本身是 `compaction_start`→（`compactSession` 的 catch 先发）`compaction_end`→`error`，故 `isCompacting` 能正常回落（非卡死），但 phase/banner 的误标无法回退。

注：全新连接（本连接未跑过任务）时，`error` 帧修复前后都不算陈旧，故也会误标；round1 修复把误标扩展到了"跑过任务的空闲会话"这一最常见时序。根因是 `compact_now` 失败复用了语义为"agent 执行失败"的通用 `error` 事件，手动压缩失败属维护操作失败，不应改变会话执行 phase。

**验证测试（已写好并跑过，因该 bug 而失败）**

- 文件：`desktop/src/composables/__review__idle-compact-error-state.test.ts`
- 命令与结果：
  ```
  cd desktop && npx vitest run src/composables/__review__idle-compact-error-state.test.ts
  × 上一轮 COMPLETED 后，手动压缩失败的 error 帧不应把会话 phase 改成 FAILED
      AssertionError: expected 'FAILED' to be 'COMPLETED'
      Expected: "COMPLETED"
      Received: "FAILED"
  Tests  1 failed (1)
  ```
  用例先以 RUNNING→COMPLETED 断言 phase 已是 COMPLETED（脚手架正确、可运行），再喂入"手动压缩失败"事件序列（`compaction_start`/`compaction_end`/带 `manual_compact_` executionId 的 `error`），断言 phase 仍应为 COMPLETED、执行错误应为 null。实际 phase 被翻成 FAILED，证明确由 `case 'error'` 处理手动压缩失败帧所致的误标，而非用例写错。

**修复方向建议（未改动生产代码，任选其一）**

- 首选：后端 `handleCompactNow` 空闲失败**不复用通用 `error` 事件**，改发一个专用/语义正确的回执（如 `compaction_result` 带 `ok:false`+`message`，或新增 `compaction_error`），前端以 toast 呈现、不改会话 phase。
- 备选：前端 `isStaleExecution` 的 sentinel 放行收窄到"仅 `compaction_*` / `context_window`"事件类型，不放行 `error`；并让 `case 'error'` 对 `manual_compact_*` 前缀的执行失败误标做防御（仅提示、不改 phase）。
- 无论哪种，均应保证：手动压缩失败只以轻量提示暴露，空闲会话的执行 phase 与"执行异常" banner 不被维护动作失败污染。

## 3. 已复核、未发现可确证功能 bug 的高风险增量点

- **round1 修复本身**：`isStaleExecution` sentinel 放行仅在 `executionId` 为字符串且以 `manual_compact_` 前缀命中时返回 false，`undefined`/数字/真实 UUID 一律走原逻辑；`compaction_queued`/`compaction_result` 不在 `STREAM_EVENT_TYPES`、本就豁免过滤；回归 `idleManualCompactionEvents.test.ts` 4 例（含真实执行迟到残留被丢弃的负向对照）全绿。放行未引入误放行"本该丢弃帧"的问题（唯一被放行却引发副作用的是 `error` 帧，即 BUG-2，其性质是失败回传通道选错，非陈旧误放行）。
- **requestCompaction 成功路径**：`buildContext(skipAutoCompact=true)` 走 else 分支照常 `preparedRequest=buildNormalRequest` 并同源写 `context.contextManifest`；`orchestrator.compact(..., 'manual', true)` triggerMode 显式、force 旁路阈值/enabled 门；成功与失败都经 `finally` `closeBoundCloudMcp`（buildContext 自身 catch 若已回收，二次 close 幂等无害）。harness-service 两条用例覆盖成功/失败回收与参数断言。
- **AgentLoop 手动信号消费与水位回推**：消费点置于 `midLoopAllowed` 门外（`agent-loop.ts:470-490`），前提 `sessionId/persistenceCallback/loopConfig` 齐备才 `consume`；`enabled=false` 仍可手动（用例通过）；压缩后 `preparedRequest` 重建、`resetContextAnchor` 回推 `onContextWindow(requestTokens,0,contextManifest)`（`session-compaction-orchestrator.ts:134`），manifest 为压缩后 buildRequest 的新鲜值；启动 `bus.clear` 丢弃陈旧信号、finally 再 `bus.clear`（三条用例覆盖陈旧信号不触发、未消费信号不残留）。
- **orchestrator 既有两处调用点补参无回归**：`request_start`（harness-service L425）/`mid_loop`（agent-loop L503）显式传入；默认参数 `compactCurrentTurn?'mid_loop':'request_start'` 向后兼容。
- **buildSystemPrompt 分节逐字节等价 + manifest**：各节 push 顺序与原 `sb+=` 追加顺序一致、空节跳过与追加空串等价；13 个通道组合既有用例全绿；`buildContextManifest` 的 messages 节取 `normalized`（最终请求）扣 system，handoff 由 `context.sessionSummary` 驱动、token 复用 `buildHandoffUserContent`（与压缩同一函数无漂移）。
- **P3 记忆开关全链路**：`SELECT *` 经 `db.ts` `toCamelList` 通用映射 `memory_injection_disabled→memoryInjectionDisabled`（读）；`updateFields` 经 `toSnakeRow` 写回（写）；PATCH `!= null` 对 `false` 亦写入（含 false 用例）；`boolish(0)===false`、`boolish(1)===true`、`undefined`→undefined，`loadMemories` 用 `=== true` 短路，默认 0 不误伤全局注入。
- **P3 截断双通道**：`read_file` 截断分支补顶层 `truncated:true`、正常分支不含该键（两用例）；`sniffResultTruncated` 仅认 JSON 对象顶层 `truncated===true`（数组/非 JSON/缺字段 false）；`mergeResultTruncated(mergeApprovalMark(...))` 与 approvalMark 及既有 key 共存不互覆；实时 meta 与历史 `metadataJson` 同源；`updateToolCallResult`（`data.result_truncated`）与历史回放 `extractResultTruncatedFromMetadata`（两轮 pendingToolResults 均透传 `resultTruncated`）一致；`ToolCallCard` 徽标消费 `toolCall.resultTruncated`。
- **memory.service listForInjection 透传 id**：仅在 hint 上补 `id: row.id`，bullet 文本与注入行为零变化。
- **TaskInspector 边界（可静态核对部分）**：切会话 watch 清 `compactionSummary/memorySnippetById/summaryPanel*`；`showContextTab` 门控 + `watch([showFileTreeTab,showGitTab])` 的 `context`→不可见回落 `workspace`；记忆 chip 本地匹配失败回退 `记忆 #id`；按钮 `:disabled="isCompacting || compactSubmitting"`、`handleCompactNow` 三重去抖守卫；manifest 空/冷启动空态有兜底文案；`vue-tsc -b` 严格通过。

## 4. 本次审查新建的验证测试文件清单

- `desktop/src/composables/__review__idle-compact-error-state.test.ts`（BUG-2：1 个失败用例）

> 说明：该文件为"能复现 bug 的失败用例"，仅复用既有 `idleManualCompactionEvents.test.ts` 同款 FakeWebSocket/Pinia 脚手架，未改动任何业务代码。修好生产代码（手动压缩失败不再把空闲会话 phase 改成 FAILED、不再挂执行异常 banner）后该用例应变绿；若判定为误报则删除该文件。

## 5. 附录：无法用真实代码确证、未计入 bug 的候选（避免误报）

- **摘要面板懒加载"迟到响应覆盖"竞态（`TaskInspector.vue` 内联逻辑）**：`loadCompactionSummary` 捕获 `sid` 后 `await getSessionCompaction(sid)`，成功/`finally` 赋值未按 `props.sessionId` 做代际校验。若请求在途时切换会话（`watch(props.sessionId)` 先把 `compactionSummary=null`、`summaryLoaded=false`），A 的迟到响应 resolve 会把 A 的摘要写回、`summaryLoaded` 置 true，导致 B 打开面板时因 `!summaryLoaded` 为假而**跳过加载、显示 A 的摘要**。逻辑上确为缺陷，但 `<script setup>` 内部 ref 未 `defineExpose`，本工作区 desktop 为 `environment:'node'` 且无 `@vue/test-utils`/`jsdom`，无法在不改动生产代码/工程配置的前提下挂载组件、构造真实代码失败用例，故按规则不确证、不计入 bug。建议：组件内加"请求发起时的 sessionId 令牌/自增 epoch"，`finally` 仅当令牌仍等于当前 `props.sessionId` 才提交 `compactionSummary/summaryLoaded`（同法可修 memory snippet 缓存跨会话残留）。
- **运行中手动压缩"已排队"但本轮无后续工具轮时静默落空**：信号在 loop 无下一工具轮边界时于 `finally` 被 `bus.clear` 丢弃（设计决策 12 明确"宁可丢弃也不残留给下次执行"），用户已见"将在本轮工具结束后整理上下文"提示却最终无压缩。属既有设计取舍，不计入 bug。
- **manifest 的 handoff 在 `messages`+`handoff` 双计**：最终 `request.messages` 含 `prependSessionSummary` 注入的交接 user 消息，`messages` 节已计入其 token，`handoff` 节又单列一次。§5.2 明确要求 handoff 独立成节、全为字节估算口径且 UI 标"估算"+口径差 tooltip，属设计取舍，与 round1 附录一致，不计入 bug。
- **`trimManifest` 整体丢弃分支**：manifest 仅携带各节 token 计数（≤15 条小对象 + ≤20 个 memoryIds），实际不可能超 8KB，触发不到；为防御分支，无功能影响。
