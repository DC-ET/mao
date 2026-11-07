# 代码审查报告：静默失败可见化（第 1 轮）

- 日期：2026-11-07
- 审查范围：worktree `feature/silent-failure-visibility` 全部未提交改动（desktop/ 下 12 个文件 + CHANGELOG + 设计文档），验收口径为 `docs/plan/2026-11-07-silent-failure-visibility-technical-design.md` 决策表 D1–D8 与 §4。
- 审查方法：逐文件 diff 精读 + 对照设计文档逐条核对 + 对每个疑似问题编写临时 vitest 用例实证（用例验证后已删除，未污染工作区；关键代码与运行输出见各条目）。
- 结论：**发现 2 个已用例证实的 bug（B1、B2）+ 1 个边界项（B3，逻辑推演，无挂载测试先例无法低成本用例化）**。其余改动（D1 重连终态、D4 谓词、D6 门与出口、@面板空态/失败、复制失败 toast、编辑态图片 UI 与事件签名透传）与设计文档口径一致，未发现功能性错误。

---

## B1（已证实）：`editAndResend` 移除全部图片时，乐观更新仍保留原图——确认后气泡继续显示已被移除的图片

- 位置：`desktop/src/composables/useChat.ts:776`（`editAndResend` 内的乐观更新调用）
- 引入方式：本次改动（D5 三态语义使 `imagesToSend = []` 从「不可达」变为「用户显式移除全部图片」的常态路径，但乐观更新一行未同步）。

### 现象

用户在编辑态移除某条带图消息的**全部**图片并确认后：

1. WS 载荷正确：`edit_and_resend.images = []`（后端 `editMessageAndTruncate` → `buildEditContent(text, [])` 会把落库正文重写为纯文本，图片随之消失）；
2. **但乐观更新传给 `updateMessageContent` 的是 `undefined`**：

```ts
// useChat.ts:772-777
sessionStore.updateMessageContent(
  sid,
  messageId,
  newContent,
  imagesToSend.length > 0 ? imagesToSend : undefined   // ← 空数组回落成 undefined
)
```

而 `updateMessageContent`（`stores/session/messages.ts:650-652`）对 `images === undefined` 的语义是「不动图片」：`if (images !== undefined) message.images = images`。

结果：**确认后整个重跑执行期间（可能数分钟），消息气泡仍显示全部原图**，直到执行完成后的 `fetchMessages` 重新拉取才纠正；若会话处于 history-anchored（用户用轮次目录定位过，`fetchMessages:244` 直接 return），**重拉被跳过，被移除的图片将一直显示到下次切会话**。与验收口径「确认后按剩余图片重发」（D5）直接矛盾——载荷正确但可见状态错误；这正是勘误 2 在 WS 载荷上修掉的同一类「空数组被回落吞掉」问题，在乐观更新这一行漏改了。

### 实证用例（临时用例，验证后已删除；断言为正确行为，实际运行失败）

```ts
// 前置：store 中最后一条用户消息 u1 带 images: ['http://localhost/img/1.png', 'http://localhost/img/2.png']
const pending = chat.editAndResend('u1', 'edited', [])
await vi.waitFor(() => expect(ws.sendEditMessage).toHaveBeenCalled())
expect(ws.sendEditMessage.mock.calls[0][3]).toEqual([])            // ✅ 通过：WS 载荷正确
const edited = store.getMessages('A').find(m => m.id === 'u1')     // 乐观更新后立刻读取
// expect(edited?.images).toEqual([])                              // ❌ 失败
// AssertionError: expected [ 'http://localhost/img/1.png', …(1) ] to deeply equal []
```

运行输出：`[verify] optimistic images after removing all: ["http://localhost/img/1.png","http://localhost/img/2.png"]`（对照组用例「显式传部分图片」乐观更新正确保留剩余图，通过——证明问题只在空数组分支）。

### 修复方向

去掉回落，直接透传集合即可：`updateMessageContent(sid, messageId, newContent, imagesToSend)`。`undefined` 入参场景下 `imagesToSend` 本就等于原图片集合，语义不变；空数组场景 `updateMessageContent` 会正确置 `message.images = []`。建议同时给「移除全部图片后 store 内 images 为空」补一条回归断言（现有 D5 测试只断言了 WS 载荷第 4 参，未覆盖乐观更新）。

