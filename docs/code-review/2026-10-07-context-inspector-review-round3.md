# 上下文透视与手动治理（Context Inspector）代码审查 — Round 3

- 日期：2026-10-07
- 范围：分支 `feat/context-inspector`（基线 `0e40eff3`，功能提交 `b9c37606`），技术方案 `docs/plan/2026-10-06-context-inspector-technical-design.md` §5/§8/§11
- 目标：复核 BUG-1 / BUG-2 两处修复有无回归；对前两 round 尚未被失败用例覆盖的增量做新鲜功能逻辑扫描
- 结论：**未发现新的运行时功能逻辑 bug**；发现 **1 条由本需求提交的测试文件引入的构建中断（vue-tsc）**（非运行时逻辑，严重级别：一般/构建）

---

## 一、两处前序修复的回归判定：无回归

### BUG-1（空闲手动压缩事件被陈旧执行帧门吞掉）——判定：修复正确，无回归

`desktop/src/composables/useStreamWS.ts:85` 的 sentinel 放行：
```ts
if (typeof data?.executionId === 'string' && data.executionId.startsWith('manual_compact_')) {
  return false
}
```

- 该分支置于 `isStaleExecution` 顶部，`manual_compact_*` 前缀只可能由后端 `handleCompactNow` 空闲路径的合成 listener 产生（真实执行 id 为 `randomUUID()`/数字，永不含该前缀），放行语义正确。
- **安全短路验证**：`executionId` 为 `undefined` 或数字时，`typeof … === 'string'` 为 false → 落到常规陈旧门（`suppressedStreamSessions` / `activeExecutionIds` / `cancelled` 判定），不会误放行残留帧。
- 后端合成 listener 构造时传入 `executionId = manual_compact_${Date.now()}`，其 `send()` 给每一帧附带该 id（`ws-streaming-event-listener.ts:260`），故 compaction_start/end/marker、context_window 全批经 sentinel 放行，`isCompacting` 点亮与水位刷新验收成立。
- compaction_result / compaction_queued **不在** `STREAM_EVENT_TYPES`（`useStreamWS.ts:101-106`），天然不经门控（`useStreamWS.ts:566`）。

**回归测试**：`desktop/src/composables/idleManualCompactionEvents.test.ts`（含"对照：真实执行残留帧仍被丢弃"）；另临时复现用例验证：数字 executionId、缺失 executionId、非 sentinel 的 compaction_start 三种残留/异型帧在 suppressed 会话下仍被正确丢弃（均通过，用例证伪失败已丢弃）。

### BUG-2（空闲压缩失败经通用 error 误标整条会话 FAILED）——判定：修复正确，无回归

- 后端 `streaming-ws-handler.ts` 两处失败回执（catch 分支 + `compactionSignalBus` 缺失分支）均改为 `wsEvent('compaction_result', …, { compacted:false, failed:true, message, … })`，不再发通用 `error`（`error` 在 `useStreamWS.ts:1113` 会 `updateSessionPhase(…,'FAILED')`）。
- **signalBus 缺失分支语义复核**：运行中但 bus 不可用属防御分支（生产 `create-app.ts:1147` 恒注入 bus），现回 `compaction_result{failed}` → 前端仅 `ElMessage.error` 提示、会话态不变，语义正确（此前 `error` 会误标 FAILED）。
- **成功路径与"无需整理"路径互不污染**（`useStreamWS.ts:754-760`）：`failed` → error；`compacted===false`（无 failed）→ info「无需整理」；否则 → success「已整理上下文」。空闲路径成功回执 `{compacted}` 取自 `orchestrator.compact` 返回值（无可压缩消息时为 false）。
- 刻意不在前端 `case 'error'` 加 sentinel 守卫属合理：属主会话的压缩失败已不再产生 error 帧；`requireOwnedSession` 的 error 只在"越权/会话不存在"时发出，属主前端不订阅他人会话，不会到达正常视图。

**回归测试**：`backend-ts/src/session/ws/streaming-ws-handler.spec.ts`（"失败经 compaction_result{failed}、不发 error"）；`idleManualCompactionEvents.test.ts`（failed 不标 FAILED）；另临时复现三态提示互斥（success/info/error 各只触发一条、均不改会话态）——通过，已丢弃。

---

