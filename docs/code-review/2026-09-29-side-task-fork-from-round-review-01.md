# 代码审查报告：边路任务按轮分叉（Fork from Round）未提交改动

- **审查日期**：2026-09-29（第二轮复审同日，见文末「复审记录」）
- **修复状态**：BUG-1 / BUG-2 已修复，NOTE-1 已按建议清理；第二轮复审结论为**无新增问题**（详见文末复审记录）。
- **审查对象**：当前 Git 工作区未提交改动（对应方案 `docs/plan/2026-09-29-side-task-fork-from-round-technical-design.md`）
- **审查范围**：后端 `backend-ts/src/harness/core/harness-service.ts`、`session/ws/streaming-ws-handler.ts`、`session/session.service.ts`、`session/session.repository.ts`、`session/session-title.service.ts`；前端 `desktop/src`（`components/chat/*`、`components/center/*`、`composables/useCenterTabs.ts`、`composables/useStreamWS.ts`、`types/file-browser.ts`、`utils/internalMarkers.ts`、`views/task/TaskView.vue`）及各自 spec。**只审功能逻辑，不审样式与文档**；本次仅审查、未改代码。
- **审查方法**：先读方案固化复制矩阵与校验时序，再逐文件对照 diff 与周边源码（`session-compaction.repository/service`、`promoteSideTaskToMainSession`、`subagent-result-delivery`、`useMessageRounds`、`MessageBubble` footer 门槛、`CenterTabContainer` KeepAlive 结构），并跑通后端 / 前端单测与类型检查复核结论。

## 结论

发现 **2 个会影响业务功能的问题**（1 中 / 1 低）和 1 处代码卫生问题。方案的核心设计点——复制矩阵三种情形、压缩记录与事件「同进同退」、`messageIdMap` 重映射、切点校验时序（先校验后建会话、失败无副作用）、标题判据回归面、`forkFromMessageId` 非法值兜底——已逐条核对，**未发现正确性问题**（明细见「已核查确认无问题的关键点」）。

| 编号 | 严重程度 | 问题 | 位置 |
| --- | --- | --- | --- |
| BUG-1 | 中 | 从左侧任务栏 / 检查器重新打开已分叉的边路任务时，Tab 的分叉来源（hover）被清掉 | `useCenterTabs.ts:210-220`、`TaskView.vue:548-550` |
| BUG-2 | 低 | 边路任务创建被拒后，`side_session_created` 监听与 `user_message_saved` 回调最长残留 60s，可能误清其他面板输入框 | `SideChatPanel.vue:786-877` |
| NOTE-1 | 提示（非 BUG） | 两处查询方法在本改动后没有生产调用方（死代码） | `session.service.ts:887-889`、`session.repository.ts:342-348` |

---

## BUG-1 [中] 重新打开已分叉的边路任务时，Tab 的分叉来源被清掉

**位置**

- `desktop/src/composables/useCenterTabs.ts:210-220` — `openSideTaskTab` 复用分支：
  ```ts
  const existing = findSideTaskTab(state, sideSessionId)
  if (existing) {
    existing.contextMode = opts.contextMode ?? 'none'   // L215
    existing.forkFrom = opts.fork ?? undefined          // L216
    state.activeTabId = existing.id
    ...
  ```
- `desktop/src/views/task/TaskView.vue:548-550` — `handleOpenSideTask` 无条件走上述覆写路径：
  ```ts
  function handleOpenSideTask(payload: { sideSessionId: number; title: string }) {
    openSideTaskTab(payload.sideSessionId, payload.title)   // 不传 opts → contextMode 'none'、forkFrom undefined
  }
  ```
- 触发入口：`desktop/src/components/task/SideTaskList.vue:150`、`desktop/src/components/task/TaskInspector.vue:150`（`open-side-task`，均传真实 `sideSessionId`）。

**现象 / 触发场景**

