# 会话日期锚定与跨天提示（feat/session-date-drift-notice）round3 复审报告

- 审查对象：commit `2eddae13`（test: 修复 round2 审查发现的测试未守住长度校验的问题）
- 完整需求改动：`git log 9d2c9966..HEAD`（`c8451579` 功能 + `156c0121` 修复 + `2eddae13` 测试修复）
- 工作区：`/opt/mao-data/workspace/2/projects/mao/.worktrees/session-date-drift-notice`
- 审查日期：2026-10-12
- 审查方式：只读审查 + **自行复现反向篡改验证**（验证后已全部还原，`git diff HEAD` 为空、`git status` 干净）

---

## 1. 总体结论

**无功能性 bug，可以合并。**

round2 指出的唯一问题（测试未守住 `ymd.length === 10` 保护）已正确修复：round3 把 mock 输入从 `createdAt: ''` 改为长度不足 10 的脏值 `'2026-10-1'`，并补了空串用例。我**独立复现**了篡改验证，结论与你的描述一致。

在此基础上，按复审要求 3 我对 round1/round2 已看过的断言又做了 3 组反向篡改，其中 **2 组有效捕获回归**，另发现 **1 个低优先级测试覆盖缺口**（不阻塞合并，且产品代码本身正确、该不变量已被另一处测试守住），见 §2。

`npm run build` 通过；`npm test` 全量 **301 files passed / 1 skipped，3777 tests passed / 14 skipped**，与你的验证状态一致。

---

## 2. 问题列表

### 低（不阻塞合并）

#### L-1 `session-date-notice.spec.ts` 的「shallow-copy trap」用例名不副实，实际未覆盖数组分支的原地修改

- **位置**：`backend-ts/src/harness/core/session-date-notice.spec.ts:89-97`
- **问题描述**：
  该用例名为 `does not mutate the original nested content array (shallow-copy trap)`，但其构造的消息 `user('hello', '2026-10-13')` 的 content 是**字符串**，走的是字符串分支——**从未触及它声称的「嵌套 content 数组」**。断言 `textOf(original[0])).toBe('hello')` 在数组分支被改成原地 `unshift` 时依然成立（字符串对象未被碰过）。

  同文件的 `multimodal content gains a leading text part and keeps image order`（`:76-87`）虽然用了数组 content，但它是**直接对 `messages` 本身**调用 `applyDateChangeNotices`，没有保留一份独立的「原数组」引用可比对；原地 unshift 后 `parts` 仍是 length 3、`parts[0].type === 'text'`、`parts[1] === imageA`、`parts[2] === imageB`，断言全部成立，同样抓不到原地修改。

- **为什么是 bug（业务影响）**：
  本需求最核心的安全属性之一是「标签只写请求副本，不污染 `context.messages`」。方案 §5.3 与 §7 都把「浅拷贝陷阱回归测试」列为必测项，而这两个用例恰好都抓不到这个回归。若将来有人把数组分支改回原地 `unshift`（注释里明确警告过禁止这么做），`session-date-notice.spec.ts` 会全绿放行。

  实际影响被限制在低优先级，因为该不变量**已被 `prompt-engine.spec.ts` 的多模态用例守住**（见下方验证），坏味道不会直接漏到生产。但纯函数自己的 spec 守不住自己的核心不变量，属于测试布局缺陷。

- **验证用测试用例**（已实测复现）：
  第一步，把 `session-date-notice.ts:46-48` 的数组分支篡改为原地 unshift：
  ```ts
  // 篡改前（当前正确实现）
  messages[i] = Array.isArray(msg.content)
    ? { ...msg, content: [{ type: 'text', text: tag }, ...(msg.content as ContentPart[])] }
    : { ...msg, content: `${tag}\n\n${stringifyContent(msg.content)}` };

  // 篡改后（复现 round1 前的隐患写法）
  if (Array.isArray(msg.content)) {
    (msg.content as unknown[]).unshift({ type: 'text', text: tag });
  } else {
    messages[i] = { ...msg, content: `${tag}\n\n${stringifyContent(msg.content)}` };
  }
  ```
  实测结果：
  ```
  npx vitest run src/harness/core/session-date-notice.spec.ts
  → Tests  18 passed (18)      ← 应该失败，假通过

  npx vitest run src/harness/core/prompt-engine.spec.ts
  → × 多模态用户消息跨天：头部新增 text part，图片顺序不变
    → expected 2 to be 1      ← prompt-engine 侧正确捕获
  ```

  第二步，给出能真正守住的原数组比对用例（加在 `session-date-notice.spec.ts` 即可）：
  ```ts
  it('does not mutate the original nested content array (real shallow-copy trap)', () => {
    const image = { type: 'image_url', imageUrl: { url: 'data:a' } };
    const original: ChatMessage[] = [{ role: 'user', content: [image], senderYmd: '2026-10-13' }];
    // buildRequest 的浅拷贝：content 数组与原对象共享引用
    const copy = original.map((m) => ({ ...m }));
    applyDateChangeNotices(copy, '2026-10-12', null);

    // 原数组与嵌套 content 数组都未被原地改动
    expect(original[0].content).toHaveLength(1);
    expect((original[0].content as Array<{ type?: string }>)[0].type).toBe('image_url');
    // 副本是全新数组，且标签在最前
    const parts = copy[0].content as Array<{ type?: string; text?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('<date-change>');
    expect(parts[1]).toBe(image);
  });
  ```
  该用例在正确实现下通过；在上述原地 unshift 篡改下会因 `expect(original[0].content).toHaveLength(1)` 失败（实际 length 2）。

