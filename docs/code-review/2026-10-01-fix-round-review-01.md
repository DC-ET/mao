# 修复轮代码评审（2026-10-01，工作区未提交变更）

- **日期**：2026-10-01
- **基线**：`main @ 3ef96473` + 工作区未提交改动（即 `docs/code-review/2026-10-01-logic-bug-review-01.md` 所报 BUG-1 ~ BUG-8 的修复轮）。所有行号以当前工作区源码实测核对。
- **范围**：本轮 diff 涉及的功能代码——`harness/core/agent-loop.ts`、`harness/delegate/background-subagent-manager.ts`、`harness/tool/impl/open-web-page-tool.ts`、`feishu/chat-files.ts` + `dingtalk/runtime.ts` + `create-app.ts` 调用点、`permission/*` + `user/*`、`session/ws/streaming-ws-handler.ts`。文档（CHANGELOG）、`task-index-panel.css`、`desktop/package*.json` 不在功能审查范围。
- **方法**：逐 hunk 静态审查 + 调用链回读（normizer/serializer/簿记生命周期/事务结构）+ 跑通 `npm run build`（exit 0）与 `npm test`。测试发现的 1 个失败经对拍确认为**既有 flaky、非本轮引入**（见附录 B）。

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 中 | harness/core（工具调用合并修复的二次缺口） | 「无 id、仅 index」的 tool call 被放行派发后始終没有 id：`MessageHistoryNormalizer` 把其 tool 结果从每一轮请求中剥掉，严格 OpenAI 兼容网关还会因 `tool_calls[].id` 缺失 400——恰恰命中该修复想支持的网关 |
| BUG-2 | 低 | session/ws（入口取消复查修复的收敛缺口） | 排队中被取消的执行走入口复查提前 `return`，跳过了 finally 的收敛职责：队列下一条不再被自动消费（停滞）、定时任务绑定泄漏后被下一次执行 stale 回写、部分会话资源清理被跳过 |
| BUG-3 | 低 | permission/user（守卫事务化修复的语义偏差） | `updateUserStatusWithAdminGuard` 对「启用/清空自己的状态」也一律抛 `CANNOT_DISABLE_SELF`：自助启用从成功变为被拒，且错误码语义错位 |

---

## BUG-1【中】无 id 的 tool call 放行后没有 id：后续请求被剥离 tool 结果，严格网关直接 400

**位置**

- 放行点：`backend-ts/src/harness/core/agent-loop.ts:641-646`（`mergeToolCall` 的 `else if (delta.id || delta.index != null)` 新分支，无 id 分片现在会 `existing.push(delta)` 进入派发队列）
- id 归一化：`backend-ts/src/harness/llm/json.ts:113-114`（`parseToolCalls` 把空 id 归一为 `undefined`），全链路无任何地方为缺失 id 的调用补 id
- 结果剥离：`backend-ts/src/harness/core/message-history-normalizer.ts:45,53,55-71`（`normalizeChatMessages`：`toolCallId` 为空/undefined 的 TOOL 消息不进 `deferredTools`，且所有 `role==='tool'` 消息先从输出中摘掉；assistant `toolCalls[i].id == null` 的条目直接 `continue`，不补占位）
- 触发时机：`backend-ts/src/harness/core/prompt-engine.ts:115`——**每一轮** `buildRequest` 都对全量消息过一遍上面的 normalizer
- 序列化：`backend-ts/src/harness/llm/json.ts:41`（`serializeToolCall`：`if (tc.id != null) out.id = tc.id`，无 id 则键整个省略）
- 内存态工具消息：`backend-ts/src/harness/core/agent-loop.ts:557,575`（`context.addToolResult(tc.id!, ...)`，`tc.id` 为 undefined）→ `agent-execution-context.ts:73-79` 产出 `{role:'tool', toolCallId: undefined}`

**代码事实**

```ts
// agent-loop.ts:641 —— 本轮修复：无 id、仅 index 的分片现在成为正式 tool call
} else if (delta.id || delta.index != null) {
  existing.push(delta);
  merged = delta;
}

// message-history-normalizer.ts:45 —— 空/undefined 的 toolCallId 进不了配对表
if (msg.role === 'tool' && msg.toolCallId != null && msg.toolCallId !== '') {
  deferredTools.set(msg.toolCallId, msg);
}
...
for (const msg of messages) {
  if (msg.role === 'tool') continue;            // :53 所有 tool 消息先摘掉
  normalized.push(msg);
  if (msg.role === 'assistant' && msg.toolCalls ...) {
    for (const toolCall of msg.toolCalls) {
      if (toolCall.id == null || toolCall.id === '') continue;   // :57 无 id 的调用不补占位、也找不到配对
      ...
    }
  }
}
```

