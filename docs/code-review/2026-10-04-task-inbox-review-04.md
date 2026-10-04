# 任务收件箱（站内通知中心）代码审查 — 第 4 轮

- **日期**：2026-10-04
- **基线**：git 工作区未提交改动（`git status` 实测 33 modified + `backend-ts/src/inbox/`、`desktop/src/components/inbox/`、`desktop/src/stores/inbox/`、`shared/contracts/src/inbox.ts`、`backend-ts/db/migration/V131__inbox_notification.sql` 等 untracked）。
- **审查方式**：只读审查，**未修改任何源码**，未执行部署。每个疑似问题都先写临时 probe 单测运行验证，跑完即删除（报告结尾的 `git status` 复核确认无残留）。
- **上轮报告**：`docs/code-review/2026-10-04-task-inbox-review-03.md`（BUG-1 ~ BUG-6，均已修复）。

## 1. 总体结论

本轮确认 **1 个可复现的功能缺陷（BUG-7，定时任务 busy 簿记在 liveExecution 取消分支泄漏，导致 `lastExecutionStatus` 永久停在 `QUEUED`）**，无阻塞项。

前 3 轮已确认的 BUG-1 ~ BUG-6 在当前工作区均已修复且带回归用例，本轮逐条复核无误（见第 3 节）。另有 1 个候选问题（`peekInboxFirstPage` 透传 `unreadOnly`）经 probe 构造后**无法复现出稳定的功能失败**，按"避免误报"原则不计入 bug，仅在附录记录构造过程备查。

## 2. 问题列表

### BUG-7【中】`takePendingCancel` 命中分支漏清 `queueScheduledTaskIds`，定时任务 `lastExecutionStatus` 永久停在 `QUEUED`

**位置**

- 缺陷点：`backend-ts/src/session/ws/streaming-ws-handler.ts:709-714`

  ```ts
  if (this.takePendingCancel(sessionId, startedAt ?? Date.now(), flag)) {
    await this.finishCancelledSession(sessionId, userId, executionId);
    if (scheduledTaskId != null && this.scheduledTaskIds.get(sessionId) === scheduledTaskId) {
      this.scheduledTaskIds.delete(sessionId);
    }
    return;   // ← 未处理 queueScheduledTaskIds，也未回调 onScheduledTaskQueueConsumed
  }
  ```

- 对照 1（busy 路径自身已正确处理）：`streaming-ws-handler.ts:504-517` 的 `takePendingCancel` 分支里，对 `queueScheduledTaskIds` 做了 delete + `onScheduledTaskQueueConsumed(scheduledTaskId, 'CANCELLED')` 回写；
- 对照 2（另一个早退 helper）：`streaming-ws-handler.ts:405-410` 的 `requeueIfClaimed` 也 delete 了该映射；
- 消费方：`streaming-ws-handler.ts:652-660`（`runExecution` 的 finally）读 `queueScheduledTaskIds` 并回调回写；`scheduled-task.service.ts:417`（busy 入队时置 `lastExecutionStatus='QUEUED'`）。

**问题**

`scheduledTaskIds`（liveExecution 收件箱来源）与 `queueScheduledTaskIds`（busy 入队回写来源）是两张独立的 Map，代码注释（`:205-216`）也明确写了"两套簿记的作用域与清理时机都不同"。`executePersistedUserPrompt` 在 `takePendingCancel` 命中时**只清理了自己那张 `scheduledTaskIds` 就 return**，完全不看另一张：

1. 用户在会话 busy 期间继续发消息触发了 busy 入队（`scheduled-task.service.ts:417` 写入 `lastExecutionStatus='QUEUED'`，handler 侧 `:1571` 登记 `queueScheduledTaskIds`）；
2. 随后定时任务到点，liveExecution 在提交前窗口被用户停止（`takePendingCancel` 命中）；
3. `finishCancelledSession` 落 CANCELLED，`scheduledTaskIds` 清掉，**直接 return**；
4. `queueScheduledTaskIds` 里的条目无人删除、`onScheduledTaskQueueConsumed` 无人回调 → 该定时任务 `lastExecutionStatus` **永久停在 `QUEUED`**；
5. 且残留条目会被**下一次**进入 `runExecution` 的执行在 finally 里按"值未易主"判定回收：若下次执行的 taskId 恰好相同会回写一条错位的终态，不同则旧绑定继续残留、持续污染后续回写。

**影响**

- 用户可见：定时任务执行历史里，一次实际已取消的执行永远显示「排队中」（管理后台 / 任务详情），状态不可信。
- 数据可见：`lastExecutionStatus` 与实际执行结果长期不一致；`queueScheduledTaskIds` 存在泄漏，极端情况下把错误的终态回写到无关任务。

**可复现证据（本轮实测，临时 probe 已删除）**

构造：先预置 `queueScheduledTaskIds {11→9}`（模拟 busy 入队已登记），再登记 `pendingCancels {11→now}`，以 `startedAt = now` 调 `executePersistedUserPrompt(..., 4242)` 使 `takePendingCancel` 命中：

```
[PROBE-C] finishExecution = [[11,7,"CANCELLED","sched-cancel"]]
[PROBE-C] onScheduledTaskQueueConsumed = []            ← 零回调，状态不回写
[PROBE-C] queueScheduledTaskIds 残留 = [[11,9]]        ← 簿记泄漏
```

断言 `queueScheduledTaskIds.size === 0` 与 `onScheduledTaskQueueConsumed` 被调用均失败（`expected 1 to be +0`），确认缺陷真实存在。同文件对照组（未预置 busy 簿记）则两断言均通过，排除测试构造本身的干扰。

**修复方向**（不改代码，交由后续 worker）

