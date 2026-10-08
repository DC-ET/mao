# 飞书合并转发展开（feat/feishu-merge-forward）代码审查

- **日期**：2026-10-08
- **范围**：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/feishu-merge-forward`，分支 `feat/feishu-merge-forward`，未提交改动（相对 HEAD）。只审功能代码，未审 CHANGELOG / 文档 / `skills/`。
- **对照**：`docs/plan/2026-10-08-feishu-merge-forward-technical-design.md`
- **方法**：走读 `merge-forward.ts`、`sender-names.ts`、`inbound-processor.ts`、`create-app.ts` 装配、`event-normalizer.ts` 的 `replaceMentionKeys`、`message-detail.ts` 的正文提取。怀疑点用 `/tmp/feishu-merge-review.test.ts` 跑 vitest 复现，**未改产品代码，验证用例未留在仓库**。
- **结论**：确认 **4 个可复现的功能缺陷**。午夜/正午的上海时区格式、100 条截断、超长落盘、授权失败不拉子消息、群未 @ 异步回写并清 `enrich_pending`、引用日志已是摘录则不再 GET，按方案核对未发现同样级别的问题。

验证命令（配置临时放在工作区，跑完已删）：

`cd backend-ts && npx vitest run --config vitest.review.config.ts`

结果：6 个探针里 5 个失败（即缺陷成立），时区格式 1 个通过。下面只记录失败项。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 高 | `merge-forward.ts` | 任一嵌套合并转发拉取失败会让整包返回 null，已经取到的外层原文被丢掉，用户消息退回英文 |
| BUG-2 | 中 | `inbound-processor.ts` | 群里会触发的合并转发在授权抛错时不清理 `enrich_pending`，水位线停在该行，之后的群上下文进不来 |
| BUG-3 | 中 | `event-normalizer.ts` / 摘录渲染 | `@_user_1` 会先替换掉 `@_user_10` 的前缀，第 10 个及以后的 @ 显示成错误姓名 |
| BUG-4 | 中 | `message-detail.ts` / 摘录渲染 | 富文本子消息里的 `at` 标签不会进入正文，`@_user_N` 替换没有作用对象，@ 的人从摘录里消失 |

---

## BUG-1【高】嵌套包拉取失败时，整次展开被丢弃

**位置**：`backend-ts/src/feishu/merge-forward.ts` 的 `loadChildren`。子节点仍是 `merge_forward` 时：

```ts
const nested = await loadChildren(client, node.messageId, depth + 1, seen, budget);
if (nested == null) return null;
```

`fetchItems` 在飞书 `code !== 0` 或抛错时返回 null，`loadChildren` 随之返回 null。上面这行把 null 原样抛到最外层，`expandFeishuMergeForward` 因此返回 null。调用方（私聊 / 群 @ / 引用）按「null = 失败」保留固定英文 `Merged and Forwarded Message`。

**问题**

外层 GET 已经成功，外层文本子消息也已经解析进 `nodes`。只要其中一个嵌套包返回 230110（已删除）、230027（无权限）或其他错误，这些外层原文不会出现在摘录里。方案要求嵌套包再展开，同时要求本轮用户消息是摘录；嵌套失败只应该让那一层降级，不应该把已经拿到的外层对话整包退回英文。

**验证**

`/tmp/feishu-merge-review.test.ts` → `keeps outer messages when a nested merge_forward cannot be loaded`

- 外壳 `om_root` 含文本「外层原文还在」和嵌套 `om_nest`
- `om_nest` 的 GET 返回 `code: 230110`
- 实际结果：`expandFeishuMergeForward` 返回 `null`，断言 `toContain('外层原文还在')` 失败

**修复方向（未实施）**：嵌套 `loadChildren` 返回 null 时，给该节点标未展开（例如保留「嵌套合并转发展开失败」），继续渲染已取到的兄弟节点，不要 `return null`。

---

## BUG-2【中】授权抛错时，群合并转发的 `enrich_pending` 不会被清掉

**位置**：`backend-ts/src/feishu/inbound-processor.ts`

会触发的群消息先以 `enrichPending: true` 入库（`messageType === 'merge_forward'` 算进 `needsEnrich`）。合并转发**不**在授权前启动 `enrichGroupMessage`。清理标记只发生在两条路上：

- 授权返回 false：`enrichGroupMessage(..., { skipMergeForward: true })` 的 `finally`
- 授权通过：`persistExpandedMergeForward` 的 `finally`

`authorizeSender` 若抛错（绑定查询、ECP 会话、`addGroupMember` 的数据库异常），两条路都不走。`process` 的 `finally` 只 `releaseInboundMessage`，不调用 `markGroupMessageEnriched`。

飞书长连接在 `monitor.service.ts` 里对 `process()` 的 rejection 只打日志，ack 已经返回，不会重放这条事件。该行 `enrich_pending` 一直为 1。`buildGroupContext` 遇到未富化行会 `break`，水位线停在它前面，**同群之后的消息都进不了【群内最近消息】**。方案 4.4 与风险表要求无论成败都要清标记。图片/卡片是在授权前就 `void enrichGroupMessage`，异常也能靠它的 `finally` 放行；合并转发把清标记挪到授权之后，把这个洞打开了。话题免 @ 触发走同一段，同样受影响。

**验证**

`/tmp/feishu-merge-review.test.ts` → `clears enrich_pending when authorizeSender throws after a mentioned merge_forward is logged`

- 群 @、`messageType: merge_forward`，`authorizeSender` 抛 `db down`
- `recordGroupMessage` 被调用且 `enrichPending: true`（logId 401）
- `markGroupMessageEnriched` 调用次数为 **0**（断言 `toHaveBeenCalledWith(401)` 失败）
- `process` 向外抛出 `db down`

**修复方向（未实施）**：从 `recordGroupMessage` 成功到 `persistExpandedMergeForward` / `enrichGroupMessage` 之间包一层 `try/finally`，任何退出（含授权抛错）都 `markGroupMessageEnriched`。未展开时保留英文即可。

---

## BUG-3【中】`@_user_1` 会改写 `@_user_10`

**位置**：`backend-ts/src/feishu/event-normalizer.ts` 的 `replaceMentionKeys`，合并转发摘录在 `merge-forward.ts` 的 `renderNodes` 里对子消息正文调用它。

```ts
replaced = replaced.split(item.key).join(`@${item.name}`);
```

按 mentions 数组顺序做子串替换。飞书占位符是 `@_user_1`、`@_user_2`、…、`@_user_10`。先替换 `@_user_1` 时，`@_user_10` 会变成 `@姓名0`。

**问题**

一条子消息 @ 了 10 个及以上的人时，第 10–19、20–29 位的姓名是错的。方案要求 `@_user_N` 换成 mentions 里的姓名。合并转发经常是一段群聊，出现 10 个以上 @ 并不罕见。现有单测只覆盖了 `@_user_1`，没有覆盖更长的 key。

**验证**

`/tmp/feishu-merge-review.test.ts` → `does not corrupt @_user_10 when @_user_1 is replaced first`

- 正文 `@_user_1 @_user_10 @_user_2`，mentions 顺序为甲、乙、癸
- 实际摘录：`张三：@甲 @甲0 @乙`
- 期望：`@甲 @癸 @乙`

**修复方向（未实施）**：按 key 长度从长到短替换，避免短 key 吃掉长 key 的前缀。

---

## BUG-4【中】富文本里的 @ 不会出现在摘录中

**位置**

- `backend-ts/src/feishu/message-detail.ts` 的 `collectText`：只认 `img` / `media` / `emotion` 和 `text` 字段，不认 `tag === 'at'` 的 `user_id` / `user_name`
- `merge-forward.ts` 的 `renderNodes`：先 `describeMessageText`，再 `replaceMentionKeys`

飞书富文本 @ 的实际结构是：

```json
{ "tag": "at", "user_id": "@_user_1", "user_name": "李四" }
```

`user_id` 上的 `@_user_N` 不会进入提取出的字符串，后面的替换没有可替换文本。

**问题**

方案 4.2 要求 text / post 里的 `@_user_N` 换成 `@姓名`。纯文本子消息可以换成。富文本子消息（群里「文字 + @人」的常见形态）摘录里只剩普通文字，被 @ 的人消失。现有单测的 post 只含 `tag: text` 和 `tag: img`，没有 at。

**验证**

`/tmp/feishu-merge-review.test.ts` → `keeps an @ mention inside a post child`

- post 子消息：`at(user_id=@_user_1, user_name=李四)` + 文本「 大家好」，mentions 含 `{ key: '@_user_1', name: '李四' }`
- 实际摘录：`张三：大家好`
- 期望含 `@李四`

**修复方向（未实施）**：`collectText` 遇到 `tag === 'at'` 时输出 `user_id`（即 `@_user_N`），交给现有的 `replaceMentionKeys`；或直接输出 `@` + `user_name`。