**触发链**

1. 某 OpenAI 兼容网关只按 `index` 分片、从不回传 `id`（`agent-loop.ts:641` 修复的目标场景）；
2. 第 1 轮：工具调用被合并、派发、执行，结果在本轮对流给用户看到——一切正常；
3. 同一执行的第 2 轮请求（以及之后任何一次新执行/重试载入的历史）：`prompt-engine.ts:115` 的 `normalizeChatMessages` 把这些调用的 TOOL 消息（`toolCallId` 为空）**全部静默丢弃**， assistant 消息里只留下没有 `id` 的 `tool_calls`；
4. 发出去的请求形如 `{role:'assistant', tool_calls:[{type:'function', function:{...}}]}`（无 `id`）且没有任何对应 tool 结果：
   - 严格遵循 Chat Completions 规范的网关（`tool_calls[].id` 必填）→ **400，会话卡死**；
   - 宽松网关 → 不报错，但模型看到「自己发起过工具调用、却没有任何结果」，可能重复执行或基于空结果推理。

**预期 vs 实际**：预期原评审的修复方向「允许后续分片补 id」——即让整条链路（派发、持久化、历史配对、序列化）拿到可用 id；实际只放行了派发，id 依旧缺失，后续请求的正确性依赖下游对「无 id tool call」的容忍度，而仓库里的 normizer/serializer 明确不容忍（直接剥掉）。

**影响**：仅影响「从不回传 id」的网关（正是本修复的目标面）。对这些网关，工具调用的第一次结果用户看得到，但模型侧从第 2 轮起就丢了全部工具结果；严格网关更会在第 2 轮 400 使会话 FAILED。属静默的功能退化而非数据错乱，故定中。

**修复方向**：`mergeToolCall` 在 push 无 id 分片时补一个稳定合成的 id（如 `call-${index}` 或 `randomUUID()`，同一 index 的后续分片沿用），使 `tc.id` 全链路非空——派发、`toolResults` 计数、TOOL 消息配对、`serializeToolCall` 随即全部恢复协议合规。改动局限在 `mergeToolCall`/`parseToolCalls` 一处，无需动 normizer。

**去重说明**：`2026-10-01-logic-bug-review-01.md` BUG-8 报的是「整段调用被丢弃」（已修）；本条是该修复放行新路径后暴露的二次缺口（结果被剥离 / 协议 400），`normalizeChatMessages` 侧零历史记录。

---

## BUG-2【低】入口取消复查提前 return，跳过 finally 的收敛职责：队列消费停滞 + 定时任务绑定 stale 回写

**位置**

- `backend-ts/src/session/ws/streaming-ws-handler.ts:531-538`（`runExecution` 入口复查，`return` 位于 `try/finally` 之外）
- `backend-ts/src/session/ws/streaming-ws-handler.ts:1128-1138`（`runRetryExecution` 同构入口复查）
- 被跳过的收敛逻辑：`:541`（`boundScheduledTaskId` 捕获在复查之后）、`:596-605`（簿记归属回收）、`:607-614`（定时任务回写）、`:615`（`autoConsumeQueue`）、`:587-591`（`releaseSessionExecutionResources`）
- 对照：旧代码里被取消的排队执行仍会开跑、立即收敛 CANCELLED，其 finally 会依次完成上述全部动作

**代码事实**

```ts
// :535-538 —— 提前 return，finally 整体不执行
if (cancelFlag.get()) {
  await this.finishCancelledSession(sessionId, userId, executionId);
  return;
}
const boundScheduledTaskId = this.queueScheduledTaskIds.get(sessionId) ?? null;   // :541 捕获不到
...
} finally {
  ...
  if (boundScheduledTaskId != null && this.queueScheduledTaskIds.get(sessionId) === boundScheduledTaskId) { ... }  // :607 不执行
  if (terminalPhase !== 'FAILED') await this.autoConsumeQueue(sessionId, userId);   // :615 不执行
}
```

**触发链（两个 facet）**

