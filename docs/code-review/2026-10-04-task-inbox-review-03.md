# 任务收件箱（站内通知中心）代码审查 — 第 3 轮

- **日期**：2026-10-04
- **基线**：git 工作区未提交改动（`git status` 实测 33 modified + 若干 untracked；相对第 2 轮的增量仅 `desktop/src/views/settings/NotificationSettingsView.vue` +`tests/desktop.spec.ts`，后端未变动）。
- **审查方式**：只读审查，未修改任何源码，未执行部署。除通读外，另做了 2 项**可复现的集成层时序验证**（详见 BUG-6）：用真实 Vue 反应式跑「真实调用链」而非模块单元替身，暴露出一条前两轮未触达的链路。
- **上轮报告**：`docs/code-review/2026-10-04-task-inbox-review-02.md`（untracked）。

## 1. 总体结论

**不建议合并。** 本轮发现 **1 个重要 bug（BUG-6，系统通知在真实运行链路下永不触发）**，无阻塞项。

第 2 轮的 BUG-4 / BUG-5 本轮逐行复核，**两个修复均正确且未引入新问题**；测试补强也确实把此前触达不到的链路纳入了防线（见第 3 节）。但第 2 轮报告断言「建议-4 / 建议-5 属既有取舍、不构成 bug」这一条**现在是错判**：在那两处「看起来很克制」的取舍叠加后，系统通知这条链路在当前代码下**不会弹出**，属可复现的功能缺陷。原因与证据见 BUG-6。

本轮未在第 1 轮已确认的正确项、以及前两轮已明确的非 bug 候选点上发现新反证（逐条复核列表见第 3 节）。

## 2. 问题列表

### BUG-6【重要】`notifyInboxSystemUpdate` 里 `await fetchList()` 触发抽屉 watcher 先播种基线，使 diff 恒为空 → 系统通知在真实链路下永不触发

**位置（三处耦合，都必需才触发）**

- `desktop/src/components/inbox/InboxDrawer.vue:63-68`

  ```ts
  watch(
    () => inboxStore.items,
    (items) => primeInboxSystemNotify(items),
    { deep: true },
  )
  ```

- `desktop/src/composables/useInboxSystemNotify.ts:93-97`

  ```ts
  await inboxStore.fetchList()          // ← 内部会写 store.items
  const items = inboxStore.visibleItems
  if (!primed) { primeInboxSystemNotify(items); return }
  ```

- `desktop/src/stores/inbox/index.ts:80`（`fetchList` → `applyPage(result, 1)` → `this.items = result.records`，数组引用整体替换）

**问题**

`InboxDrawer` 挂在 `TopNav` 上、和顶层布局同生命周期，**从进入应用起 watcher 就一直在监听 `inboxStore.items`**（并不需要用户打开抽屉）。`notifyInboxSystemUpdate()` 为了 diff 出「新增条目」，第一件事是 `await inboxStore.fetchList()`，而 `fetchList` 会把后端返回的整页**整体赋值**给 `store.items`。对 Vue 的 `watch(() => items, …)` 来说是引用变化 → 在 `await` 之后同步 flush → **`primeInboxSystemNotify(items)` 先把这刚拉到的整页播种进 `knownIds`**。等控制权回到 `notifyInboxSystemUpdate`，`fresh = items.filter(i => !knownIds.has(i.id))` 拿到的是一份「刚刚被自己人播种过的全集」，**恒为空数组**，于是：

- `if (unseen.length === 0) return`（`:106`）直接返回；
- 随后那段 `systemNotifyEnabled` 总闸（本轮 BUG-5 的修复）与 kind 过滤、`new Notification(...)` **永远走不到**。

净效果：**用户无论怎么配（含默认全开），Electron 窗口失焦时一条系统通知都不会弹**。整个 P2 特性处于「代码全在、开关全在、单测全绿，但实际零触发」状态。

**为何 BUG-5 修复本身仍值得保留**：`systemNotifyEnabled` 总闸语义正确，BUG-6 修好后它立刻生效（否则修好 BUG-6 会让总开关形同虚设）。二者是「先有通道错、再有闸门对」的关系，不是重复问题。

**为何三层防线都没抓到**

