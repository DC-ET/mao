# 代码审查报告（第三轮）：飞书卡片点踩反馈

**日期**：2026-09-28
**审查范围**：git 工作区未提交改动（第二轮后按方案 5.2 回退 source 隔离 + 修复耗时虚高 + 测试加固）
**审查重点**：回退后与方案 5.2 第 4 步一致性；`terminalElapsedMs` 固化是否引入新问题；内存 fake DB 测试是否真实有效；前两轮已修复问题是否回归。

**验证记录**：
- `cd backend-ts && npm test` → Test Files 219 passed / 1 skipped，Tests **2313** passed / 14 skipped（第二轮 2311，净增 2）
- `cd admin && npm run build` → 通过
- `npx tsc --noEmit -p tsconfig.json` → 本次改动涉及文件零错误
- 另写一次性探针 spec 实测 `terminalElapsedMs` 在 4 类时序下的取值（见下），探针已删除

---

## 总体结论

**未发现可触发功能 bug 的问题，可以合并。**

本轮回退方向正确，`toggleSessionDislike` 与方案 5.2 第 4 步完全一致；`terminalElapsedMs` 固化的 4 类时序（FAILED→COMPLETED、seed RUNNING、多次终态、RUNNING 期点踩）取值全部正确，未引入新问题；内存 fake DB 测试真实有效，不是假绿。仅存 1 处遗留注释与实际行为不符（不影响功能，属文档债）。

---

## 复核结论

### 1. 回退后的 `toggleSessionDislike` 与方案 5.2 第 4 步：完全一致

方案原文：「toggle：`message_feedback` 中该 `message_id` 有记录则删除，无记录则插入（`reason=NO_REASON, source=feishu`）」。

`feedback.service.ts:111-125` 实现：

```ts
const exists = await this.repository.existsByMessageId(messageId);   // 不传 source
if (exists) {
  await this.repository.deleteByMessageId(messageId);               // 不传 source
  return { disliked: false };
}
const agentId = await this.sessionAgentLookup(sessionId);
await this.repository.upsert(messageId, sessionId, owner, agentId, FEISHU_DISLIKE_REASON, source);
return { disliked: true };
```

`existsByMessageId(messageId)` / `deleteByMessageId(messageId)` 均已去掉 source 参数，SQL 恢复为 `WHERE message_id = ?`，与 V123 的 `uk_message(message_id)` 匹配。`upsert` 仍写 `source=feishu`（`create-app.ts:1916` 传 `FEISHU_DISLIKE_SOURCE`），与方案括号内要求一致。注释也准确说明了互斥语义及其与桌面端覆盖语义的关系。V125 保持只加列不改唯一键，符合方案 4.1。

**桌面端 `dislike()` 与飞书 toggle 混用的最终态自洽性**：两者共用同一条 `message_id` 行，最终态有且仅有一行，`source`/`reason` 反映最后一次操作。桌面端点踩（`WRONG_RESULT`/`desktop`）→ 飞书点一次 = 删除该行、卡片显示未点踩；飞书点踩（`NO_REASON`/`feishu`）→ 桌面端点踩 = 覆盖为 `WRONG_RESULT`/`desktop`。行为与桌面端「已点踩可重新选择原因」的覆盖语义同构，无中间态、无脏行。这正是方案选择的语义，实现与方案一致。

### 2. `terminalElapsedMs` 固化：4 类时序取值全部正确，未引入新问题

`patched-progress.ts:65-68` 在 `send()` 进入非 RUNNING 时固化：

```ts
if (status !== 'RUNNING') {
  deps.clearAsks();
  terminalElapsedMs = Math.max(0, now() - deps.startedAtMs);
}
const elapsedMs = status === 'RUNNING' ? undefined : terminalElapsedMs;
```

`renderCurrent()` 改为 `last.status === 'RUNNING' ? undefined : terminalElapsedMs`。实测 4 类时序：

| 场景 | 结果 | 判定 |
| --- | --- | --- |
| FAILED(1分40秒) → 10分钟后 COMPLETED | `耗时 15 分` | 正确。`terminalElapsedMs` 被后一次终态 update 刷新为当前值，不会残留 FAILED 时刻的旧读数 |
| seed RUNNING（崩溃恢复）→ COMPLETED | `耗时 13 分 20 秒`，10 分钟后 `renderCurrent()` 仍 `13 分 20 秒` | 正确。`startedAtMs` 取 `session.startedAt`（崩溃前起算），首次终态 update 即固化 |
| COMPLETED(3分20秒) → CANCELLED | `耗时 11 分 40 秒` | 正确。同一闭包出现两种终态时后者覆盖前者，与 `last.status` 同步 |
| 仅 seed RUNNING、无任何 update 时 `renderCurrent()` | `**状态：正在处理** · 第 1 轮`，不含耗时 | 正确。`terminalElapsedMs` 为 `undefined`，RUNNING 分支也不读它 |

关键点：`terminalElapsedMs` 与 `last.status` 的终态判定条件一致（都是 `status !== 'RUNNING'`），不存在"`last` 是终态但 elapsed 未固化"或反过来的窗口。FAILED→COMPLETED 的重试路径中，新 progress 闭包会重新创建并重新固化，旧闭包的残留值不影响新卡。