1. 在主会话点某一轮助手回复的 fork 图标 → 占位 Tab 写入 `contextMode='fork'` 与 `forkFrom`；
2. 发送首条消息 → 后端复制成功 → `side_session_created` → `updateSideTaskTab` 把 `tab.sideSessionId` 改成正数（**不改 tab.id**），`forkFrom` 按设计保留，Tab hover 显示「分叉自主会话 · {时间} · {摘录}」；
3. 用户在左侧任务栏（或任务检查器）里点这个边路任务，想再切回去看 → `handleOpenSideTask(真实 id)` → `findSideTaskTab` 按 `t.sideSessionId === sideSessionId` 命中该 Tab → 走复用分支 → **`existing.forkFrom = undefined`**；
4. 结果：Tab hover 的分叉来源消失，需求 2.7「分叉来源可见」在该路径上失效，直到用户再点一次 fork 图标（且那时只会新建占位 Tab，不会恢复旧 Tab 的来源）。

**问题分析**

复用分支的「整体覆写」语义只对**占位 Tab** 成立（普通入口复用占位 Tab 时清掉上一次入口的 fork/summary 残留，`useCenterTabs.test.ts` 两条用例覆盖的正是这个语义）。但 `findSideTaskTab` 同时会按 `sideSessionId` 命中**已创建的真实会话 Tab**，此时覆写就把纯展示字段 `forkFrom` 清了。`contextMode` 被重置是改动前就有的行为（会话已创建后该字段无实际作用，`SideChatPanel` 的 watch 有 `hasRealSession` 守卫），本次新增的 `forkFrom` 覆写是新引入的回归。

**建议修法**

复用分支区分「已存在 Tab 仍是占位」与「已是真实会话」，只给占位 Tab 做整体覆写：

```ts
if (existing) {
  // 仅占位 Tab 需要覆写入口预置；真实会话 Tab 只激活 + 更新标题，
  // 否则会把分叉来源（forkFrom）等展示信息清掉
  if (existing.sideSessionId == null || existing.sideSessionId <= 0) {
    existing.contextMode = opts.contextMode ?? 'none'
    existing.forkFrom = opts.fork ?? undefined
  }
  state.activeTabId = existing.id
  notifyTabsChanged()
  return
}
```

该改法与现有两条「普通入口复用占位 Tab 重置」用例不冲突（它们用的都是占位 id）。若希望真实会话 Tab 的标题也刷新，可在分支内补 `existing.title = normalizeSideTaskTitle(title)`。

---

## BUG-2 [低] 创建被拒后监听 / 回调最长残留 60 秒，可能误清其他面板输入框

**位置**

- `desktop/src/components/chat/SideChatPanel.vue:786-800` — 被拒处理器只回滚，不走统一 cleanup：
  ```ts
  const onSideRejected = (e: Event) => {
    const detail = (e as CustomEvent).detail
    if (detail?.parentSessionId != null && String(detail.parentSessionId) !== parentSessionId) return
    rollbackOptimisticMessages(placeholderCacheKey.value, optimisticUserId)
    waitingForSave.value = false
    releaseSendLock()
    ElMessage.error(detail?.message || '边路任务创建失败，请重试')
    // 未调用 removeSideCreatedListener?.()：onSideCreated 监听继续挂着
  }
  ```
- `desktop/src/components/chat/SideChatPanel.vue:802-877` — `await createSideSession(...)` 返回后注册的 `onMessageSaved` 回调（L870）、`pendingSendCleanup`（L875）与 60s 超时（L877），唯一清理出口是 `finishWaiting(false)`。
- `desktop/src/composables/useStreamWS.ts:1029-1034` — `error` 带 `code: 'side_session_rejected'` 时派发 window 事件并 `break`（不再走 FAILED 收敛）。

**现象 / 触发场景**

1. 占位 Tab 首次发送被拒（切点失效 / 模型不支持图片 / 本地端未连接）：乐观 user + assistant 占位被正确回滚、`waitingForSave` 与发送互斥锁被正确释放、父会话不会被标 FAILED（这三点已核实无误）；
2. 但同一次发送注册的 `onSideCreated`（L753-759）没有注销，`onMessageSaved` / 60s 定时器也进入「等一个永远不会来的 `user_message_saved`」状态；
3. 被拒后 60 秒内，若用户在**别处**（同父会话的另一个边路面板，或切换到其他主会话后新开的边路任务）成功创建边路任务：`side_session_created` 会命中本面板残留的 `onSideCreated`——它只判断 `realSessionId.value > 0`，**不校验 `detail.parentSessionId`**——把 `expectedSavedSessionId` 写成别人的 `sideSessionId`；
4. 随后那个会话的 `user_message_saved` 触发本面板的 `finishWaiting(true)` → `chatInputRef.clearInput()` + 清草稿 → **本面板输入框里正在编辑的内容被清掉**（面板此时可能已被 KeepAlive 缓存，用户并不在现场）。

