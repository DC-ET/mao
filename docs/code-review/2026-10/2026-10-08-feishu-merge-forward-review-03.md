# 飞书合并转发展开第 3 轮复审

- **日期**：2026-10-08
- **范围**：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/feishu-merge-forward`，分支 `feat/feishu-merge-forward`，当前未提交功能代码。未审文档与 CHANGELOG。
- **方法**：第 2 轮的两处修复已按描述落地（有 `user_name` 时直接输出 `@姓名`；没有姓名时用零宽分隔，避免 `@_user_1` 加「0点开会」被认成 `@_user_10`）。本轮不复述这两项。新怀疑点用 `/tmp/feishu-merge-review-r3.test.ts` 跑 vitest 复现，未改产品代码，验证用例未留在仓库。
- **结论**：仍有 **1 个可复现的功能缺陷**。

验证：`cd backend-ts && npx vitest run --config vitest.review-r3.config.ts`（临时配置，跑完已删）。3 个探针全部失败，是同一处替换规则。

---

## BUG-1【中】占位符紧挨数字时，已知的 @ 不再替换成姓名

**位置**：`backend-ts/src/feishu/event-normalizer.ts` 的 `replaceMentionKeys`

```ts
replaced = replaced.replace(new RegExp(`${escaped}(?!\\d)\\u200b?`, 'g'), `@${item.name}`);
```

`(?!\d)` 要求 key 后面不能是数字。普通文本和合并转发里的 text 子消息没有零宽分隔，这个限制会作用在全部入站文本和摘录上。

**问题**

飞书正文里占位符和后文可以没有空格（现有用例 `@_user_1我是谁` 就是这样）。后文如果以数字开头，而这个「更长的样子」并不是 mentions 里的另一个 key，替换会整段失败，Agent 仍看到 `@_user_N`。

- mentions 只有 `@_user_1` → 甲，正文 `@_user_13月报表`（@甲 +「3月报表」）。`@_user_13` 不是提及。结果仍是 `@_user_13月报表`，没有变成 `@甲3月报表`。
- mentions 同时有 `@_user_10` → 癸 和 `@_user_1` → 甲，正文 `@_user_101号文件`。最长的真实 key 是 `@_user_10`，后面的 `1` 是正文。`(?!\d)` 把 `@_user_10` 和 `@_user_1` 都拒掉，结果仍是 `@_user_101号文件`。

有 `user_name` 的富文本 `at` 不走这条替换，不受影响。没有分隔的纯文本，以及合并转发里的 text 子消息，会中招。

**验证**（`/tmp/feishu-merge-review-r3.test.ts`）

- `replaces a mention that is immediately followed by a digit...`：`normalizeFeishuEvent` 得到的 `text` 是 `@_user_13月报表`，不是 `@甲3月报表`。
- `replaces the longest real mention key even when the next character is a digit`：得到 `@_user_101号文件`，不是 `@癸1号文件`。
- `replaces the same pattern inside a merge-forward text child`：摘录是 `张三：@_user_13月报表`。

**修复方向（未实施）**：只在「后面这段正好是 mentions 里另一个更长的 key」时跳过短 key。某个 key 本身已经在 mentions 里时，后面跟着数字也要替换。不要用「后面是任意数字」一刀切。
