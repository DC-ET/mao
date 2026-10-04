# 任务收件箱（站内通知中心）代码审查 — 第 2 轮

- 日期：2026-10-04
- 审查范围：git 工作区未提交改动（`git status` / `git diff --stat`，共 33 个 modified + 若干 untracked；diff 合计 +1786/-154），仅关注功能逻辑，不含产品/文档变更。
- 审查方式：只读审查，未修改任何源码，未执行部署。
- 上轮报告：`docs/code-review/2026-10-04-task-inbox-review-01.md`（untracked）。

## 1. 总体结论

**不建议合并。** 共发现 **2 个重要 bug**，无阻塞项。

第 1 轮的 1 个阻塞项（BUG-1）与 2 个重要项（BUG-2 / BUG-3）本轮复核均**已正确修复且未引入新问题**：
- BUG-1：`createScheduledLiveExecution` 工厂形参表与 `ScheduledLiveExecution` 一致，逐参转发；生产装配点 `create-app.ts:1171` 已切换；spec 以 `expect(live.length).toBe(6)` + 逐参 spy + 完整执行链断言 `finishExecution(..., 'SCHEDULED')` 构成回归防线。此处不再重提。
- BUG-2：两处偏好夹具与 `UserInboxPreferenceRow` / `savePreference` 夹具均已补齐 `systemNotifyEnabled`；实测 `npx tsc --noEmit` 在 `src/inbox/` 为 0 错误（仓内累计 371 处均为既有 spec 历史遗留，与本次改动无关）。
- BUG-3：store 初始 `preference` 已是完整 5 字段（去掉 `as InboxPreference`），`InboxBell.vue` onMounted 同时拉未读数与偏好；失败时保留初值，`fetchInboxPreference` 已有真实调用点。

本轮重新排查其余改动后确认 4 项建议已修复（建议-1/4/5 为真修复，建议-1 为注释），但发现 2 个第 1 轮未覆盖的新问题，均在「系统通知总开关」这条链路上：**一个让设置页开关形同虚设，一个让弹通知完全不读总开关**。二者叠加的后果是：用户明确关闭 Electron 系统通知后，系统通知仍会照常弹出。

## 2. 问题列表

### BUG-4【重要】`NotificationSettingsView.vue:84` 绑定契约里不存在的字段 `systemNotify`，「Electron 系统通知」开关不保存

**位置**：`desktop/src/views/settings/NotificationSettingsView.vue:82-89`

**问题**：开关的 `v-model` 绑的是 `inboxForm.systemNotify`，而 `inboxForm` 是 `reactive<InboxPreference>`，契约字段名是 `systemNotifyEnabled`（`shared/contracts/src/inbox.ts:42`）。整份 `InboxPreference` 里没有 `systemNotify` 这个字段。

**为何编译期不报错**：`inboxForm` 含 5 个声明字段 + 1 个 `systemNotify` 未声明字段。`v-model` 在模板里编译为字符串路径访问，`vue-tsc` 不会把模板 v-model 目标作为键检查 `reactive<T>`（模板类型检查不覆盖 `v-model` 的键级校验），因此 `npx vue-tsc --noEmit` 静默 exit 0（本轮已实测复核）。

**影响（可复现的功能缺陷）**：
1. `loadInboxPreference()` 用 `Object.assign(inboxForm, data)` 灌入服务端返回值，回写的键是 `systemNotifyEnabled`；`inboxForm.systemNotify` 从未被赋值，永远是初值 `undefined` → el-switch 显示为「不确定」的中间态（`inline-prompt` 下每次进设置页都是半关半开）。
2. 用户拨动该开关时改的是未声明的 `systemNotify`，`inboxDirty`（`:229`）只遍历 `InboxPreference` 的键做比较，**永远为 false** → 「保存收件箱设置」按钮始终 `disabled`，拨了也存不下去。
3. 即便绕过按钮，`handleSaveInboxPreference` 发送 `{ ...inboxForm }`，序列化后带的是 `systemNotify: true/false`，服务端 `readFlag(body.systemNotifyEnabled, ...)` 取不到该键，落库值恒为 current 的 `systemNotifyEnabled`（即白白发一次无变化请求）。

净效果：**「Electron 系统通知」这个总开关在设置页完全不可用**——既不能改，也不能保存。

