# 飞书合并转发展开第 2 轮复审

- **日期**：2026-10-08
- **范围**：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/feishu-merge-forward`，分支 `feat/feishu-merge-forward`，当前未提交功能代码。未审文档与 CHANGELOG。
- **方法**：对照上一轮 4 个修复重新走读。上一轮问题在当前代码里已按所述改完（嵌套失败只降级该层、授权抛错会 `markGroupMessageEnriched`、`@_user_N` 按 key 长度替换、合并转发里的 post `at` 会换成姓名），本轮不再复述。下面只记录用新测试仍能复现的问题。验证用例在 `/tmp/feishu-merge-review-r2.test.ts`，未留在仓库，也未改产品代码。
- **结论**：仍有 **2 个可复现的功能缺陷**。都出在本轮为修复 @ 提及而改的富文本提取和最长 key 替换上。

验证：`cd backend-ts && npx vitest run --config vitest.review-r2.config.ts`（临时配置，跑完已删）。3 个探针全部失败，其中 2 个对应下面的缺陷；另一条与引用路径是同一根因。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 中 | `message-detail.ts` 的 post 提取 | 普通富文本入站和引用会把 `@_user_N` 原样交给 Agent，姓名只在合并转发摘录里会被换上 |
| BUG-2 | 低 | `replaceMentionKeys` + post 拼接 | `at` 与紧随其后的数字直接粘在一起时，最长 key 会把 `@_user_1` + `0` 认成 `@_user_10`，@ 成另一个人 |

---

## BUG-1【中】普通 post 的 @ 停在 `@_user_N`，不会换成姓名

**位置**

- `backend-ts/src/feishu/message-detail.ts` 的 `collectText`：`tag === 'at'` 且 `user_id` 以 `@_user_` 开头时直接返回占位符，旁边的 `user_name` 不再使用。
- 合并转发摘录在 `merge-forward.ts` 的 `renderNodes` 里对 `describeMessageText` 的结果再调用 `replaceMentionKeys`，所以合并转发本身是对的。
- 另外两条会把这段正文交给 Agent 的路径没有第二次替换：
  - 入站：`event-normalizer.ts` 只对 `extractText` 的结果做替换。post 没有顶层 `text`，这里得到空串，姓名被丢掉。随后 `inbound-processor.ts` 的 `normalizeText` 在正文为空时用 `describeMessageText` 重写 `event.text`，不再走 `replaceMentionKeys`。
  - 引用：`fetchFeishuMessageDetail` 只返回 `describeMessageText` 的文本，不带 mentions。`resolveFeishuQuotedText` 对非 `merge_forward` 直接 `persist(detail.text)`。

**问题**

修复前，普通 post 里的 `at` 被丢掉，正文只剩「大家好」。修复后，私聊/群聊里的普通富文本，以及引用一条普通富文本，都会变成 `@_user_1 大家好`。Agent 看到的是飞书内部占位符，不是「李四」。`at` 标签上的 `user_name` 和入站事件 mentions 里的姓名都在，但没有用到。

**验证**（`/tmp/feishu-merge-review-r2.test.ts`）

- `replaces post at-mentions on a normal inbound post`：`normalizeFeishuEvent` 解析带 mentions（`@_user_1` → 李四）的 post，再交给 `FeishuInboundProcessor`。`onMessage` 的 `text` 实际是 `@_user_1 大家好`。
- `replaces at-mentions when a normal post is quoted through message detail`：`fetchFeishuMessageDetail` 与 `resolveFeishuQuotedText` 按 `create-app.ts` 的方式接在一起。引用结果同样是 `@_user_1 大家好`。

**修复方向（未实施）**：`normalizeText` 在用 `describeMessageText` 生成 post 正文后，用原始事件里的 mentions 再替换一次；`fetchFeishuMessageDetail` 把 mentions 一并解析出来，引用 post 时同样替换。或者 `collectText` 在已经有 `user_name` 时直接输出 `@姓名`，避免把未替换的占位符传出。

---

## BUG-2【低】`@_user_1` 和后面的数字粘在一起时，会替换成更长的那个 @

**位置**

- `message-detail.ts` 的 `collectText` 把 `at` 的 `@_user_N` 和后一个 text 节点直接拼接，中间没有分隔。
- `event-normalizer.ts` 的 `replaceMentionKeys` 按 key 长度从长到短做子串替换。

**问题**

富文本是「@甲」紧接着「0点开会」，提取结果是 `@_user_10点开会`。同一条消息里如果还有 `@_user_10`，长 key 先替换，摘录变成 `@癸点开会`。数字 0 被吃掉，@ 的人也不对。纯文本里飞书通常会在占位符后留空格，所以主要打在 post 的 `at` + 后续文字上。上一轮要求的「先替换更长的 key」在占位符被分隔开时是对的，和这种无分隔拼接叠在一起就会认错人。

**验证**

`/tmp/feishu-merge-review-r2.test.ts` → `does not treat a mention glued to the following digit as a longer mention key`

- post 子消息：`at(user_id=@_user_1)` + 文本 `0点开会`，mentions 同时有甲（`@_user_1`）和癸（`@_user_10`）
- 实际摘录：`张三：@癸点开会`
- 期望：`@甲0点开会`

**修复方向（未实施）**：提取 `at` 时在占位符后加一个不会出现在 key 里的分隔（或直接输出 `@姓名`），避免和后文拼成更长的 `@_user_N`。