**问题分析**

影响面窄（需要「被拒后 60s 内又在别处成功开出边路任务」且本面板未卸载），但属于明确的状态残留：被拒路径与成功路径的监听生命周期不一致。同一面板内的「被拒后立即重试」路径无害（重试会再注册一套，旧监听只是重复触发一次幂等的 `finishWaiting`），问题只出在跨面板 / 跨会话误触发。

**建议修法**

把本次发送涉及的监听与回调收拢成一个 cleanup，在被拒、`!created`、catch、`finishWaiting`、`onUnmounted` 各处统一调用；同时给 `onSideCreated` 补上与 `onSideRejected` 一致的父会话过滤：

```ts
const cleanupSideListeners = () => {
  removeSideCreatedListener?.()      // 内部已包含 removeSideRejectedListener
  offMessageSaved(callbackId)
  clearTimeout(saveTimeoutId)
}
// onSideRejected 末尾、finishWaiting 末尾各调一次；onSideCreated 内加：
// if (detail?.parentSessionId != null && String(detail.parentSessionId) !== parentSessionId) return
```

注意 `onSideRejected` 定义在 `removeSideCreatedListener` 被重新赋值（L796-800）之前，但它闭包引用的是同一个 `let` 变量，直接调用取到的是包装后的版本，两个监听都会被移除；若追求可读性，可先把 cleanup 变量声明提前。

---

## NOTE-1 [提示，非 BUG] 两处查询方法没有生产调用方

- `backend-ts/src/session/session.service.ts:887-889` — `SessionService.hasOwnEarlierUserMessage` 包装在生产代码中无调用方（标题服务 `session-title.service.ts:69` 直接用自己注入的 `messageRepo.hasOwnEarlierUserMessage`），只有 `session.service.spec.ts` 在用。
- `backend-ts/src/session/session.repository.ts:342-348` — `MessageRepository.hasEarlierUserMessage` 在本改动后同样只剩 spec 引用（标题判定已全部切换到 `hasOwnEarlierUserMessage`）。

不影响功能。建议二选一：删掉 `SessionService` 上的包装（标题服务本就直连 repo），或让标题服务改走 `sessionService` 门面（与 `findOwnedMessage` 的用法保持一致）；旧 repo 方法若确认无后续规划可一并删除，避免两套判据长期并存被误用。

---

## 已核查确认无问题的关键点

以下为本次重点核对、结论为「实现与方案一致」的设计点，列出核对依据以备复盘：

1. **复制矩阵三种情形**（`harness-service.ts:594-705`）
   - 切点为 null：SQL 与改动前一字不差（无 `id <= ?`），消息 / file_change / 压缩记录全量复制，压缩事件为新增复制，行为符合方案「仅新增事件复制」。
   - 切点 ≥ 当前边界：消息 `id <= 切点`；`mappedBoundary != null` 才插压缩记录（L662-665），边界消息必在复制集合内（压缩 CAS 只认 `deleted = 0` 的消息，且边界 id ≤ 切点），模型上下文 = 摘要 + 边界后至切点原文。
   - 切点 < 当前边界：`mappedBoundary` 为 null → 压缩记录与事件**都不复制**（事件循环在 `if (compaction != null && mappedBoundary != null)` 内，L665-703），「同进同退」被严格遵守；边路任务从第一条消息起为原始历史，符合决策 2/3。