1. **队列自动消费停滞**：执行 A 已提交到 agentExecutor 池但尚未开跑（池被其他会话占满），用户点停止 → `handleCancel` 落 CANCELLED 并释放簿记；A 迟到开跑走入口复查直接 return。若该会话消息队列里还有排队消息（用户在 A 在途时继续入队的），旧行为由 A 的 finally 消费下一条；新行为完全不消费——`autoConsumeQueue` 全文件仅 3 个调用点（`:615`/`:975`/`:1199`），全在执行 finally 里，手动发送不触发。排队消息要等到**下一次执行自然结束**才会被消费；若用户此后不再发送，队列徽标长期悬挂。消息不丢，但停滞不可预期。
2. **定时任务绑定 stale 回写**：A 是定时任务 busy 入队消息的执行（`autoConsumeQueue:1509-1511` 已 `queueScheduledTaskIds.set(sessionId, scheduledTaskId)`）。`releaseExecutionBookkeeping`（`:1704-1717`）不清这个映射；A 提前 return 后绑定残留。用户重发 B 时 B 在 `:541` 捕获到这个**不属于自己**的绑定，并在自己的 finally（`:607-614`）把 B 的终态回写给那个定时任务——原执行 A 的 CANCELLED 回写永远丢失，定时任务 `lastExecutionStatus` 显示的是后来无关执行的结果；若 B 也一直不来，该任务永久停在旧状态。

另有一个轻微 facet：提前 return 同样跳过 `releaseSessionExecutionResources`（`localSkillRegistry.clear` / `localAgentsMdRegistry.clear` / `mcpSyncService.clearSession` / `mcpClientManager.closeSession`）。`handleCancel` 的 `abortRunningExecution` 覆盖了关 shell、failAll、ask-questions、sync reject 等紧要项，这几个注册表清理要等下一次执行的 finally 才发生，属短期残留。

**预期 vs 实际**：预期入口复查只做「不覆盖 CANCELLED、不白做执行」；实际把 finally 里与取消终态匹配的收敛（消费队列下一条、回写/清理定时任务绑定、资源回收）一并跳过了。

**影响**：要求「池排队 + 取消 + 队列有待发消息（或定时任务来源）」的时序，概率低；后果是排队消息延迟执行与定时任务状态回写失真，不丢数据。

**修复方向**：入口复查的提前退出不要裸 `return`——把 `boundScheduledTaskId` 的捕获移到复查之前，并在该分支里补 `autoConsumeQueue(sessionId, userId)`（CANCELLED 终态按现有门禁本就要消费下一条）与绑定回写 `onScheduledTaskQueueConsumed(boundScheduledTaskId, 'CANCELLED')`；`runRetryExecution`（`:1134-1138`）同构处理。簿记归属回收保持现状即可（簿记已归 `handleCancel` 或新执行）。

**去重说明**：`2026-10-01-logic-bug-review-01.md` BUG-7 报的是「旧执行体 finally 误删新执行簿记」（本轮的归属回收已修）；本条是该修复的提前 `return` 漏掉 finally 收敛职责，未被报告。

---

## BUG-3【低】`updateUserStatusWithAdminGuard` 对「启用/清空自身状态」也抛 CANNOT_DISABLE_SELF

**位置**

- `backend-ts/src/permission/permission.service.ts:193-196`（自检在方法最前，不区分 `status` 取值）
- 入口：`backend-ts/src/user/user.service.ts:111-116`（`updateUserStatus` 任意 status 都走守卫方法）；对照 `user.service.ts:99-104`（`updateUser` 仅在 `status===0` 时调用，不受影响）

**代码事实**

```ts
// permission.service.ts:193-196
if (targetUserId === currentUserId) {
  throw new BusinessException(ErrorCode.CANNOT_DISABLE_SELF);   // status=1（启用）/null 也命中
}
```

旧 `updateUserStatus` 只在 `status===0` 时做只读守卫（`assertCanDisableUser`），对自己 `status=1`/`null` 的写入是放行的。登录侧（`auth/auth.service.ts:34,50`）只禁 `status===0`，`null`/`1` 均可登录——SSO/外部账号默认 `status` 为 null，管理员把自己的状态从 null 改为 1（启用）是可达操作。

**预期 vs 实际**：预期「不能禁用自己」只约束禁用（status=0）；实际启用/清空自身状态也被拒，且错误码 `CANNOT_DISABLE_SELF`（不能禁用自己）与操作语义错位，前端会显示误导性提示。

**影响**：管理台用户列表对本人执行「启用」从 200 变为 400（业务上是空操作，但接口行为回退）；错误文案误导。概率低、无数据影响。

**修复方向**：自检加 `status === 0` 条件（仅禁用时拒绝自禁用），或把该分支的错误码改为不带禁用语义的通用码（如 `PARAM_INVALID`/`OPERATION_NOT_ALLOWED`）。

**去重说明**：`2026-10-01-logic-bug-review-01.md` BUG-3 报的是守卫与写入不原子（已修，结构经复核正确）；本条是同一方法新引入的自检范围偏差，未被报告。

---

## 经复核确认修复正确的点（节选，避免重复排查）