**为何 E2E 没抓到**：`tests/desktop.spec.ts` 的 inbox 用例只断言了四个 kind 开关（`任务完成收件箱通知` 等）与初始 `toBeDisabled` 的保存按钮，未覆盖 `aria-label="Electron 系统通知"` 这个开关（该项被 `v-if="isElectronClient()"` 守卫，而 Playwright 桌面端不是 Electron，天然渲染不到）。

**修复建议**：
- `desktop/src/views/settings/NotificationSettingsView.vue:84`：`v-model="inboxForm.systemNotify"` 改为 `v-model="inboxForm.systemNotifyEnabled"`。
- 同步补一条 E2E / 单测断言：进设置页时该开关的 `aria-checked` 与后端返回值一致；拨动后 `保存收件箱设置` 按钮变为 enabled。若不想依赖 Electron 环境，可在单测里 mock `isElectronClient` 返回 true 后测 `inboxDirty` 与保存载荷。

### BUG-5【重要】`notifyInboxSystemUpdate` 从不读 `systemNotifyEnabled`，系统通知总开关对弹通知无效

**位置**：`desktop/src/composables/useInboxSystemNotify.ts:85-116`

**问题**：`notifyInboxSystemUpdate()` 在弹通知前只做了 4 道闸：`Notification` 存在、`permission !== 'denied'`、`isInboxNotifyWindowHidden()`、`requestPermissionOnce()`。随后只按 kind 过滤（`isInboxKindEnabled(item.kind, inboxStore.preference)`），**没有把 `inboxStore.preference.systemNotifyEnabled` 作为总闸**。

**影响**：用户在设置页关掉「Electron 系统通知」（总开关）后，一旦该值能成功持久化（见 BUG-4，修好后即可），系统通知仍会照常弹出——总开关形同虚设。这与 `shared/contracts/src/inbox.ts:41-42` 注释声明的语义（「Electron 系统通知总开关」）直接矛盾：现在只有 kind 级开关生效，总开关不拦截任何东西。

**为何第 1 轮未发现**：第 1 轮 `systemNotifyEnabled` 刚作为契约字段引入，当时的关注点是「spec 夹具缺字段导致 tsc 报错」与「store 初值缺字段」，尚未走到「这个总开关有没有被消费」这一层。

**为何现有单测没抓到**：`useInboxSystemNotify.test.ts` 的 `allOn` 夹具把 `systemNotifyEnabled` 写死为 `true`，没有任何一条用例置为 `false` 后断言「不弹」。同理 `seedList` 的默认 preference 也是全 true。

**修复建议**：在 `notifyInboxSystemUpdate()` 弹通知前加总闸（放在 `await requestPermissionOnce()` 之后即可，避免为不弹通知的用户发起权限申请）：

```ts
// 系统通知总开关：用户关闭后一律不弹（与 kind 级开关独立，二者都要过）
if (!inboxStore.preference.systemNotifyEnabled) return
```

注意：`inboxStore.preference` 在 `InboxBell.vue` onMounted 拉取失败时会停留在 store 初值（`systemNotifyEnabled: true`）。初值与后端列默认值一致，语义上「拉取失败 = 用默认（开）」，与 `fetchInboxPreference` 失败保留当前值的降级策略自洽，此处无需额外处理；但需注意该初值是用户未读到的偏好，属既有取舍，不构成新问题。

同时补一条回归用例：preference `systemNotifyEnabled: false` 时 `notifyInboxSystemUpdate()` 不产生任何 `Notification`。

## 3. 未发现功能 bug 的审查项（已核实）

以下内容本轮逐项读过并核对，未发现可触发功能 bug 的问题，故不计入第 2 节：