2. **`messageIdMap` 重映射无遗漏**：消息、file_change（L631-653）、压缩记录边界（L669）、压缩事件 `boundary_msg_id` 与 `prev_boundary_msg_id`（L683-687）全部经同一 map；未命中 map 的事件整行跳过，`prev` 为 0 或映射不到时回落 0（该字段前端仅透传不展示，无功能影响）。事件排序沿用 repo 既有约定 `boundary_msg_id ASC, id ASC`，链序保持。
3. **切点校验时序与副作用**（`streaming-ws-handler.ts:807-863`）：`forkFromMessageId` 仅接受正整数（NaN / 0 / 负数 / 非数字 / 小数一律按 null 走全量分叉，spec 已覆盖 -3 用例）；校验在 `save(sideSession)`（L851）之前，失败只回一条带 `code: 'side_session_rejected'` 的 error（sessionId 为父会话）并 return——不建会话、不发 `side_session_created`、不调 `forkParentMessages`，spec 已断言这三点；`side_session_created` 依旧在 `forkParentMessages` 之前发（复制可能很久，先交 id 给客户端的既有取舍不变），复制在落边路首问之前，保证首问 id 大于全部历史消息、不被压缩边界整段排除。
4. **乐观消息回滚正确性**：`rollbackOptimisticMessages`（`SideChatPanel.vue:924-933`）按 `prev.id === optimisticUserId` 精确回滚 user + 空 assistant 占位，不会误删他人消息；`waitingForSave`、发送互斥锁（`sending`）在驳回路径均被释放，重试只能发生在驳回之后（锁释放前 `handleChatSend` 直接 return），不存在并发双发。
5. **Tab 级 forkFrom / contextMode 生命周期**：`setSideTaskFork` 原子覆写两字段（`useCenterTabs.ts:235-242`）；`updateSideTaskTab` 不改 `tab.id`（L274-286），KeepAlive 下面板不重挂载；`restoreSideTaskTabs`（L316-341）只更新 `sideSessionId`/`title`，不会清 `forkFrom`；面板重新挂载时 `parseCutPoint(props.forkFromMessageId)` 能从 props 取回（`SideChatPanel.vue:187-199`）；watch 有 `hasRealSession` 守卫，会话创建后入口再改预置不影响已开始的执行。
6. **标题判据改动回归面**：`hasOwnEarlierUserMessage` 判据为 `role='USER' AND source_session_id IS NULL`（`session.repository.ts:354-361`）。普通会话用户消息该字段为空 → 行为不变；子代理结果投递写入的是 ASSISTANT / TOOL 角色（`subagent-result-delivery.service.ts:109,155`）→ 不进本判定；promote 后的会话复制消息均带 `sourceSessionId`（`session.service.ts:609`）→ 不会被误判为首条，且 `updateTitleIfPlaceholder` 只在标题仍是占位符时覆盖，不会冲掉用户已改的标题。
7. **fork 入口与切点取值**：fork 按钮在 `message-footer` 内（`MessageBubble.vue:123,185`），要求 `message.content` 非空、非流式、非编辑态；轮次折叠态下只有 `finalReply` 拿到 `show-copy` 默认 true（`ChatRoundList.vue:63-72,87-96`），折叠步骤 / 执行中轮次 / 无轮次直铺分支均为 `show-copy=false` → 入口只出现在「已完成轮次的最终回复」上，与切点定义天然对齐；轮次最后一条是空文本工具消息时无 footer，该轮不出现入口（方案 2.1 已明确的边界）。`handleFork` 按 `finalReply.id` 反查 round 并组装 label（时间 + 剥离内部标记后前 12 字），`stripInternalMarkers` 抽到 `utils/internalMarkers.ts` 后两处共用同一实现。
8. **父会话不被误标 FAILED**：`useStreamWS.ts:1029-1034` 对 `side_session_rejected` 只派发 window 事件并 `break`，不走 `setExecutionError` / `updateSessionPhase('FAILED')`；`error` 帧走关键帧队列（`CRITICAL_EVENT_TYPES` 含 `error`）不会被普通队列丢弃，客户端必然收到。

## 验证记录

- `cd backend-ts && npm test`：219 个测试文件通过 / 1 跳过，2350 个用例通过 / 13 跳过（含本次新增的复制矩阵四例、切点非法 / 合法 / 畸形三例、标题与归属查询用例）。
- `cd desktop && npx vitest run`：17 个文件 / 197 个用例通过（含 `useCenterTabs` 切点预置 / 重置 / 原子覆写、`useStreamWS` 切点下发与被拒事件）。
- `cd desktop && npx vue-tsc --noEmit -p tsconfig.app.json`：无错误。

