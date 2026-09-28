# 代码审查报告：边路任务 contextMode 三选一改造

**日期**：2026-09-28
**审查范围**：git 工作区未提交改动（7 个文件）
**需求概述**：将边路任务上下文继承方式从 checkbox（inheritContext boolean）改为三选一 radio（contextMode: 'fork' | 'summary' | 'none'），其中 fork 模式物理复制主会话全部消息、file_change、compaction 记录。

---

## 总体结论

**可合并，无阻塞项。**

发现 2 个重要问题（fork 模式下前端历史消息展示不完整、fork 模式下消息排序可能错乱导致 LLM 上下文顺序混乱）和 1 个建议项。均不阻塞核心功能运行，但影响 fork 模式的用户体验和上下文正确性。

---

## 问题列表

### 重要

#### 1. Fork 模式前端历史消息展示不完整

**文件**：`desktop/src/components/chat/SideChatPanel.vue:395`
**问题描述**：fork 模式下 `fetchMessages()` 使用 `roundLimit: 5` 参数从 REST 拉取消息。如果主会话历史超过 5 轮对话，前端只能看到最近 5 轮的消息，其余 fork 过来的历史消息不会展示。用户选择 "Fork 主会话" 的期望是看到完整的继承历史。

**影响**：用户在边路任务面板中只能看到部分 fork 历史消息，可能误以为 fork 未生效或消息丢失。虽然后端 LLM 上下文不受影响（`buildContext` 通过 `loadHistoryAfterBoundary` 加载全部消息），但前端展示不完整。

**修复建议**：fork 模式下首次拉取消息时考虑增大 `roundLimit` 或移除限制（传一个较大值如 100），确保 fork 的历史消息完整展示。例如：
```ts
const { data } = await api.get(`/sessions/${sid}/messages`, {
  params: { roundLimit: contextMode.value === 'fork' ? 100 : 5 }
})
```

#### 2. Fork 后所有消息 created_at 相同，导致按 created_at 排序时顺序错乱

**文件**：`backend-ts/src/harness/core/harness-service.ts:576-587`
**问题描述**：`forkParentMessages` 中使用 `tx.insert('message', {...})` 复制消息，未携带 `createdAt` 字段。`Db.insert` 的 `toSnakeRow` 只处理传入的对象字段，未传入 `createdAt` 时 MySQL 使用 `DEFAULT CURRENT_TIMESTAMP`，因此所有 fork 消息的 `created_at` 都是同一个事务时间。

`selectMessagesAfterId` 使用 `ORDER BY id ASC` 不受影响，但 `listBySession`、`selectRange`、`selectMessagesByRounds` 内部的 `selectRange` 使用 `ORDER BY created_at ASC, id ASC`。由于 `created_at` 相同，实际退化为 `ORDER BY id ASC`——这在 MySQL `AUTO_INCREMENT` 单调递增的前提下恰好正确。

**但**：`getMessagesByRounds` 中的 `selectUserStarts` 使用 `ORDER BY id DESC LIMIT ?` 找最近的用户消息，然后 `selectRange` 用 `id >= startId` 取范围。fork 的消息 id 单调递增，顺序正确。所以**实际不影响 LLM 上下文顺序**。

**重新评估**：经过完整链路分析，由于 MySQL `AUTO_INCREMENT` 保证 id 单调递增，且所有 fork 消息 created_at 相同导致排序退化为 id 序，消息顺序恰好正确。此问题降级为**无实际影响**，但代码隐含了对 `created_at` 排序的依赖假设，未来如果 `AUTO_INCREMENT` 行为变化或有并发插入可能出问题。

**修复建议（低优先级）**：在 fork 复制消息时显式传入 `createdAt: m.createdAt` 以保留原始时间戳，消除隐含假设。

### 建议

#### 3. Fork 未复制 session_compaction_event 记录

**文件**：`backend-ts/src/harness/core/harness-service.ts:617-634`
**问题描述**：`forkParentMessages` 复制了 `session_compaction`（摘要表）但未复制 `session_compaction_event`（压缩事件历史表）。`session_compaction_event` 用于前端时间线展示压缩历史。`promoteSideTaskToMainSession` 中的做法是删除边路会话的 compaction_event（因为它原本就没有），而非复制。

**影响**：fork 模式下，边路会话继承了主会话的 compaction 摘要（`session_compaction` 表），但没有对应的 `session_compaction_event` 记录。前端 `fetchMessages` 返回的 `compactionEvents` 为空数组，导致压缩时间线指示器不显示。这不影响功能正确性（摘要仍然生效），只是前端缺少压缩历史展示。

