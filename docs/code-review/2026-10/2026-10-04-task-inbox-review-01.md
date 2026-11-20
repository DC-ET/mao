# 任务收件箱（站内通知中心）未提交改动代码审查

- **日期**：2026-10-04
- **基线**：git 工作区未提交改动（`git status` 实测 31 modified + 7 untracked 路径），CHANGELOG 已升至 `0.0.235`。所有行号以当前工作区源码实测核对。
- **范围**：仅本次需求引入/改动的功能代码，不含文档变更（`docs/plan/`、`docs/proposals/`、`CHANGELOG.md`、`README.md`、`skills/mao-cli/*` 按任务要求不审）。已逐文件走读：`backend-ts/src/inbox/`（repository/service/routes/cleanup/types + 4 份 spec）、`task-terminal.service.ts`、`tool-dispatcher.ts`、`local-tool-executor.ts`、`background-subagent-manager.ts`、`subagent-result-delivery.service.ts`、`streaming-ws-handler.ts`、`streaming-ws-registry.ts`、`scheduled-task.service.ts`、`create-app.ts`、`V131__inbox_notification.sql`、`shared/contracts/src/inbox.ts`、desktop 侧 stores/inbox、InboxBell/InboxDrawer、useInboxSystemNotify、useStreamWS、NotificationSettingsView、TopNav、electron/main.cjs、api/index.ts、tests/desktop.spec.ts。
- **方法**：以技术方案红线为基准通读实现，逐条回读调用方/装配/WS 帧流验证触发链；对可疑点实际运行测试与 `tsc` 验证。
  - `cd backend-ts && npm run build`：exit 0（`tsconfig.build.json` 排除 spec，故 spec 内类型错误不阻断 CI 构建）。
  - `npx vitest run src/inbox`：3 文件 30 passed；`streaming-ws-handler + scheduled-task + tool-dispatcher + local-tool-executor` 4 spec：165 passed。
  - `cd desktop && npx vitest run src/stores/inbox src/composables/useInboxSystemNotify.test.ts`：23 passed；`useStreamWS.test.ts`：12 passed；`npx vue-tsc --noEmit`：exit 0，且无 inbox 相关告警。
  - 未运行：后端全量 `npm test`、`tests/playwright`（E2E）。
- **结论**：确认 **1 个可复现的功能缺陷**（阻塞级，短参调用导致来源透传链路整体失效）+ **2 个重要问题**（均为本次新增代码自身的类型/契约不一致，不影响运行与 CI，但属需求自身引入的瑕疵）+ **5 条建议**。未发现数据越权、幂等失效、未读数口径混乱、通知重复/漏报等其他功能 bug。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 阻塞 | schedule + session/ws（来源透传） | `create-app.ts:1171` 的 `liveExecution` lambda 只接 5 参，第 6 参 `scheduledTaskId` 被静默丢弃：**生产环境所有定时任务收件箱条目都不带「定时任务」徽标**，且 spec 对生产路径的断言与实际装配脱节 |
| BUG-2 | 重要 | backend-ts spec（新增代码自身） | `inbox.service.spec.ts:64,90` 与 `inbox.repository.spec.ts:82,283,295` 的偏好夹具缺 `systemNotifyEnabled`，`tsc --noEmit` 报 5 处新错误（本次需求引入） |
| BUG-3 | 重要 | desktop stores/inbox | store 初始 `preference` 缺 `systemNotifyEnabled` 字段（TS 靠可选链容忍、契约上是缺字段），与后端 `InboxPreference` 契约不一致 |
| 建议-1 | 建议 | schedule + tool-dispatcher | `scheduledTaskIds` 与 `queueScheduledTaskIds` 两套簿记并存：busy 入队路径经 `handleSendMessage`，若未来有人按 `boundLiveScheduledTaskId` 补收件箱来源会再次漏 |

---

## BUG-1【阻塞】`create-app.ts` 的 `liveExecution` lambda 漏传第 6 参，定时任务来源透传在生产环境整体失效

**位置**

- 装配漏参：`backend-ts/src/create-app.ts:1171-1172`

  ```ts
  scheduledService.setLiveExecution((session, userId, executionId, saved, startedAt) =>
    wsHandler.executePersistedUserPrompt(session, userId, executionId, saved, startedAt));
  ```