新增回归测试 `patched-progress.spec.ts:130-155` 用可控时钟验证了"完成 8 分 26 秒、10 分钟后点踩仍 8 分 26 秒且不含 18 分"，与本轮修复目标精确对应，是真断言。

### 3. 内存 fake DB 测试：真实有效，非假绿

`feedback.repository.spec.ts:105-197` 的 `makeUniqueKeyDb()` 用 `Map<messageId, row>` 实现 `uk_message` 覆盖语义，并驱动**真实的** `FeedbackRepository` 代码路径（不是 mock repository）。实测其判别力：

- **能抓住第二轮的方向性错误**：若有人把 `existsByMessageId` 改回带 `source` 的 SQL，fake 的正则 `/SELECT id FROM message_feedback WHERE message_id = \? LIMIT 1/` 不匹配 → `queryOne` 返回 `null` → `exists` 判 false → toggle 走 insert 分支 → `同一条消息只有一个 feedback 行` 这条断言会在"桌面记录已被飞书记录覆盖"处暴露不一致。
- **DELETE 正则 `/^DELETE FROM message_feedback WHERE message_id = \?$/`**：带 source 的 DELETE 不匹配 → `throw new Error('unexpected sql: ...')`，测试直接失败而非静默通过。锚定严格，方向正确。
- **INSERT 正则 `/^INSERT INTO message_feedback/`**：能抓住 repository 真实的 upsert SQL，`rows.set` 体现整行覆盖。

正则严格度评价：`exists`/`DELETE` 用 `\?` 精确匹配占位符，不会因多余条件而误命中；`INSERT` 只锚前缀，足以覆盖 `INSERT ... ON DUPLICATE KEY UPDATE` 全句式，不过严也不过松。

**该 fake 的边界（不影响本轮结论，仅记录）**：它表达的是"repository 按 messageId 判定"，无法检测 DDL 层把唯一键改成 `(message_id, source)`。这一点 fake 的注释已自述「防止有人给唯一键加 source 后失配」，实际能防的是代码层失配；DDL 层失配需靠 e2e 或 migration review 兜底。本轮 DDL 未改，与 fake 语义一致，无矛盾。

`feedback.spec.ts` 的 cross-source 用例已从第二轮的"隔离"改为锁定互斥语义（有桌面记录时飞书 toggle 走删除分支、`upsert` 不被调用），与新语义一致。

### 4. 前两轮已修复问题：无回归

| 项目 | 状态 |
| --- | --- |
| 第一轮问题 1（完成卡正文被抹掉） | 保持修复：仍走 `renderProgressCard` 快照，保住轮次/正文/工具 |
| 第一轮问题 2（群内 PATCH 空操作） | 保持修复：无 `refreshLater`，spec 断言 `not.toHaveBeenCalled()` |
| 第一轮问题 5（spec 类型错误） | 保持修复：`tsc --noEmit` 相关文件零错误 |
| 第一轮问题 6（admin 整页不可用） | 保持修复：`Promise.allSettled` + try/catch + 逐字段兜底 |
| 第一轮问题 7（未使用导入） | 保持修复 |
| 第二轮问题 1（唯一键缺 source） | 已按方案回退，DDL 与代码语义重新对齐 |
| 第二轮问题 2（耗时虚高） | 已修复，见上文第 2 点 |
| 第二轮问题 4（`progress-card.spec.ts:118` 格式塌陷） | 已修复：`describe(...)` 与 `const cancelAction` 已恢复为两行 |

### 5. 用户特别关注点的直接回答

- **与方案 5.2 第 4 步是否完全一致**：是。见上文第 1 点。
- **桌面端与飞书混用最终态是否自洽**：自洽。最终恒为一性单行，`source`/`reason` 反映最后一次操作，无中间态。
- **`terminalElapsedMs` 是否引入新问题**：否。4 类时序实测取值全部正确，与 `last.status` 判定条件一致，无残留旧值窗口。
- **fake DB 是否假绿**：否。实测能抓住带 source 的 SQL 回归，DELETE 分支对意外 SQL 直接抛错。
- **前两轮问题是否回归**：无回归。

---

## 遗留（不阻塞，建议顺手处理）

#### `create-app.ts:1910-1911` 注释描述了第二轮已删除的 PATCH 行为

**文件**：`backend-ts/src/create-app.ts:1910-1911`

```ts
// 完成卡「点踩」toggle：写库/删库 message_feedback（source=feishu），并把点踩态同步给
// 本会话的进度卡闭包，供随后给群里其他人补的 PATCH 渲染「已点踩 · 再点取消」。
```

**问题描述**：第二轮已按方案 5.2.6 删除 `refreshLater` 调用（群内其他人不做额外 PATCH），但 `create-app.ts` 这处注释仍写着"供随后给群里其他人补的 PATCH 渲染"，与实际行为不符。

**影响**：纯注释过期，不影响功能。但读者会误以为存在一条群内 PATCH 路径，未来若有人据此"补上"PATCH，反而偏离方案。`card-action.service.ts:174` 的注释（「与方案一致：群内其他人只更新点击者视图，不做额外 PATCH」）已更新，两处不一致。

**修复建议**：把这行改为描述实际用途，例如「并把点踩态同步给本会话的进度卡闭包，使点击者的回调卡片（及后续若发生的进度 PATCH）渲染「已点踩 · 再点取消」」。