**修复建议**：如果需要在 fork 会话中展示压缩历史时间线，可在事务内一并复制 `session_compaction_event` 记录（注意 `prev_boundary_msg_id` 和 `boundary_msg_id` 需通过 `messageIdMap` 重映射）。如果不需要展示，当前行为可接受，无需修改。

---

## 已验证无问题的审查点

1. **messageIdMap 正确性**：fork 中 `messageIdMap` 旧 ID → 新 ID 映射逻辑正确，file_change 的 `messageId` 和 compaction 的 `lastCompactedMsgId` 均通过 map 重映射，map miss 时安全跳过（`?? null`）。

2. **buildContext 加载 fork 消息**：`buildContext` 调用 `loadValidated(sessionId)` → `boundaryOf(compactionRecord)` → `getMessagesAfterId(sessionId, boundary)` → `selectMessagesAfterId(sessionId, boundary)` 使用 `ORDER BY id ASC`，fork 后所有消息 id 单调递增，能正确加载。`loadValidated` 中的 `selectValidBoundaryMessage` 校验也能通过（boundary 消息已通过 messageIdMap 重映射到新 id）。

3. **WS 字段名替换完整性**：全量搜索 `inheritContext` 在前后端代码中无残留引用。`streaming-ws-handler.ts` 的 `contextMode` 解析逻辑正确：仅接受 `'fork'` / `'summary'`，其他值（包括 undefined）降级为 `'none'`。

4. **FileChange 字段映射**：`SELECT * FROM message_file_change` 经 `toCamel` 返回 `filePath`/`changeType` 属性（而非 `path`/`type`）。fork 代码使用 `(change as { filePath?: string }).filePath ?? change.path` 兼容两种属性名，与 `FileChangeRepository.insert` 中的写法一致，正确。

5. **patchTruncated 布尔→数字转换**：fork 代码 `patchTruncated == null ? null : patchTruncated ? 1 : 0` 正确处理了 boolean/number/null 到 TINYINT 的转换，与 `FileChangeRepository.insert` 一致。

6. **事务安全性**：fork 在 `this.db.transaction(async (tx) => {...})` 中执行，异常时回滚，不会产生半复制状态。

7. **db 可用性**：`forkParentMessages` 开头检查 `if (!this.db) throw`，`create-app.ts` 中传入 `db` 实例，生产环境可用。

8. **测试覆盖**：`harness-service.spec.ts` 新增 `executeSideFirstMessageNoneDoesNotInject` 测试覆盖 none 模式；`streaming-ws-handler.spec.ts` 将 3 处 `inheritContext: true` 替换为 `contextMode: 'summary'`。测试覆盖基本完整，但未覆盖 fork 模式（因 mock 环境无 db 实例，forkParentMessages 会抛错），这是预期限制。

---

## 审查范围

- `backend-ts/src/harness/core/harness-service.ts`（executeSideFirstMessage 改造 + forkParentMessages 新增）
- `backend-ts/src/harness/core/harness-service.spec.ts`（测试更新）
- `backend-ts/src/harness/deps.ts`（Message 接口新增 sourceSessionId 字段）
- `backend-ts/src/session/ws/streaming-ws-handler.ts`（handleCreateSideSession 解析 contextMode）
- `backend-ts/src/session/ws/streaming-ws-handler.spec.ts`（WS 测试更新）
- `desktop/src/components/chat/SideChatPanel.vue`（checkbox → radio-group + fork 模式下刷新消息）
- `desktop/src/composables/useStreamWS.ts`（createSideSession 参数和 payload 字段替换）

**关联文件审查**（为验证 fork 逻辑正确性而检查的既有代码）：
- `backend-ts/src/session/session.service.ts`（promoteSideTaskToMainSession 参考实现）
- `backend-ts/src/session/session.repository.ts`（MessageRepository / FileChangeRepository insert 与查询）
- `backend-ts/src/session/session-compaction.service.ts`（loadValidated / boundaryOf）
- `backend-ts/src/session/session-compaction.repository.ts`（SessionCompactionRepository / SessionCompactionEventRepository）
- `backend-ts/src/harness/core/session-history-loader.ts`（loadHistoryAfterBoundary）
- `backend-ts/src/db/db.ts`（insert / query / transaction / toSnakeRow）
- `backend-ts/src/common/case.ts`（toCamel / toCamelList / toSnakeRow）
- `backend-ts/db/migration/`（V001/V014/V037/V040/V042/V051/V062/V071/V074 表结构）
- `backend-ts/src/create-app.ts`（HarnessService 构造参数）
