# 全局消息全文检索代码审查报告（第二轮）

- **日期**：2026-10-09
- **范围**：worktree `feat/global-message-search` 未提交的功能代码。文档不计入。
- **上一轮 3 条**：都已修掉，并用探针复跑确认。
  - 阶段 2 `selectHitMessages` 带上 `createdFrom` / `createdToExclusive`。`searchMessages(7, '登录', { dateFrom: '2026-10-01', dateTo: '2026-10-01' })` 调用参数为 `'"登录"', '2026-10-01 00:00:00', '2026-10-02 00:00:00'`。LIKE / FULLTEXT 的命中 SQL 都有 `m.created_at >= ?` 和 `m.created_at < ?`，占位符个数与参数一致。
  - `expandRoundContainingMessage` 会把落在折叠步骤里的命中轮展开。`ChatRoundList` 在 `locateFlashId` 变化时（`flush: 'pre'`）调用它。`useMessageRounds.locate.test.ts` 通过。
  - `updateToolCallArgs` / `updateToolCallResult` 在历史定位期间直接返回，消息列表保持原来的一条。`history-anchor.test.ts` 通过。
- **本轮结论**：上一轮 3 条不再复现。另有 **2 个新的功能 bug**。探针已删除，未改产品代码。

## 结论表

| 编号 | 模块 | 一句话 |
| --- | --- | --- |
| BUG-1 | 桌面历史窗口 | 定位期间，远端用户消息和队列消费仍会把新用户消息和空助手气泡接到旧窗口后面 |
| BUG-2 | 桌面拉最新一页 | 定位完成前已经发出的「最新 5 轮」请求返回后仍会覆盖定位窗口，命中的助手消息消失 |

---

## BUG-1 历史窗口仍会接上新的用户消息

`appendDelta`、`appendMessage`、`updateToolCallArgs`、`updateToolCallResult` 在 `isHistoryAnchored` 时返回。`addUserMessage`（`messages.ts` 约 229 行）和 `ensureStreamingAssistantMessage`（约 272 行）没有这道判断。

这两处正是实时入口在用的：

- `useStreamWS.ts` 的 `user_message_saved`：匹配不到本端乐观消息时 `addUserMessage`，接着 `ensureStreamingAssistantMessage`。
- 同文件 `queue_message_consumed`：同样先插入用户消息，再占位一条助手消息。

用户停在较早的命中轮时，队列被消费或另一端发来消息，旧窗口末尾会多出一条新用户消息和一条空助手气泡，中间缺掉的轮次不会补上。

探针：锚定会话且列表只有 `id=90` 之后调用这两个方法，角色序列变成 `user, user, assistant`。

```bash
cd desktop && npx vitest run src/stores/review-tmp-02.test.ts
```

实测通过（含「工具更新不再插气泡」的对照用例）。

## BUG-2 在途的最新一页会盖掉定位窗口

`useChat.ts` 的 `fetchMessages` 只在发请求前看 `isHistoryAnchored`。请求返回后无条件 `applyFetchedMessages`。`SideChatPanel.vue` 的 `fetchMessages` 同样是先判断、`await` 之后再写入。

切到另一个会话时，`restoreSession` 会拉最新 5 轮；定位在这之前或同时把 `around` 结果 `setMessages` 并锚定。最新一页若后返回：

- 定位到的助手消息被丢掉（非流式助手不保留）。
- 定位窗口里的用户消息被接到最新一页后面。
- 会话仍保持锚定，横幅还在，后续流式更新继续被丢掉。

探针：先让 `fetchMessages({ sessionId: '11' })` 挂起，再写入锚定窗口 `90`（用户）和 `91`（助手），然后让接口返回 `200`/`201`。结束后仍是锚定状态，列表变成 `['200', '201', '90']`，`91` 不在其中。

```bash
cd desktop && npx vitest run src/composables/review-tmp-02-fetch.test.ts
```

实测通过。