1. **单测**：`useInboxSystemNotify.test.ts` 的 `seedList()` 直接调 `store.fetchList()` 后**显式补一刀 `primeInboxSystemNotify(store.visibleItems)`**（`inbox.test` 同样只有 store 层），测试里**根本没有 Vue watcher**——它测的是「基线已建立之后的 diff 逻辑」，而 bug 恰恰在「基线被谁建立、何时建立」这个集成时序上。`vitest` 环境 `environment: 'node'`，没有组件渲染，watcher 天然缺席。
2. **E2E**：`tests/desktop.spec.ts` 的 inbox 5 条用例全部断言徽标 / 抽屉渲染 / 设置页开关，**没有任何用例断言过「系统通知弹出」**（真实 Electron 环境下 `Notification` 才会生效，Playwright 桌面工程里即使种了 `electronAPI` 替身也不会弹）。加上 `isElectronClient()` 替身只让设置页多渲染一个开关，不改变 `notifyInboxSystemUpdate` 的调用链。
3. **类型 / 构建**：纯运行时时序，`vue-tsc` / `tsc` / `build` 全部静默 exit 0。

**可复现证据（本轮实测）**

我在 `desktop/` 下写了两份临时 vitest 文件（**跑完已删除，工作区已还原**，`git status` 与审查前一致），用真实 `watch(() => store.items, …)` 复刻 `InboxDrawer.vue:63-68`：

- 实验组（挂上 drawer watcher，其余与现有单测同构）：

  ```
  await store.fetchList()                      // 复制「打开一次抽屉」
  await nextTick()                             // watcher 播种 knownIds = {1,2}
  mockFetchList → {id:1,2,3,4}
  await notifyInboxSystemUpdate()
  → AssertionError: expected [] to deeply equal [ '任务 3', '任务 4' ]
  ```

- 对照组（不挂 watcher，让 `notifyInboxSystemUpdate` 自己首次播种）：

  ```
  → 1 passed（'基线由 notifyInboxSystemUpdate 自己播种后，新增条目能弹通知'）
  ```

两组唯一的差异就是 `InboxDrawer` 那个 watcher，可直接定位因果。

另用真实 Vue 反应式脚本做了人工时序推演，同样结果：

```
[drawer watcher] primed: 1,2,3
[notify] fresh =          ← 空
```

另外两条确信服路径（即使从未打开抽屉）：
- `useStreamWS` onopen 的 `fetchUnreadCount()` 不写 `items`，但首次 `inbox_updated` → `notifyInboxSystemUpdate()` → 内部 `fetchList()` 写 `items` → watcher 播种 → 该轮按 `!primed` 直接 return；下一轮真实新增到来了，`knownIds` 已被上一轮播种，`fresh` 依旧为空。**照样不弹。**

**修复建议（择一，都不要改 `primeInboxSystemNotify` 的语义）**

- 方案 A（推荐，改动最小、语义最清楚）：把「打开抽屉播种」与「系统通知 diff」分成两套基线。`notifyInboxSystemUpdate` 内部改用**不写入 `store.items` 的独立请求**读一页用于 diff（例如给 inbox store / api 加一个轻量 `peekInboxFirstPage()`，只返回数据不触达响应式 state），`InboxDrawer` 的 watcher 继续只服务于「用户正在看」的抑制语义。这样 diff 的数据源与播种器互不干扰。
- 方案 B：让 `InboxDrawer.vue:63-68` 的播种只在**抽屉确实开着**时生效（`watch([() => props.modelValue, () => inboxStore.items])`，关闭后不播种），保证 `notifyInboxSystemUpdate` 内部 `fetchList` 的播种不会抢在它自己前面；同时 `notifyInboxSystemUpdate` 里把 `await inboxStore.fetchList()` 换成「先算旧基线、再刷新、再 diff」的顺序（先快照 `knownIds`，`await` 之后再读 `items` 并用快照做差集）。

无论选哪个方案，都必须补一条**集成级**回归用例：挂上 `InboxDrawer` 的真实 watcher 后，断言 `notifyInboxSystemUpdate()` 能对新增条目产生 `Notification`（即本轮两份临时实验里的实验组断言）。现有 `useInboxSystemNotify.test.ts` 的 `seedList()` 需要剥离「手动 prime」这一步，否则它永远测不到这条时序。

## 3. 本轮已复核项

### 3.1 前两轮修复的正确性（本轮重点）