| 修复 | 复核结论 |
| --- | --- |
| `resolveChatFileTarget`（chat-files.ts:21）+ 三处调用（dingtalk runtime.ts:573 传循环 index、create-app.ts:1644/1791 单文件消息） | 原名未占用保持原名、冲突用 `{stem}-{messageId}`、同消息多文件追加 `-N`；三处调用前均已 `mkdirSync`，feishu 单消息单文件无需 index，钉多变传 index 覆盖同消息同名。同一 messageId 重投（webhook 重发）写 `name-msgId` 不破坏首投引用 |
| `updateUserStatusWithAdminGuard` 事务结构 | `MysqlUserRoleRepository.transaction` 构造持事务连接的 tx 仓库（permission.repository.ts:90-92），`tx.findByRoleIdForUpdate`（FOR UPDATE）与 `tx.updateUserStatus` 同一连接同事务；`userRepo.findById` 虽走非事务连接，但绑定行锁把两个并发禁用串行化，后到者读到的已是前者的提交结果，原子性成立 |
| `user.service.ts:99-107` 禁用路径 | `user.status = undefined` 经 `toSnakeRow`（common/case.ts:27）被剔除出整行写，不会覆盖守卫事务的 status=0；写后回填 `user.status = 0` 保证路由 VO 与 DB 一致 |
| `updateUser` 的 `validateUserStatus` | `updateUser`/`updateUserStatus` 双入口均拒绝 0/1/null 之外的取值 |
| `mergeToolCall` push 分支本身 | 按 index 顺序到达时合并/追加正确（含并行调用交错分片）；注意 `findMergeTarget` 的 `?? existing[delta.index]` 位置兜底在 index 乱序时会错并——属既有行为，网关按 index 顺序流式发送时不触发 |
| 子代理重试改走 `buildRetryContext + executePrepared` | `sessionMapper.selectById` 返回领域 `Session`，`sessionType` 校验有效；definition 解析与 spawn 路径同构（normalizeAgentType + registry）；handler 在 :1082 已向 agentLoop 注册 cancelFlag，`executePrepared` 不传 flag 也不丢取消传播（`isCancelled`/`resolveCancelFlag` 查 registry）；`buildRetryContext` 抛错被 runRetryExecution catch 收敛为 FAILED + completeRetry。小遗留：`buildRetryContext` 内 `buildContext` 连接 MCP 时 cancelFlag 为 null，该窗口的取消要等连接超时 |
| 插队补偿（handleInsertMessage） | 按 `savedMessageId`/`queueRowDeleted` 两标志精确回滚；与 `handleSendMessage` 内部 `requeueIfClaimed` 不会双重补偿（后者早退不抛出）；补偿内异常均有日志 |
| `runSideFirstMessage` finally 归属回收 | `flag` 为该边路执行的 flag 对象，身份判定正确 |
| `urlSlug` 短哈希 | 同 URL 反复抓取哈希稳定覆盖同一文件（测试断言）、不同 URL 互不覆盖；仅用于截断全文落盘路径 |

## 附录 A：验证记录

- `cd backend-ts && npm run build`：exit 0。
- `cd backend-ts && npm test`：229 个测试文件 2440 passed / 1 failed。失败用例为 `streaming-ws-handler.spec.ts > cancel releases the claim even when the execution body never reaches finally`（setup 阶段 `hasExecutionClaim` 断言）。
- 该失败经 `git stash` 对拍为**既有 flaky、非本轮引入**：干净树 `main@3ef96473` 单独跑同一 spec 8 次挂 3 次，本工作区单独跑 5 次挂 2 次，同一用例、同一断言。疑似与文件内前置用例残留的 `pendingCancels`/fake timer 时序有关（`takePendingCancel` 的毫秒级 `>=` 比较），建议另案修复测试隔离，不计入本轮。
- 本轮新增/修改的测试（agent-loop 无 id 分片、open-web-page 文件名碰撞、permission 守卫事务 ×3、user status 校验、chat-files ×4、ws handler 入口收敛/插队补偿 ×2）均通过。

## 附录 B：覆盖度与限制声明

- 本轮为纯静态审查 + 全量构建/测试验证，未做运行时复现（BUG-1/BUG-2 的触发链含网关行为与线程池时序，建议按各自「修复方向」落码时补对应用例：BUG-1 可在 agent-loop.spec 中断言 tool call id 全链路非空并被 normalizer 保留；BUG-2 可仿 'execution cancelled while queued' 补一条「取消排队执行后队列下一条仍被消费/定时任务回写 CANCELLED」的用例）。
- `desktop/src/components/task/task-index-panel.css`（既有 BUG-1 的修复）仅确认改动为样式重排，未做渲染验收。