## 二、增量新鲜扫描：功能逻辑正确（无 bug）

| 增量点 | 结论 |
|---|---|
| buildSystemPrompt 分节重构 | join 后与重构前逐字节等价（空节跳过≡追加空串），`prompt-engine.spec.ts` 快照锚定，后端全绿 |
| manifest memoryIds/handoff/estimatedWindowTokens | memoryIds 取 `context.memories.id`（listForInjection 透传 id、bullet 文本不变）；handoff 以 `context.sessionSummary` 判定，避免首消息前缀误判；messages 节以最终 `normalized` 请求扣除 system。handoff 与 messages 节 token 存在设计内的重叠计数（§5.2 明确如此拆分展示，且有口径 tooltip），属展示口径非缺陷 |
| loadMemories 短路 | `boolish(session.memoryInjectionDisabled)===true` 才短路；`boolish(0)=false`（`deps.ts:306`）不误伤默认开启；Db 经 `toCamel` 映射 `memory_injection_disabled`→列（`db.ts` query→`toCamelList`），列真实装载 |
| 记忆开关全链路 | V135 迁移；VO `memoryInjectionDisabled: session.memoryInjectionDisabled===1`；PATCH `!=null` 判空（false 亦下发写 0）；`updateMemoryInjectionDisabled`→`updateFields`→`toSnakeRow` 落列；`normalizeSession` 以 `{...s}` 透传；生效时机"下一次执行"符合 §5.1 |
| AgentLoop 手动信号 | `consumeManualCompaction` 置于 `midLoopAllowed` 门外（决策 6/12，enabled=false 不关手动）；工具轮边界 + 纯文本收尾双消费；`preparedRequest` 重建；水位 `onContextWindow` 回推；双向清理：`execute` 启动 `bus.clear`（丢弃陈旧信号）+ finally `bus.clear`（未消费信号不残留），`agent-loop.spec.ts` 四条用例覆盖 |
| orchestrator triggerMode 补参 | 既有 request_start/mid_loop 两调用点显式补参、默认值向后兼容；manual 两处显式 `'manual'` + force=true |
| 压缩失败 isCompacting 卡死排查 | `compactionService.compactSession` 的 `onCompactionStart`（L128）之后全包在 try 内，catch 必发 `onCompactionEnd`（L154）再 rethrow；阈值 overflow（L125）在 start 之前抛，不成对缺失。空闲手动路径异常经 handleCompactNow catch→compaction_result{failed}，前端不会卡在"正在整理" |
| read_file 顶层 truncated | 截断分支 `{content,total_lines,truncated:true}`、正常分支不含 truncated |
| processToolResult 与 approvalMark 共存 | `mergeResultTruncated(mergeApprovalMark(meta,mark),flag)` 叠加不互覆；非 JSON 静默跳过 |
| 截断双通道 | 实时 `meta.resultTruncated`→ws `result_truncated`（`meta?.resultTruncated===true`）；历史 `metadataJson.resultTruncated`→`extractResultTruncatedFromMetadata`；`mapApiMessagesToChat` 两轮合并均落 `call.resultTruncated`；`messages.ts` updateToolCallResult `result_truncated`；ToolCallCard 徽标 |
| `GET /v1/sessions/:id/compaction` | `requireSessionOwner` 属主、`findBySessionId` 只读现值不触发校验删除、字段与 SessionCompaction 类型一致、无记录 data=null |
| TaskInspector 上下文页签 | 切会话 watch 复位 summary/snippet 态；异步响应以 `String(props.sessionId)===String(sid)` 防迟到覆盖；记忆 chip 本地匹配失败回退 `记忆 #id`；snippet/摘要懒加载 `memoriesLoading`/`summaryLoading`/`summaryLoaded` 去重与复位自洽 |

**phantom executionId 观察（判良性，不上报为 bug）**：空闲压缩合成 listener 在构造时 `registry.setSessionExecution(会话,'manual_compact_*')`，`dispose()` 与 `handleCompactNow` finally 均未调 `clearSessionExecution`（真实执行由 `task-terminal.service.ts:99` 清理）。残留 id 会经订阅回放的 `session_snapshot{executionId}` 触达前端 `setActiveExecution`，但对 COMPLETED 空闲会话，前端随即 `clearActiveExecution` 复位回 suppressed（`useStreamWS.ts:920`），下一轮真实执行的 RUNNING 帧再以真实 id 覆盖。已用复现用例验证"phantom 快照后紧随的真实执行 content_delta 仍正常渲染"——通过，无用户可见功能损害，故不列为缺陷（建议后续在合成 listener 结束处对称清理，属卫生项）。