- **BUG-4 修复正确**：`NotificationSettingsView.vue:84` 已为 `v-model="inboxForm.systemNotifyEnabled"`，与 `shared/contracts/src/inbox.ts:42` 一致；`inboxDirty` 遍历 5 键（`:229-233`）能感知该开关；`Object.assign(inboxSaved/inboxForm, data)` 回填键名正确；PUT 载荷为 `{ ...inboxForm }`，服务端 `inbox.routes.ts:99` 的 `readFlag(body.systemNotifyEnabled, …)` 能读到。
- **BUG-5 修复正确**：`useInboxSystemNotify.ts:107-112` 总闸位置与注释描述一致（在 `requestPermissionOnce` 之后、`notifiedIds` 记账之后、kind 过滤之前）；`resetInboxSystemNotifyForTest()` 仍一并重置三态；单测反例「系统通知总开关关闭时不弹」（`useInboxSystemNotify.test.ts:228-239`）断言 `created` 长度为 0，真实有效。
- **测试补强成立**：`tests/desktop.spec.ts` 的 `electron` 选项通过 `addInitScript` 种 `window.electronAPI` 替身，`isElectronClient()`（`desktop/src/utils/platform.ts:5-7`）为真；`.el-switch:has(input[aria-label="Electron 系统通知"])` 从 Element Plus 编译产物结构看成立（input 是 `.el-switch` 的子元素），比原 `.filter({ has: … })` 写法更稳；新 E2E 断言了 `aria-checked=false` 回填、初始 disabled、拨动后 enabled、PUT 载荷含 `systemNotifyEnabled: true`。`mockInboxApi` 的默认 preference（前三开、子代理关、系统通知开）与后端 `DEFAULT_PREFERENCE`（`inbox.service.ts:52-58`）一致。PUT 路由后注册覆盖实现，`savedPayload` fallback 仅在未捕获 PUT 时兜底，不产生假阳性。

### 3.2 逐行复核、未发现新问题的点

- 后端链路：`V131` 两表与列默认值、`insertIgnore` 的唯一键幂等、`user_id` 边界、`markReadByDedupKey` 的等值匹配、`readFlag` 的缺失回落、`getPreferences/savePreferences` 五列读写、`InboxCleanupScheduler` 的 90 天清理与 stop 门禁。
- 写入点门控：`task-terminal.service.ts` 的 `recordInbox` 排除条件（SUBAGENT / SIDE_TASK / CANCELLED / 微信 / 飞书 / unknown user）、`tool-dispatcher.ts` 的 `resolvePending` 单挂点、`local-tool-executor.ts` 的 `resolveApprovalPending` 单挂点、四处 SUBAGENT_DONE 只在 DELIVERED 后写；全部 fire-and-forget + 全吞异常，不阻断主链路。
- 来源透传（第 1 轮 BUG-1 修复）：`createScheduledLiveExecution` 工厂、`create-app.ts:1171` 装配、`scheduledTaskIds` 在早退前登记并在 `takePendingCancel` 命中时按归属清理、`finishExecution(..., 'SCHEDULED')` 的传参均一致。
- 前端其余 inbox 链路：`useStreamWS` 的 `inbox_updated` 分支只写权威未读数不本地累加、onopen 重拉刻意不依赖 `focusLoaded`；`InboxBell` 首次挂载同时拉未读数与偏好；store 初始 preference 五字段且与后端默认值一致；`CRITICAL_EVENT_TYPES` 已含 `inbox_updated`。
- 本轮 diff 中新增的 `useStreamWS.test.ts` 两条用例（非 Electron 不触发系统通知、onopen 重拉未读数）与其 mock 的 inbox API 五字段偏好均正确，无副作用。

### 3.3 前两轮已确认「非 bug」的候选点（无新反证）

`notifiedIds` 无上限增长、登出不清空模块级基线、`recordTaskTerminal` 对空 executionId 回落 `sessionId`、`dispatchMemoryExtraction` 与 `recordInbox` 同构、SUBAGENT_DONE 只在 DELIVERED 后写、busy 入队路径不参与来源透传（有注释）、`finishCancelledSession` 保持 5 参——本轮逐条复核均无新反证，不重提。

> 注：第 2 轮的「建议-4 / 建议-5 属可接受取舍」**本轮被 BUG-6 推翻**，此处不再作为非 bug 项引用。

## 4. 本轮已运行的验证（只读，未改源码）

- `cd desktop && npx vitest run src/composables/useInboxSystemNotify.test.ts src/stores/inbox/inbox.test.ts src/composables/useStreamWS.test.ts` → **3 files / 37 passed**（现有单测全绿，但正因如此才说明它们没触达 BUG-6 的集成时序）
- 集成层时序复现实验（临时文件，已删除）：实验组 **1 failed**（`expected [] to deeply equal ['任务 3','任务 4']`）/ 对照组 **1 passed** → 确认 BUG-6 的因果与 `InboxDrawer` watcher 直接相关
- `git status` 复核：与审查前完全一致（33 modified + 原 untracked），无临时残留