- **BUG-1 修复本身**（装配层工厂）：形参表、转发、`create-app.ts` 装配、spec 回归防线全部一致；`finishCancelledSession` 保持 5 参并有注释说明 CANCELLED 不写收件箱，语义自洽。
- **BUG-2 修复本身**：夹具补字段后 `tsc --noEmit` inbox 域 0 错误；新增的 `getPreferences 读取 systemNotifyEnabled：0 → false` 与 repository 侧五列 upsert 断言均真实覆盖第五列。
- **BUG-3 修复本身**：preference 初值 5 字段与后端 `DEFAULT_PREFERENCE` 一致；`fetchInboxPreference` 现已有 InboxBell 挂载触发。
- **建议-1**（`queueScheduledTaskIds` 注释）：纯注释变更，明确 busy 路径不参与收件箱来源透传、收件箱只读 `scheduledTaskIds`，与实际实现一致。
- **建议-4**（跨页重复弹）：`notifiedIds` 为模块级单调累积集合，`unseen = fresh.filter(!notifiedIds.has)`，弹前写入，`resetInboxSystemNotifyForTest` 一并重置；新增用例「跨页新增不会被重复弹」命中该语义。集合无上限增长，但元素是收件箱条目 id（有 90 天清理兜底），量级有限，不构成 bug。登出不清空属已知取舍（登出走 router replace 不刷新页面，模块级状态存活）；由于 id 单调且新用户条目不会复用旧 id，不会造成跨用户误抑制弹窗，也不构成功能 bug。
- **建议-5**（`InboxDrawer.vue` watch 播种注释）：纯注释变更，逻辑未动。
- **收件箱写入点条件**：`task-terminal.service.ts` 的 `recordInbox` 仍只读 `session.sessionType`（不用 `parentSessionId` 近似，覆盖 SIDE_TASK 提升边界），CANCELLED 显式拦，微信/飞书/未知用户均排除，`notificationExecutor` 只包 recorder 调用且内部全吞异常（异步路径不会同步抛）；`dispatchMemoryExtraction` 与它同构，事件链不被收件箱副作用打断。
- **SUBAGENT_DONE 写入点**：`background-subagent-manager.ts` 三处（`onCompleted` DELIVERED 后、`completeRetry` DELIVERED 后、`failExecution` DELIVERED 后）与 `subagent-result-delivery.service.ts` 的 `deliverBackground` 均只在 `deliveryStatus = DELIVERED` 之后触发；SUPPRESSED 分支不写；同步 delegate 路径不挂 `recordSubagentDone`；三者均 fire-and-forget + 全吞异常。
- **待办联动置已读**：`tool-dispatcher.ts` 的 `resolvePending` 只挂一处（`waitForAnswer` 收敛处，覆盖回答/取消/超时三态），判定读结构化标记而非解析 resultJson；`local-tool-executor.ts` 的 `resolveApprovalPending` 只挂 finally 一处，`handleToolApproval` 的 unregister 不重复挂点，无双触发。
- **`inbox_updated` 关键帧**：确已加入 `CRITICAL_EVENT_TYPES`，`enqueueItem` 据此走不受 capacity 限制的关键队列。
- **WS 前端消费**：`useStreamWS.ts` 的 `inbox_updated` 分支只写 `setUnreadCount`（不本地累加）并在 Electron 下调 `notifyInboxSystemUpdate`；onopen 重拉未读数刻意不放进 `focusLoaded` 分支。
- **迁移与清理**：V131 两表结构与列默认值和 service 侧口径一致；`InboxCleanupScheduler` 的 90 天 cutoff、单条 DELETE、stop 门禁均正确。
- **其他**：`main.cjs` 补 `app.setAppUserModelId` 与 package.json 的 appId 一致；`inbox.routes.ts` 的 `readFlag` 对布尔缺失回落当前值，不会把旧偏好抹平成默认值。

## 4. 本轮已运行的验证（复核）

- `cd backend-ts && npx vitest run src/inbox src/session/ws/streaming-ws-handler.spec.ts src/session/task-terminal.service.spec.ts src/schedule/scheduled-task.service.spec.ts src/harness/delegate/background-subagent-manager.spec.ts src/harness/delegate/subagent-result-delivery.service.spec.ts src/harness/local/local-tool-executor.spec.ts src/harness/tool/tool-dispatcher.spec.ts` → **10 files / 246 passed**
- `cd backend-ts && npx tsc --noEmit` → exit 2，`src/inbox/` **0 错误**，累计 371 处均为仓内既有 spec 历史遗留（与本次改动无关）
- `cd desktop && npx vue-tsc --noEmit` → exit 0（注意：此退出码不能证明 BUG-4 不存在，原因见 BUG-4 说明）

> 备注：BUG-4 与 BUG-5 都是「测试没有覆盖到的行为」，而非「测试断言失败」。现有测试全绿与这两个 bug 并存，这说明问题不在被测代码的正确性，而在**用例没有触达这两个交互点**。修复时建议同时补上面两条断言。