## 备注（非 BUG，记录以免重复排查）

- **多模态用户消息的 label 摘录**：`forkLabelOf`（`ChatRoundList.vue:238-245`）直接对 `userMessage.content` 做剥离，带图消息的 content 可能是 JSON 结构，hover 摘录会出现 JSON 片段。与复制按钮（`copyMessage`）同源的老行为，仅影响 hover 文案美观，不影响功能。
- **tooltip 文案**：实现为 `分叉自主会话 · {label}`，方案写的是 `"{摘录}"` 带引号，纯文案差异。
- **刷新后来源丢失**：`forkFrom` 是 Tab 级内存字段、不落库，页面刷新后 `restoreSideTaskTabs` 重建的 Tab 没有来源信息，hover 不再显示。这是方案「切点靠消息 ID 表达、不新增列」的既定取舍，非缺陷。

---

# 复审记录（2026-09-29 第二轮：修复复核）

**复审方法**：重新 `git diff` 未提交改动，对照首轮报告三条结论逐项复核；后端 `harness-service.ts` / `streaming-ws-handler.ts` 经抽查确认本轮未被触碰（复制矩阵与切点校验维持首轮已核对的实现），改动集中在 `useCenterTabs.ts`、`SideChatPanel.vue`、`session.service.ts` / `session.repository.ts` 及各自 spec。

## 一、BUG-1 修复复核：通过

`openSideTaskTab` 复用分支（`useCenterTabs.ts:213-220`）现在只在 `existing.sideSessionId == null || existing.sideSessionId <= 0`（占位 Tab）时整体覆写 opts，真实会话 Tab 只激活。逐一核对其它调用路径：

| 调用路径 | 是否清 forkFrom / contextMode | 结论 |
| --- | --- | --- |
| `openSideTaskTab` 复用分支（真实会话，来自 `handleOpenSideTask`） | 否（本次修复点） | 修复生效 |
| `openSideTaskTab` 新 Tab 分支 | 只写不删，`forkFrom` 仅在有 opts.fork 时写入 | 无回归 |
| `openSideTaskTabFor`（顶部搜索入口，`useCenterTabs.ts:24-45`） | 只更新 title + 激活，从不碰 contextMode / forkFrom | 无回归（该函数本就只接受真实 id） |
| `restoreSideTaskTabs`（`useCenterTabs.ts:316-341`） | 已有 Tab 只更新 `sideSessionId` / title；新 Tab 不带 forkFrom | 无回归 |
| `handleOpenSideTask` → `openSideTaskTab(真实 id)`（`TaskView.vue:548-550`，左侧 `SideTaskList` / `TaskInspector` 入口） | 走进修复后的复用分支，不再覆写 | 修复生效 |
| `handleNewSideTask` 复用占位 Tab（`TaskView.vue:955-968`） | 走 `setSideTaskFork`，占位上整体覆写 | 设计语义保持 |

**关于「真实会话 Tab 的 title 不再被覆写」**：核对 `git show HEAD` 原实现，复用分支**从来就不更新 title**（只改 `contextMode` 与 `activeTabId`），本次修复没有改变这一点，因此不构成回归。Tab title 的同步由 `updateSideTaskTab`（创建 / 重命名）与 `updateSideTaskTabTitleFor`（`session_title_updated`）负责，两条链路均不受影响。新增回归用例「从左侧任务栏重新打开已分叉的真实会话 Tab 时，分叉来源不被清掉」覆盖了该路径（占位 → `updateSideTaskTab` 转真实 → 真实 id 重开 → 断言 `forkFrom` 保留且 `activeTabId` 正确）。

## 二、BUG-2 修复复核：通过，无残留窗口

重构后的 `handleChatSend`（`SideChatPanel.vue:686-889`）把监听注册挪到 `parentSessionId` 校验之后、合并了两个 `if (isFirstSideSend)` 块，并引入 `disposeSendListeners` 统一收尾。逐项回答复核关注点：