---

## B2（已证实）：`historyLoadError` / `olderLoadError` 是单槽位状态，迟到的跨会话请求会覆盖/清空**当前会话**的错误态——「空会话假象」在竞态下复发

- 位置：`desktop/src/composables/useChat.ts:250`（fetchMessages 成功无条件清空）、`:273`（失败置位）、`:294`（loadOlderMessages 成功清空）、`:309`（失败置位）
- 引入方式：本次改动新增的两个错误态。

### 现象

两个错误态都是「一个 ref 存 `{ sessionId }`」的单槽位，写入（置位/清空）完全不校验「这次写入针对的会话是否还是发起时的会话」。同一 `useChat` 实例内跨会话并发请求是现实存在的（如 A 会话轮次结束时 phase watcher 触发 `fetchMessages()`（useChat.ts:844）在途，用户此时切到 B，`restoreSession` 再发 `fetchMessages(B)`；`fetchMessages` 无任何取消机制，窗口最长 30s 超时）。此时旧会话的迟到结果会破坏当前会话的错误态：

- **变体 1（迟到成功清空）**：`fetchMessages(A)` 在途 → 切到 B → `fetchMessages(B)` 网络失败置 `{B}` → A 的响应迟到且成功 → `useChat.ts:250` `historyLoadError.value = null` 在 `historyAnchorEpochOf(sid) !== anchorEpoch` 陈旧结果丢弃检查**之前**无条件执行 → B 的错误态被清空。
- **变体 2（迟到失败覆盖）**：同上，但 A 的响应迟到且失败 → `:273` 把错误态覆盖为 `{A}` → 组件侧 `historyLoadFailed`（按当前 `sessionId === 'B'` 比对）判定为 false。

两种变体的最终表现一致：**用户停在 B，B 的历史加载失败，但界面既无错误卡也无重试按钮，只有空会话/引导态**——正是本需求（验收目标 1「网络抖动后用户看到的是加载失败而不是空会话」）要消灭的静默失败，在竞态下复发。D7 的「切会话旧错误自动失活」只解决了**展示侧**比对，没覆盖**写入侧**被旧会话结果反写的问题。

`olderLoadError`（`:294`/`:309`）完全同构：A 的上拉在途（用户上滑触发）→ 切到 B → B 上拉失败置 `{B}` → A 的上拉迟到成功 → 清空 → B 的「加载更早消息失败」重试条丢失。

### 实证用例（临时用例，验证后已删除；断言为正确行为，实际运行失败）

```ts
// 变体 1：A 的 fetch 挂起，B 立即网络失败
const pendingA = chat.fetchMessages({ sessionId: 'A' })
await chat.fetchMessages({ sessionId: 'B' })          // reject
chat.sessionId.value = 'B'
expect(chat.historyLoadError.value).toEqual({ sessionId: 'B' })   // ✅ 此时错误态正确
resolvers.get('/sessions/A/messages')!({ data: { messages: [], hasMore: false } })
await pendingA                                        // A 迟到成功
// expect(chat.historyLoadError.value).toEqual({ sessionId: 'B' }) // ❌ 失败
// 运行输出：[verify] sessionId = B , historyLoadError = null
```

```ts
// 变体 2：A 稍后也失败，覆盖为 {A}
// 运行输出：[verify] sessionId = B , historyLoadError = {"sessionId":"A"}   ❌
```

```ts
// olderLoadError 同构变体：A 上拉迟到成功清掉 B 的上拉失败态
// 运行输出：[verify] olderLoadError = null   ❌
```

（三个用例均稳定复现，非 flaky。）

### 修复方向

写入侧按会话守卫：置位/清空前比对「本次请求的 sid 是否仍等于发起时捕获的 sid 对应的当前会话」（例如仅在 `sid === sessionId.value` 时写/清；或在成功路径把 `historyLoadError.value = null` 移到 anchorEpoch 陈旧检查之后并改成 `if (historyLoadError.value?.sessionId === sid) historyLoadError.value = null` 的按键清除）。`loadOlderMessages` 同理。可按上面三个用例补回归测试。

---