---

## 三、发现的新问题

### BUG-3（一般/构建）本需求提交的测试文件使 desktop `npm run build` / CI 失败

- 文件：`desktop/src/components/task/task-inspector-context-race.test.ts`（随 `b9c37606` 提交，round 2 引入）
- 证据（严重级别：阻断构建）：
  - `desktop/package.json` build = `vue-tsc -b && vite build`；
  - `tsconfig.app.json` `include: ["src/**/*.ts", …]` **无 exclude** → `.test.ts` 纳入类型检查（同目录其余约 20 个 `.test.ts` 均类型干净，仅此文件报错，反证 baseline 可构建、本文件系新引入破坏）；
  - `npx vue-tsc -b --force` 退出码 2，报错：
    - `task-inspector-context-race.test.ts(82,59): error TS2769: No overload matches this call.`（ElTooltip mock 的 `h('div', this.$slots.default?.() ?? null)`）
    - `task-inspector-context-race.test.ts(100,14/45): error TS2339: Property 'errors' does not exist on type 'CodegenResult'`（`compile()` 返回类型无 `errors`）
    - `task-inspector-context-race.test.ts(182,40): error TS2345: … 自定义 nodeOps stub 不匹配 `RendererOptions<…>`
- 复现推理：`vue-tsc -b` 非零退出 → `&&` 短路 `vite build` 不执行 → `npm run build` 失败；CI 的 "desktop build" 步骤同理失败，阻断前端产物发布与合入。运行时不受影响（`npx vitest run` 用 esbuild 仅转译、不类型检查，310 用例全过），但阻塞构建/发布流水线。
- 修复方向（择一，不改生产代码逻辑）：
  1. 修正测试类型：ElTooltip mock 用 `defineComponent({ setup(_, {slots}) { return () => h('div', slots.default?.()) } })`；`compile()` 结果对 `errors` 用 `(compiled as {errors?: unknown[]})` 收窄；`createRenderer(ops)` 给 `ops` 补 `RendererOptions` 泛型或用 `as never`；
  2. 或将 `*.test.ts` 从 `tsconfig.app.json` 类型检查图中排除（`exclude: ["src/**/*.test.ts"]`）并交由独立 `tsconfig.vitest.json`，同时确认 baseline 其余测试文件本就该走该通道。

> 说明：本条为构建/CI 缺陷、非运行时功能逻辑 bug；按"发现新的真实 bug 则出报告"的口径登记，供决策是否纳入 P3 收尾或后续单独小修。

---

## 四、验证测试清单（本轮实际执行）

- `cd backend-ts && npm test` → Test Files 251 passed | 1 skipped；Tests 2834 passed | 13 skipped（含 `streaming-ws-handler.spec.ts`、`agent-loop.spec.ts`、`harness-service.spec.ts`、`prompt-engine.spec.ts`、`compaction-signal-bus.spec.ts`、`session.routes.spec.ts`、`session-extra.spec.ts`、`ws-streaming-event-listener.spec.ts`、`file-tools.spec.ts`）
- `cd desktop && npx vitest run` → Test Files 27 passed；Tests 310 passed（含 `idleManualCompactionEvents.test.ts`、`task-inspector-context-race.test.ts`、`chatMessage.test.ts`）
- `cd desktop && npx vue-tsc -b` → 退出 2，错误仅位于 `task-inspector-context-race.test.ts`（BUG-3）；生产源码无类型错误
- 临时复现用例（已跑出并通过、证伪"新 bug"假设后按要求丢弃）：sentinel 非字符串/缺失 executionId 安全短路、compaction_result 三态互斥、phantom 快照后真实执行仍渲染

## 五、总判定

- BUG-1 / BUG-2 两处修复：功能正确，无回归。
- 需求增量运行时功能逻辑：未发现新 bug。
- 新发现 1 条：BUG-3，测试文件引入的 `vue-tsc` 构建中断（构建/CI 面，非运行时逻辑）。