- **修复建议**（交给后续 worker，本次不改）：
  把 `session-date-notice.spec.ts:89` 那条用例的 content 从字符串改为数组（或直接替换为上方用例），让纯函数自己的 spec 守住自己的核心不变量。同时可给 `:76` 的 multimodal 用例补一句 `expect(imageA 引用未被移动)` 之外的原数组长度断言。产品代码无需改动。

---

## 3. 逐项复核结论

### 3.1 篡改验证结论复现（复审要求 1）

完全按你描述的方法**独立复现**，未仅采信你的描述：

| 步骤 | 操作 | 结果 |
|---|---|---|
| 0 | 记录 `session-history-loader.ts` md5 = `d27f08f2…`，未篡改先跑基线 | ✅ 1 passed |
| 1 | 篡改：`const ymd = …; return ymd.length === 10 ? ymd : null;` → `return previous?.createdAt ? String(…).slice(0,10) : null;` | — |
| 2 | 跑 `applyHistoryIgnoresUnparseablePreviousUserStamp` | ❌ **1 failed**，`expected '2026-10-1' to be null` |
| 3 | 从备份恢复，md5 回到 `d27f08f2…` | ✅ 与篡改前一致 |
| 4 | 重跑该测试 | ✅ 1 passed |

**结论：你的篡改验证结论成立。** 该测试现在真正守住 `ymd.length === 10` 保护。恢复动作也经过 md5 与 `git show HEAD:` 双重比对确认逐字节还原。

### 3.2 第二段空串用例的价值（复审要求 2）

新增的第二段（`createdAt: ''` → 期望 null）**有效且不与第一段重复**，两段守护的是不同回归点。用两种独立篡改分别验证：

| 篡改方式 | 第一段（`'2026-10-1'`） | 第二段（`''`） |
|---|---|---|
| A：删长度校验（保留 `previous?.createdAt` 空值短路） | ❌ 失败（`expected '2026-10-1' to be null`） | ✅ 通过（`''` 走 falsy 短路仍返回 null） |
| B：删空值短路（改为 `String(previous?.createdAt ?? '').slice(0,10)`，保留长度校验） | ✅ 通过（`'2026-10-1'` 长度 9 被拦） | ✅ 通过（`''` → 长度 0 被拦） |

即：第一段独家捕获「长度校验」回归；第二段对两种篡改都不敏感（属既有行为的防守性固化，防的是将来有人把 `previous?.createdAt ?` 整个判断删成 `String(previous.createdAt)` 导致 `null` 被 `String()` 成 `'null'` 之类的退化）。**保留有价值，不算无意义重复。**

另外确认第一段不会误伤合法输入：`createdAt: '2026-10-12 23:59:00'` 仍正确返回 `'2026-10-12'`（已实测）。

### 3.3 其他「名不副实 / 假有效」测试排查（复审要求 3）

挑了 3 组最有价值的断言做反向篡改：

| # | 断言 | 篡改方式 | 结果 | 判定 |
|---|---|---|---|---|
| 1 | `session-date-notice.spec.ts` 浅拷贝陷阱（2 条相关用例） | 数组分支改原地 unshift | ❌ **18 passed 全绿** | ⚠️ 假有效（见 §2 L-1） |
| 2 | `prompt-engine.spec.ts` 含快捷命令 marker 且跨天 | `{ ...msg, content: replaced }` → `{ role:'user', content: replaced }`（退回 round1 bug） | ❌ 失败（`expected '请审查本次改动 隔天的任务' to contain '<date-change>'`） | ✅ 有效 |
| 3 | `senderYmd` 不外泄（3 个适配器） | `json.ts` 序列化白名单加 `out.senderYmd` | ❌ 失败（`to not have property "senderYmd"`） | ✅ 有效 |
| 3b | 同上（anthropic） | `convertMessages` user 分支追加 senderYmd text block | ❌ 失败（`to deeply equal`） | ✅ 有效 |

补充确认：round1/round2 已另行验证过有效的断言（`applyHistoryDegradesToNullWhenPreviousUserStampQueryFails`、`回注的窗口外用户消息…边界行为固化`、`prompt-engine.spec.ts` 多模态浅拷贝、压缩严格前缀、`isRealUserMessage`、锚点五兜底、幂等性等）本轮未重复篡改，但其覆盖的实现代码（`session-history-loader.ts` / `session-date-notice.ts` / `prompt-engine.ts`）在 round3 中**未被修改**（`git show 2eddae13` 只动了 spec 文件），故这些断言的有效性不受本轮影响。

### 3.4 工作区清洁度（复审要求 4）

- `git status`：**干净**，无任何未跟踪/已修改文件（连报告文件也是在撰写本报告时才创建）
- `git diff HEAD --stat`：**为空**
- 所有被篡改的 5 个源码文件（`session-history-loader.ts` / `session-date-notice.ts` / `prompt-engine.ts` / `json.ts` / `anthropic-llm-adapter.ts`）均已还原，逐一与 `git show HEAD:<path>` 做 md5 比对全部 MATCH
- 临时探针 `zz-r3-probe.spec.ts` 已删除，`src/harness/core/` 下无 `zz-` 残留
- `npm run build` 通过；`npm test` 全量 301 files passed / 1 skipped，3777 tests passed / 14 skipped

---

## 4. 变更历史

- 2026-10-12 round1：1 高（H-1 容错缺失）/ 1 中（M-1 回注边界）/ 2 低（L-1 重复实现、L-2 类型断言）
- 2026-10-12 round2：H-1 / L-1 / L-2 已修复；M-1 固化现状；新发现 1 低（`applyHistoryIgnoresUnparseablePreviousUserStamp` 假有效）
- 2026-10-12 round3：round2 的问题已修复并独立复现验证；新发现 1 低（`session-date-notice.spec.ts` 浅拷贝用例名不副实，不阻塞合并）
