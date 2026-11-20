# 代码审查报告：静默失败可见化（第 2 轮）

- 日期：2026-11-07
- 审查范围：同 worktree 最新未提交改动。与第 1 轮逐文件比对确认本轮仅 `useChat.ts`、`useChat.test.ts`、`TaskView.vue` 三处变化（即三个修复点），其余 10 个文件与第 1 轮字节级一致（第 1 轮已审）。
- 审查方法：三个修复逐一定位核对 + 对疑似问题编写临时 vitest 用例实证（用例验证后已删除）。
- 结论：**B1 修复正确、B3 修复正确；B2 修复引入 1 个新回归（下述 R2-B1，已用例证实）**。

---

## 第 1 轮三项修复的核对结论

- **B1（乐观更新图片）— 修复正确**。`useChat.ts:778-783`：`images` 显式传入（含 `[]`/`null`）时把 `imagesToSend` 原样写回 `updateMessageContent`（`[]` 会置 `message.images = []`，气泡立即反映「已无图」）；仅未显式传图（`undefined`）时保持旧行为。新增的两条回归用例（确认链路收尾前检查中间态）口径正确且通过。回滚快照对 `[]` 的拷贝/恢复也正确。
- **B3（indexError 过期门）— 修复正确**。`enterNewTaskMode` 入口与 `loadSession` 入口清门（TaskView.vue:1204-1206、1305-1307）。穷举了全部调用点：`applyExplicitNewTaskRoute`、`navigateToNewTask` 同路由分支、`forceNewTask`、`resolveInitialRoute`（loadTaskIndex 成功后）、路由 watcher 的进会话/离会话分支——均为显式导航或成功后路径，不存在「清门重新打开静默新建路径」的反例（D6 门针对的静默路径只存在于 onMounted 的 loadTaskIndex 失败分支，该分支不经过这两个入口）。
- **B2（错误态竞态）— 修复方向正确但写入守卫条件写错，引入下述回归**。成功清除改为按 sid 记账（只清自己会话的槽位）是正确的；**失败写入的守卫条件（槽位为空或属于本会话才写）无法区分「迟到的旧失败」和「当前会话的新鲜失败」，误伤后者**。

---

## R2-B1（已证实，B2 修复引入的回归）：失败写入按「槽位归属」守卫，导致**当前会话的新鲜失败被丢弃**——断网期间切换会话后，新会话的加载失败重新静默

- 位置：`desktop/src/composables/useChat.ts:275`（fetchMessages 失败写入守卫）、`:315`（loadOlderMessages 同构守卫）

### 现象

守卫条件为 `(historyLoadError.value == null || historyLoadError.value.sessionId === sid)`——只要槽位已被**别的会话**的错误占用，本次失败一律不写。但「槽位被别会话占用」既可能意味着**迟到的旧失败**（round-1 要防的），也可能意味着**当前会话刚发生的新鲜失败**（必须记录的），该守卫把两者混为一谈。纯顺序流程（无任何并发）即可触发：

1. 断网状态下用户在会话 B：历史加载失败 → 槽位 `{B}`，错误卡正常显示；
2. 用户切到会话 A 排查（真实切换 = `restoreSession(A)`，其内部 `fetchMessages(A)` 同样网络失败）→ 守卫见槽位是 `{B} ≠ A` → **丢弃写入**；
3. 用户停在 A：消息为空、无「历史消息加载失败」错误卡、无重试——**静默失败复发**。第 1 轮（无守卫）在该场景会正确写入 `{A}` 并显示错误卡。

`olderLoadError` 同构：A 的上拉失败在槽（`{A}`）→ 切到 B 上滑 → B 的上拉新鲜失败被丢弃 → B 不出现「加载更早消息失败」重试条。

区分两种失败的正确依据是**写入时刻该请求的会话是否仍是当前会话**（`sid === sessionId.value`），而不是槽位归属：迟到的旧失败必然 `sid !== sessionId.value`（切换已发生），当前会话的新鲜失败必然 `sid === sessionId.value`。

### 实证用例（临时用例，验证后已删除；断言为正确行为，实际运行失败）

```ts
// history 变体（restoreSession 走真实切换链路）
vi.mocked(api.get).mockRejectedValue(new Error('Network Error'))
const chat = useChat(ref('1'), ref('CLOUD'))
await chat.fetchMessages({ sessionId: 'B' })            // B 失败 → {B}
expect(chat.historyLoadError.value).toEqual({ sessionId: 'B' })   // ✅
await chat.restoreSession('A', 'CLOUD')                 // 切到 A，fetch(A) 也失败
expect(chat.sessionId.value).toBe('A')
expect(chat.historyLoadError.value).toEqual({ sessionId: 'A' })   // ❌ 失败
// 运行输出：[verify-r2] sessionId = A , historyLoadError = {"sessionId":"B"}
```

```ts
// older 变体（顺序流程）
// 运行输出：[verify-r2] sessionId = B , olderLoadError = {"sessionId":"A"}   ❌
```

两个用例均为确定性顺序流程，稳定复现。

### 修复方向（与既有测试兼容，已逐条核对）

失败写入改为按当前会话守卫：`if (!isBusinessRejection(e) && sid === sessionId.value) historyLoadError.value = { sessionId: sid }`（olderLoadError 同理）。

- 开发者新增的三条竞态回归用例在该修复下全部仍通过：「迟到的旧会话失败」写入时 `sessionId.value` 已切到 B，`sid('A') !== 'B'` → 照旧丢弃，`{B}` 保留；迟道上拉失败同理。
- 后台补拉（如编辑重发完成后的 `fetchMessages({ sessionId: sid })`，useChat.ts:850）在用户已切走时同样被正确丢弃（`sid !== sessionId.value`），不会复发 round-1 的覆盖问题；用户未切走时正常记录。
- 附带收益：槽位不再被「不可见的后台失败」占位（旧实现里空槽 + 后台失败会写入一个展示上不可见的错误、反而挡住后续新鲜失败），上述两个顺序场景随之修复。

---

## 复核过、确认无问题的点（防误报备查）

- B2 成功清除守卫（`slot.sessionId === sid` 才清）：按会话记账正确；「切回旧会话后由该会话自己的重拉成功/失败收敛」的闭环成立。
- `retryHistoryLoad` 的无条件清空：重试入口只有错误卡（槽位必属当前会话），无跨会话误清。
- B1 对 `sendEditMessage` 载荷无影响（第 4 参仍为 `imagesToSend`）；`updateMessageContent(sid, id, content, [])` 置空后 MessageBubble 的展示/编辑分支（`length > 0` 门）与回滚快照行为均正确。
- B3 两处清门均在任何 await 之前同步执行，无「先渲染过期卡再清」的中间态；watcher 无 `immediate`，挂载期不会先于 loadTaskIndex 触发 loadSession。
- 本轮 useChat.test.ts 新增的 5 条 B1/B2 回归用例（38/38 通过）口径正确。