- 被调用方签名：`backend-ts/src/session/ws/streaming-ws-handler.ts:651-657`（第 6 参 `scheduledTaskId?: number | null`，入口 `:670` 写入 `scheduledTaskIds` 簿记）
- 调用方实参：`backend-ts/src/schedule/scheduled-task.service.ts:455` —— `this.liveExecution(session, userId, executionId, savedMessage, executionStartedAt, task.id ?? null)`，**第 6 参确实传了**
- 窄接口定义：`backend-ts/src/schedule/scheduled-task.service.ts:75-84`（`ScheduledLiveExecution` 已含第 6 参）
- 消费侧：`streaming-ws-handler.ts:547-548`（`boundLiveScheduledTaskId` / `scheduled`）→ `:574/:594/:602` 三个 finisher → `:1818-1819/:1835-1836`（`finishExecution(..., 'SCHEDULED')`）→ `task-terminal.service.ts:49`（`notifySource`）→ `:157`（`source: notifySource`）
- 前端展示：`desktop/src/components/inbox/InboxDrawer.vue:49-51`（`isScheduled()` 读 `payload.source === 'SCHEDULED'`）

**代码事实**

`create-app.ts:1171` 的 lambda 形参表只声明到 `startedAt`，`scheduled-task.service.ts:455` 传来的 `task.id ?? null` **没有任何形参接它**，JS 函数调用丢弃多余实参，`executePersistedUserPrompt` 收到 `scheduledTaskId === undefined`，`:670` 的 `if (scheduledTaskId != null)` 不成立，`scheduledTaskIds` 永不写入，`scheduled` 恒为 `false`，三个 finisher 全部走 else 分支的 5 参 `finishExecution`，`notifySource` 取默认 `'MANUAL'`，payload 落 `source: 'MANUAL'`。

技术方案在 4.2 已明确预警过这个坑并写死了要求：

> **TS 窄接口无告警**：给 6 份窄接口消费方加第 6 参时，缺省调用点既不会报错也不会生效，只会静默取默认值。因此"定时任务路径传 SCHEDULED"必须是 spec 断言项（生产路径 `finishCompletedSession` / `finishFailedSession`，而非 `scheduled-task.service.ts:472`）。

spec 侧确实写了断言，但断言的是 `executePersistedUserPrompt` **被直接调用**时的行为（`streaming-ws-handler.spec.ts:851-865` 显式传 `42`），而生产链路真正被调用的封装点是 `create-app.ts:1171` 的 lambda——该 lambda 不在任何 spec 覆盖内。TS 与本仓全部门禁都不会报错：`npm run build`（tsconfig.build 排除 spec）exit 0，`tsc --noEmit` 对该 lambda 也只报"声明了未使用的形参"之外的零错误（TS 允许声明形参数少于实现）。

**触发链**

1. 用户在「定时任务」页创建 cron 任务，期望着件箱里能区分「这条是定时任务跑的」；
2. 到点触发 → `scheduled-task.service.ts:455` → `create-app.ts:1171` lambda → 第 6 参被丢；
3. 会话收敛 COMPLETED/FAILED → `finishExecution` 第 6 参缺省 `'MANUAL'`；
4. 收件箱条目 `payload.source === 'MANUAL'` → `InboxDrawer.vue:50` 的 `isScheduled()` 返回 false → **「定时任务」徽标永不显示**。

**预期 vs 实际**：预期定时任务产生的条目带「定时任务」徽标（CHANGELOG 0.0.235 与方案 2.2/4.2 均明确承诺）；实际所有定时任务条目与手工触发条目在收件箱里完全无法区分。注意 busy 入队路径（`scheduled-task.service.ts:413-435`）也不经此 lambda（它经 `autoConsumeQueue` → `handleSendMessage`），所以两条定时任务路径都没有徽标，只是原因不同。

**影响**：非数据错误、无未读数漂移、无重复通知，属**展示层功能未交付**。用户视角是"设置里的说明和 CHANGELOG 说有的功能没有"，且线上无法通过前端恢复。

**为何现有测试全绿却未暴露**：