1. **非首次发送分支（else，L825-845）**：该分支不注册任何 window 监听，`disposeSendListeners` 保持 null，其失败路径（L838-844）不调用它是正确的；外层 catch（L847）的 `disposeSendListeners?.()` 为 null 安全调用。**无残留**。
2. **`pendingSendCleanup` 两次赋值之间的间隙**：第一次赋值在监听挂上后（L792-795，覆盖 `await createSideSession` 期间的卸载——这是相对旧实现的实质改进，旧实现要等 await 返回后才赋值）；第二次在 await 成功返回后的**同步段**（L857-882，无 await 穿插，不存在被卸载打断的间隙）。**无间隙**。
3. **被拒路径的闭包取值**：`disposeSendListeners` 以 `let` 在函数作用域顶部（L752）声明，赋值（L787）发生在任何监听可能触发之前（监听只能在 L806 的 WS 发送之后才收到事件），`onSideRejected`（L773）闭包引用的是同一绑定，取到的是已赋值函数。`optimisticUserId` 也提前到 L764 声明，不存在 TDZ。**可取到**。
4. **成功路径**：`user_message_saved` → `finishWaiting(true)` 清空输入 / 草稿；60s 超时 → `finishWaiting(false)` 保留草稿；`finishWaiting` 内 `disposeSendListeners?.()` + `offMessageSaved` + `clearTimeout` 三件套齐全，`settled` 防重入。与旧实现行为一致。
5. **卸载取舍未变**：`onUnmounted` → `pendingSendCleanup()` → `finishWaiting(false)`，依旧**不释放发送锁**（`sending`），与「成功路径由 phase 终态收敛」的原有取舍一致；卸载后继续执行的 await 续段最坏只是在已卸载组件上留一个 60s 自清理定时器（`chatInputRef` 已 null，`clearInput` 可选链兜底），不会清输入、不会串扰。
6. **`onSideCreated` 新增的父会话过滤**（L770）：detail 的 `parentSessionId` 来自 WS 帧 sessionId（字符串形式，与 `sessionStore.activeSessionId` 同源），正常路径必然匹配，不会把「自己的创建」过滤掉；同时挡住了别处（其他主会话）创建事件对本面板 `expectedSavedSessionId` 的误写——这正是首轮 BUG-2 的根因。
7. **重试路径**：被拒后同面板重试会再注册一套监听并覆写 `disposeSendListeners` / `pendingSendCleanup`，旧监听已在被拒时移除，`rollbackOptimisticMessages` 按 `optimisticUserId` 精确回滚，不会误删重试插入的新消息。

## 三、NOTE-1 复核：通过

全仓（排除 node_modules）grep `hasEarlierUserMessage` **零命中**：`MessageRepository.hasEarlierUserMessage` 已更名为 `hasOwnEarlierUserMessage`（判据 + `source_session_id IS NULL`，注释已说明用途），`SessionService.hasOwnEarlierUserMessage` 包装已删除，spec 的 mock 与断言同步更新。生产侧唯一调用方是 `session-title.service.ts:69`，直连 `messageRepo`，与 `findOwnedMessage` 的门面用法各自自洽。

## 四、验证（复审时复跑）

- `cd backend-ts && npm test`：219 文件通过 / 1 跳过，**2349** 用例通过 / 13 跳过（较首轮少 1 条，即被删除的死代码 spec 用例）。
- `cd desktop && npx vitest run`：17 文件 / **198** 用例通过（新增 BUG-1 回归用例 1 条）。
- `cd desktop && npx vue-tsc --noEmit -p tsconfig.app.json`：无错误。
- 后端 `harness-service.ts` / `streaming-ws-handler.ts` 本轮未改动，首轮已核对的复制矩阵与切点校验结论继续有效。

## 五、复审结论

**本轮修复无新增问题。** BUG-1、BUG-2 的修复均到位且未引入行为回归，NOTE-1 清理干净。建议合入前保留两条新增回归用例（真实会话 Tab 重开不清来源 / 切点与 fork 预置的原子覆写），并可考虑在手工验收清单里补一条「被拒后立刻从左侧任务栏打开另一个边路任务，确认原占位 Tab 输入框内容不被清空」。