## B3（边界项，逻辑推演，未用例化）：`indexError` 门不在「显式新建任务路由」路径清除，初始索引失败后经旁路进入会话再点「新建任务」会看到过期错误卡

- 位置：`desktop/src/views/task/TaskView.vue:179`（`isNewTaskMode` 门）、`:1276-1279`（`applyExplicitNewTaskRoute` 未清 `indexError`）、`:1538-1544`（仅 `retryTaskIndex`/`forceNewTask` 清门）
- 置信级别：中低（代码路径确定性成立；因 TaskView 无组件挂载测试先例、挂载脚手架成本高，本轮未做自动化用例，修复时建议顺手补一条视图级用例或人工走查）。

### 现象与前置条件

`indexError` 只有两个清除点（`retryTaskIndex` 成功、`forceNewTask` 点击）。若初始 `loadTaskIndex` 失败（`indexError=true`）后，用户**不经过中央错误卡**、通过直接输入会话 URL / 通知深链 / 浏览器前进后退进入某会话（路由 watcher → `loadSession` 成功，`indexError` 仍为 true），之后再点任务面板的「新建任务」按钮：

1. `handleNewTask` → `navigateToNewTask` → 路由变更为 `?newTask=1` → watcher → `applyExplicitNewTaskRoute` → `enterNewTaskMode()` 正常执行（新建态状态就绪、`initialLoading=false`）；
2. 但 `isNewTaskMode = !sessionIdParam && !initialLoading && !indexError` 因过期的 `indexError=true` 仍为 false → 中央 Composer 不出现；
3. 中央错误卡 `v-if="indexError && !sessionIdParam"`（TaskView.vue:16）渲染「任务列表加载失败」——**用户的显式新建动作被一次早已过期的加载失败挡住**，与 D6 自己的口径（「显式点击后进入不算静默掉入」、门只挡静默路径）相悖。

功能上可恢复（错误卡上点「仍要新建任务」即可进入），不构成死锁，故列为边界项而非必修项；但「点新建任务却看到任务列表加载失败」是明确的错误状态呈现。

### 修复方向

`applyExplicitNewTaskRoute`（或 `handleNewTask`）作为显式新建入口，与 `forceNewTask` 同等对待：进入前 `indexError.value = false`。

---

## 复核过、确认无问题的点（防误报备查）

- D4 谓词 `typeof e.code === 'number'`：拦截器业务错误 `err.code = data.code`（数字，`api/index.ts:69-75`），axios 网络/HTTP 错误 code 为字符串——比设计文档 §4 步骤 1.2 的 `code == null` 字面写法更正确，且与新测试一致。
- D1 重连终态：`scheduleReconnect` 计数有 `reconnectTimer` 早退保护，心跳判死路径（3s 强杀）与 onclose 不会双重计数；`disconnect`/`handleAuthenticated`/`manualReconnect` 三处复位正确；手动重试失败回落黄色自动重连文案符合 D1。
- ChatPanel 空态分支链（错误分支无 `messages.length === 0` 守卫、错误态在带缓存消息的会话上也会显示）：与设计 §4 步骤 4.2 字面口径一致，不算偏差。
- `olderLoadError` 仅在上拉成功时清除（完整重拉成功不清）：与设计 §4 步骤 1.3 字面口径一致。
- D5 事件签名三处透传（MessageBubble emit / ChatRoundList `(content, images) =>` / ChatPanel `confirmEdit`）与 `ChatRoundList` 的 `activeRound!` 断言（外层 `v-if="activeRound"` 保护）均正确。
- `fetchMessages` forceLatest 绕过 anchored 门、`loadOlderMessages` 失败仍 `return false`（D8：useChatScroll 零改动成立）；失败不清分页状态，重试条可正常重试。
- ChatInput `fileListError`：写入点全部受 `seq !== fetchFilesSeq` 乱序保护，无 B2 同类问题；打开面板必触发重新拉取，无陈旧错误残留。
- TaskIndexPanel `indexListEmpty` 引用的三个 computed 均存在；错误条仅空列表时渲染，不遮蔽数据。
- 复制失败 toast（MessageBubble）、编辑态图片 UI/重置/tooltip、ConnectionBanner 两态切换：逻辑正确。