1. 唯一直接覆盖本链路的 `streaming-ws-handler.spec.ts:851-865` 断言的是 `executePersistedUserPrompt` **本体**（显式传 `42`），没有覆盖 `create-app.ts:1171` 这层 lambda 装配；
2. `scheduled-task.service.spec.ts` 的 `ScheduledLiveExecution` 用例用 `const live = vi.fn(...)` 自造假实现并只断言飞书推送，不触达 `finishExecution` 第 6 参；
3. `tests/desktop.spec.ts:838-845` 的 E2E 用 `page.route` 直接 mock `/api/v1/inbox` 并喂 `payload: { source: 'SCHEDULED' }（`:806-808` 的 `record({ id: 1, payload: { source: 'SCHEDULED' } ... })`），完全绕过真实后端链路，徽标断言必然通过；
4. TS 侧：lambda 形参数少于其标注的 `ScheduledLiveExecution` 签名是**合法**的（形参更少的函数可赋值给形参更多的函数类型），`tsc --noEmit` / `npm run build` 均零告警。

**修复方向**（不改代码，交由后续 worker）：`create-app.ts:1171` 的 lambda 补第 6 参 `taskId`，形参名与 `ScheduledLiveExecution` 对齐：

```ts
scheduledService.setLiveExecution((session, userId, executionId, saved, startedAt, taskId) =>
  wsHandler.executePersistedUserPrompt(session, userId, executionId, saved, startedAt, taskId));
