# 全局消息全文检索代码审查报告

- **日期**：2026-10-09
- **范围**：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/global-message-search`，分支 `feat/global-message-search` 上未提交的功能代码（文档 / CHANGELOG 不计入）。
- **方法**：通读检索 SQL、定位窗口和桌面消费路径；每条结论都用临时 Vitest 探针实跑。探针已删除，未改产品代码。
- **结论**：确认 **3 个功能 bug**。

## 结论表

| 编号 | 模块 | 一句话 |
| --- | --- | --- |
| BUG-1 | 后端检索 | 日期筛选只决定会话是否入选，展示和跳转用的命中消息不受日期约束 |
| BUG-2 | 桌面定位 | 一轮里非最后一条助手消息被折叠，点击后页面上没有这条消息，无法滚动和高亮 |
| BUG-3 | 桌面历史窗口 | 正在查看较早消息时，工具参数和工具结果仍会在窗口尾部插入一条新的助手气泡 |

---

## BUG-1 日期筛选管不到展示出来的命中

阶段 1（`selectMatchingSessions`）的 WHERE 包含 `m.created_at >= ? AND m.created_at < ?`。阶段 2（`selectHitMessages`）只按会话 id 和关键词取每会话最多 5 条：LIKE 按 `id DESC`，FULLTEXT 按相关度。服务层原样展示这些行（`session.service.ts` 里 `selectHitMessages(ids, prepared.path, prepared.match)`），不再按 `createdAt` 过滤。

因此把日期收成某一天时，会话可以因为那天有一条命中而出现，列表里却是该会话在其他日期的更新或更高分消息。那 5 条若都不落在所选日期内，用户点开的也不是筛选范围内的消息，范围内的那条不会出现。

探针驱动真实 `SessionRepository.selectMatchingSessions` 与 `MessageRepository.selectHitMessages`（假 Db 只记录 SQL）。阶段 1 参数含 `2026-10-01 00:00:00` / `2026-10-02 00:00:00`；LIKE 与 FULLTEXT 的阶段 2 SQL 都没有 `created_at >=` / `created_at <`，参数只有会话 id 和关键词。

```bash
cd backend-ts && npx vitest run src/session/review-tmp-search.spec.ts
```

实测：该用例通过（3 tests 里另外 2 个是短词回退行为核对，见文末，不记为 bug）。

## BUG-2 折叠步骤里的助手命中定位不到

`useMessageRounds` 把一轮里除最后一条助手消息以外的助手消息放进 `collapsedSteps`。`ChatRoundList` 历史轮次默认不展开，这些步骤的 `MessageBubble` 在 `v-if="roundsExpanded[...]"` 里面。`useMessageLocate` 拉到窗口后只 `querySelector([id="msg-..."])` 再 `scrollIntoView`，不会展开该轮。

用户消息和该轮最后一条助手回复能定位。带工具的轮次里，关键词经常在前面那条助手说明里、不在最终回复里。点击后最终回复在视口里，命中那条不在 DOM 中，高亮和滚动都不会发生。

探针：`sending: false` 时，消息 `2`（「我先搜索登录相关日志」）在 `collapsedSteps`，`roundsExpanded` 为空。用真实 `ChatRoundList` 做 SSR（气泡打成带 `id="msg-*"` 的节点），HTML 含 `msg-1` 和 `msg-3`，不含 `msg-2`，也不含该句正文。

```bash
cd desktop && npx vitest run src/composables/review-tmp-locate.test.ts
```

实测：2 tests 通过。

## BUG-3 历史定位窗口仍会接上实时工具气泡

`appendDelta` / `appendMessage` / `appendToolCallStart` 在 `isHistoryAnchored` 时直接返回。`updateToolCallResult` 和 `updateToolCallArgs` 没有这道判断，并且都会调用 `ensureStreamingAssistantMessage`。当前窗口最后一条不是正在流式输出的助手消息时，这个函数会新建一条助手消息接到列表尾部。

用户从搜索跳到较早的一轮、会话仍在跑工具时，历史窗口末尾会出现一条不属于该窗口的助手气泡（工具结果挂在上面，或只是一条空气泡）。这和「定位期间不把实时消息接到历史窗口后面」的行为不一致。文本增量被挡住了，工具流量没有。

探针：锚定会话 `11` 且列表只有 `id=90` 的用户消息后，调用上述两个方法，列表都变成 2 条，第二条是新的 assistant。

```bash
cd desktop && npx vitest run src/stores/review-tmp-anchor.test.ts
```

实测：2 tests 通过。

---

## 已核对、不记为 bug

- 任一词短于 2 个字时整段走 LIKE，匹配串是原始关键词。`+登` 的 LIKE 模式是 `+登`，`部署 回` 的模式是整句 `部署 回`。这与方案里「有短词则走 LIKE」的路径判定一致，本次不单列为实现错误。
- `aroundMessageId` 的上界是下一轮用户消息；命中在最后一轮时 `hasNewer` 为 false。现有服务测试已覆盖，本次未发现窗口把助手回复裁掉。
- 多词默认 OR、`+` / `-` / 引号收成短语，与方案一致。