在 `:709-714` 这个早退分支补 busy 簿记收敛，语义与 `:504-517` 完全一致：

```ts
const queuedTaskId = this.queueScheduledTaskIds.get(sessionId);
if (queuedTaskId != null) {
  this.queueScheduledTaskIds.delete(sessionId);
  try { await this.deps.onScheduledTaskQueueConsumed?.(queuedTaskId, 'CANCELLED'); }
  catch (e) { console.warn(...); }
}
```

更稳妥的做法是把这段抽成私有方法（如 `settleQueuedScheduledBinding(sessionId, phase)`），让 `:504`、`:709`、`runExecution` finally 三处共用同一实现——本次 bug 的根因正是"同一收敛逻辑有三个副本、只改了两处"。同时补一条 spec：预置 busy 簿记后走 liveExecution 取消分支，断言映射清空且回写 `CANCELLED`。

---

## 3. 本轮已复核项（确认正确，避免后续重复审查）

- **BUG-1 修复成立**：`createScheduledLiveExecution` 工厂 + `create-app.ts:1171-1174` 装配；`streaming-ws-handler.spec.ts` 有 `live.length === 6` 与逐参透传断言，且断言终点落在 `finishExecution(..., 'SCHEDULED')`，不仅测 `executePersistedUserPrompt` 本体。
- **BUG-2 / BUG-3 修复成立**：`inbox.service.spec.ts` / `inbox.repository.spec.ts` 的偏好夹具均含 `systemNotifyEnabled`；`stores/inbox/index.ts` 初始 preference 五字段齐全、无 `as InboxPreference` 断言。
- **BUG-4 修复成立**：`NotificationSettingsView.vue` 绑定 `inboxForm.systemNotifyEnabled`；`inboxDirty` 遍历 5 键。
- **BUG-5 修复成立**：`useInboxSystemNotify.ts:112-115` 总闸位置正确（`requestPermissionOnce` 之后、`notifiedIds` 记账之后、kind 过滤之前），单测反例有效。
- **BUG-6 修复成立**：`peekInboxFirstPage()` 不写 `store.items`，diff 数据源与 `InboxDrawer` watcher 已解耦；`useInboxSystemNotify.test.ts` 的 BUG-6 回归段（挂真实 drawer watcher）4 条用例通过。
- 后端写入链路：`insertIgnore` 唯一键幂等、全链路 `user_id` 边界、`markReadByDedupKey` 等值匹配（无 LIKE 扫描）、`toInboxItem` 的 payload 容错、`deleteHistory` 90 天单条 DELETE。
- 门控条件：`task-terminal.service.ts` 的 `recordInbox` 排除集合读 `sessionType`（非 `parentSessionId` 近似），覆盖 SIDE_TASK 被提升为 `parentSessionId=null` 的边界；四处 SUBAGENT_DONE 只在 DELIVERED 后写；`resolvePending` / `resolveApprovalPending` 单挂点。
- 未读数口径：写路径后 `countUnread` + WS 广播；`inbox_updated` 已入 `CRITICAL_EVENT_TYPES`；前端 `setUnreadCount` 只认权威值、负数/NaN 归零、不本地累加。
- 前端链路：`InboxBell` onMounted 同时拉未读数与偏好；`useStreamWS` onopen 重拉未读数（刻意不放进 `focusLoaded` 分支）。
- fire-and-forget：task-terminal / tool-dispatcher / local-tool-executor / subagent 四处收件箱副作用全部异常全吞，主链路不被打断。

## 4. 本轮已运行的验证（只读，未改源码）

- `cd backend-ts && npm test` → **exit 1**，3 个失败全部在 `src/file/git-write-operation.service.spec.ts` 与 `src/session/session-extra.spec.ts`（`Test timed out in 5000ms`），与本次收件箱改动无关。
- 收件箱相关 18 个 spec 单独跑：`npx vitest run src/inbox src/harness/delegate src/harness/tool/tool-dispatcher.spec.ts src/harness/local src/session/task-terminal.service.spec.ts src/session/ws/streaming-ws-handler.spec.ts src/schedule/scheduled-task.service.spec.ts` → **18 files / 284 passed**。
- `cd backend-ts && npm run build` → exit 0。
- `cd desktop && npx vitest run src/composables/useInboxSystemNotify.test.ts src/stores/inbox/inbox.test.ts src/composables/useStreamWS.test.ts` → **3 files / 41 passed**。
- BUG-7 probe：1 failed（`expected 1 to be +0`）+ 2 passed（对照组），输出见第 2 节。
- `git status` 复核：与审查前一致，无 probe 临时文件残留。

## 附录：未计入 bug 的候选（记录下来备查）

**候选 1：`peekInboxFirstPage()` 透传 `store.unreadOnly`**（`desktop/src/stores/inbox/index.ts:110`）

用 probe 实测：勾选「只看未读」后 `peekInboxFirstPage` 确实带 `unreadOnly: true`（接口返回过滤后的第一页），与函数注释"只用于新增条目 diff"的口径存在偏差。但构造"基线被空列表冲刷后新条目不被弹"的失败场景时，由于列表按 `created_at DESC` 排序、新条目永远落在第一页首位，`fresh` 仍能算出，**无法稳定复现功能失败**。按"避免误报"原则不计入 bug；若后续有人把 `peekInboxFirstPage` 改为分页 diff 或基线改为 id 集合，此处应一并固定为 `unreadOnly: false`。

**候选 2：`notifiedIds` / `knownIds` 无上限增长、登出不清空**

内存 Set 单调累积，仅在页面刷新时重置。量级为"用户实际收到的通知数"，不构成内存风险；登出换号后旧基线最多导致一次"历史条目不弹"，与 BUG-6 修复后的语义一致，属已知取舍。