```

同时补一条覆盖「lambda 装配层」的回归断言：把 `create-app.ts` 的 lambda 抽成可测的工厂函数（或让 spec 直接构造同一 lambda），断言第 6 参被透传到 `finishExecution` 的第 6 参，而非只测 `executePersistedUserPrompt` 本体——否则同类"装配层漏参"仍会复现。

**去重说明**：历史 `docs/code-review/` 内无 task-inbox 相关评审文档（本目录首篇收件箱审查）。

---

## BUG-2【重要】新增 spec 的偏好夹具缺 `systemNotifyEnabled`，`tsc --noEmit` 报 5 处本次引入的类型错误

**位置**

- `backend-ts/src/inbox/inbox.service.spec.ts:64` 与 `:90`
- `backend-ts/src/inbox/inbox.repository.spec.ts:82`、`:283`、`:295`

**代码事实**

`tsc --noEmit` 实测输出（本次需求相关的新错误）：

```
src/inbox/inbox.service.spec.ts(64,7): error TS2741: Property 'systemNotifyEnabled' is missing ...
src/inbox/inbox.service.spec.ts(90,7): error TS2741: Property 'systemNotifyEnabled' is missing ...
src/inbox/inbox.repository.spec.ts(82,15): error TS2741: Property 'systemNotifyEnabled' is missing ...
src/inbox/inbox.repository.spec.ts(283,34): error TS2345: Argument ... not assignable ...
src/inbox/inbox.repository.spec.ts(295,34): error TS2345: Argument ... not assignable ...
```

`UserInboxPreferenceRow`（`inbox.repository.ts:24-31`）与 `savePreference` 入参（`inbox.repository.ts:157-164`）都要求 `systemNotifyEnabled`，而这三处夹具只给了 4 个 kind 开关字段。

**影响**：vitest 运行不受影响（30 passed，ESBuild 不做类型检查），`npm run build` 也不受影响（`tsconfig.build.json` 排除 `**/*.spec.ts`），因此**不是功能 bug、不阻断 CI**。但它是本次新增代码内部的契约不一致：偏好夹具与真实行形状已脱节，后续若有人给偏好流程加第 6 个字段，夹具会继续静默漂移，spec 的"夹具即契约文档"价值被削弱。仓内既有 spec 也有同型告警（`tool-dispatcher.spec.ts` 等 Tuple 长度 0 类），但那些是历史遗留，本次是新写的文件。

**修复方向**：三处夹具补 `systemNotifyEnabled`（`UserInboxPreferenceRow` 夹具填 `0` 或 `1`，`savePreference` 夹具填布尔值），使 spec 与实现签名一致。

---

## BUG-3【重要】`stores/inbox/index.ts` 初始 `preference` 缺 `systemNotifyEnabled` 字段，与契约不符

**位置**：`desktop/src/stores/inbox/index.ts:29-34`

```ts
preference: {
  taskCompletedEnabled: true,
  questionPendingEnabled: true,
  approvalPendingEnabled: true,
  subagentDoneEnabled: false
} as InboxPreference
```

**代码事实**

`shared/contracts/src/inbox.ts:33-39` 的 `InboxPreference` 有 5 个必填字段（含 `systemNotifyEnabled: boolean`），store 初始值只给 4 个，靠 `as InboxPreference` 断言绕过编译。运行时该 store 的 `preference` 只在两个地方被读：

1. `useInboxSystemNotify.ts:95`（`isInboxKindEnabled(item.kind, inboxStore.preference)`）——只按 kind 字段取值，未触达 `systemNotifyEnabled`；
2. `saveInboxPreference` 的 `{ ...this.preference, ...patch }` 合并。

第 2 条是真实风险：**store 的 `fetchInboxPreference()` 在全仓没有任何调用点**（grep `desktop/src` 确认，只有测试与 `NotificationSettingsView` 自己直接调 API）。因此若用户在设置页保存过一次偏好，`NotificationSettingsView` 用的是自己 `inboxSaved`/`inboxForm` 副本（`:224-230`，5 字段齐全，正常）；但 inbox store 的 `preference` 始终是初始 4 字段值，一旦将来（或并发）有人走 `store.saveInboxPreference(patch)`，会把 `systemNotifyEnabled: undefined` PUT 给后端——路由层 `readFlag(undefined, current)` 会回落当前值所以不会写坏，但这条路径是"静默依赖后端兜底"而非"前端契约自洽"。

**预期 vs 实际**：预期 store 初值与 contracts 一致；实际靠类型断言掩盖缺字段。

**影响**：当前无用户可见功能异常（上述唯一潜在调用点未接线 + 后端 readFlag 兜底），属契约/可维护性问题；但它是本次新增 store 自身与新增 contracts 的不一致，不是历史遗留。

**修复方向**：初始值补 `systemNotifyEnabled: true` 并去掉 `as InboxPreference` 断言（初值本就是期望形状，无需断言）；同时明确 inbox store 的 `preference` 由谁加载（要么在 `InboxBell.onMounted` 一并 `fetchInboxPreference()`，要么删掉 store 里未被消费的 preference 状态）。

---

## 建议（均为低风险 / 已记录取舍 / 语义说明）

**建议-1：`scheduledTaskIds` 与 `queueScheduledTaskIds` 两套簿记并存，busy 入队路径的来源仍不可达**

`streaming-ws-handler.ts:186-192` 同时维护两套 Map：`queueScheduledTaskIds`（`autoConsumeQueue` busy 入队路径，回写 `lastExecutionStatus`）与 `scheduledTaskIds`（`executePersistedUserPrompt` liveExecution 路径，收件箱来源透传）。busy 路径的真实执行入口是 `autoConsumeQueue` → `handleSendMessage` → `runExecution`，该路径上 `scheduledTaskIds` 从不写入，因此 busy 入队的定时任务即使修了 BUG-1 也不会有「定时任务」徽标。当前实现没有对外承诺 busy 入队也有徽标（方案 4.2 只提 liveExecution 入口），故不算缺陷；但两套 Map 的模式、注释、finally 清理逻辑几乎相同（`:623-637` 与 bug 相邻），是后续最容易再次写错的地方。建议：在 `queueScheduledTaskIds` 的注释里显式写明"该路径不参与收件箱来源透传"，或后续统一为一张 Map（键加 phase 区分）。

**建议-2：spec 夹具的运行期行为正确，但缺 `systemNotifyEnabled` 后门控覆盖不全**

BUG-2 修完后建议顺手在两个 spec 各补一条：偏好行 `systemNotifyEnabled=0` 时 `getPreferences()` 返回 `systemNotifyEnabled: false`（当前 30 个 case 完全没有覆盖这个字段的读路径，`:283/:295` 的 save 断言也没覆盖它）。

**建议-3：`recordTaskTerminal` 对 `executionId` 空值回落 `String(sessionId)` 使"重试产生新条目"的预期在该路径不成立**

`inbox.service.ts:99-105`：`tail` 取 `executionId`，空串/null 时回落 `String(input.sessionId)`。方案 4.2 口径认可 executionId 缺省属预期外路径，且 `finishExecution` 的 already-terminal 早退已挡住多数二次收敛，此处回落保证幂等而非缺陷。仅提示：该路径下"同一会话第一次 COMPLETED、崩溃恢复后又 COMPLETED"只会刷新不到标题（唯一键冲突即无操作）——与方案 108-111 行"崩溃恢复产生新条目"的表述在该特定缺参场景下不一致，文档已记录，维持现状可接受。

**建议-4：`useInboxSystemNotify` 的 `knownIds` 只取第一页，跨页新增条目不弹系统通知**

`useInboxSystemNotify.ts:84-95`：基线 = `inboxStore.visibleItems`（仅第一页 20 条）。若收件箱已有 100 条历史，随后第 3 页位置新增一条（第一页已满且不含该 id），`fresh` 仍能算出（因为 diff 是基于 id 集合而非页位置），但 `primeInboxSystemNotify(items)` 只播种第一页后，第二页的新增 id 在下一轮又被当成 fresh 重复弹一次。属通知层轻度重复，站内徽标与列表均正确（服务端权威未读数不受影响）。建议基线改为"未读数对应的 id 集合"或用服务端返回的 id 列表。

**建议-5：`InboxDrawer` 的 `watch(items) → primeInboxSystemNotify` 会让打开抽屉后不再弹系统通知**

`InboxDrawer.vue:65-68`：任何 items 变化都会把当前列表播种为已知。用户打开抽屉浏览期间来的新条目，在关闭抽屉前不会弹系统通知（因为已被播种）。这本身是合理行为（用户正在看），但若抽屉保持打开、用户切去别的应用，期间新条目将只进徽标不弹窗。与方案"窗口未聚焦即弹"的口径存在细微出入，属可接受取舍，建议在注释中显式记录。

---

## 附录 B：已核实不构成 BUG 的候选

以下为走读中重点核查、最终确认正确的点，列出以避免后续重复审查：

1. **`scheduled-task.service.ts:455` 本身传参正确**——第 6 参 `task.id ?? null` 确实传了；缺陷在 `create-app.ts:1171` 的 lambda（BUG-1）。
2. **`finishCancelledSession` 保持 5 参调用**（`streaming-ws-handler.ts:1846`）——CANCELLED 不写收件箱，`notifySource` 对该终态无意义，注释已说明，正确。
3. **`inbox.repository.ts` 全链路带 `user_id` 边界**（list/countUnread/markRead/markAllRead/deleteById/markReadByDedupKey/findByDedupKey/deleteHistory 的清理是全局但语义正确），无越权读取/修改。
4. **`insertIgnore` 的 `ON DUPLICATE KEY UPDATE id = id`**——保证插入即忽略、不刷新 created_at、不把已读打回未读，与方案要求一致；V131 的 `uk_notification_dedup` 唯一键存在。
5. **TASK_COMPLETED/FAILED 排除条件读 `session.sessionType`**（`task-terminal.service.ts:140-146` 的 `recordInbox` 内：phase 门禁 + SUBAGENT/SIDE_TASK + 微信 + 飞书 + ownerId=null），未用 `parentSessionId` 近似，CANCELLED 亦显式拦掉。
6. **`resolvePending` 与 `resolveApprovalPending` 各只挂一处**：提问三态统一收敛于 `tool-dispatcher.ts:386-390`（await waiting 之后）；审批四态收敛于 `local-tool-executor.ts:65-72`（finally 的 unregister 之后，无双触发）。
7. **SUBAGENT_DONE 只挂 DELIVERED 之后**：`background-subagent-manager.ts:358/:765/:898` 三处、`subagent-result-delivery.service.ts:185` 一处，SUPPRESSED 分支（`:345`、`:538`、`:872`）均不写，符合设计。
8. **未读数口径**：`inbox.service.ts` 每个写路径后都 `countUnread` + `registry.send`，`inbox_updated` 已入 `CRITICAL_EVENT_TYPES`（`streaming-ws-registry.ts:68`）；前端 `setUnreadCount` 只认服务端权威值、负数/NaN 归零，未本地累加。
9. **`V131` 建表含 `system_notify_enabled` 列**而非方案 4.1 说的 P2 再 ADD——方案正文状态行已声明为"实施偏差一处"，属已记录取舍。
10. **`InboxDrawer` 每次打开强制重拉**（`watch(visible)`）+ `InboxBell.onMounted` 拉一次 + `useStreamWS` onopen 重拉，三重兜底齐全。
11. **`recordInbox` / `recordInbox(fn)` 全链 fire-and-forget + 全吞异常**（task-terminal / tool-dispatcher / local-tool-executor / subagent 各处），不会因收件箱失败中断主链路。
12. **`InboxCleanupScheduler`** start/stop + stopped 门禁 + 异常全吞，90 天单条 DELETE 与方案一致。
13. **desktop 测试与类型**：`vue-tsc --noEmit` exit 0；inbox 相关 35 个单测全绿。
