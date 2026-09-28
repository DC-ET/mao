# 代码审查报告（第二轮）：飞书卡片点踩反馈

**日期**：2026-09-28
**审查范围**：git 工作区未提交改动（第一轮 6 项修复后的当前状态）
**审查重点**：确认第一轮问题是否真正修复、是否引入新问题；重点核对 `uk_message(message_id)` 唯一键下 desktop / feishu 记录能否真正共存。

**验证记录**：
- `cd backend-ts && npm test` → Test Files 219 passed / 1 skipped，Tests **2311** passed / 14 skipped（第一轮 2305，新增 6 条）
- `cd admin && npm run build` → 通过
- `npx tsc --noEmit -p tsconfig.json` → 第一轮报告的 3 处新增类型错误已全部消除
- **MySQL 8.0.46 实测**：在 `mao_e2e` 库按 V123 建表 + V125 迁移复现唯一键行为（临时表 `t_feedback_review`，验证后已 DROP）

---

## 总体结论

**本轮修复引入了 1 个阻塞级问题（问题 3 的修复方案本身不成立），不建议按当前状态合并。**

第一轮 6 项问题中，1、2、5、6、7 已正确修复；但**问题 3 的修复（source 隔离 toggle）建立在一个错误前提上**：`message_feedback` 的唯一键是 `uk_message(message_id)`，未包含 `source`，因此同一条消息在库里**最多只能存在一行**。所谓"桌面 + 飞书各自一条、互不影响"在物理上不可能成立。经 MySQL 实测，飞书 upsert 会把已有的桌面记录**整行覆盖**成 `source='feishu', reason='NO_REASON'`，比第一轮的"互相取消"更糟——桌面记录连同它的 `WRONG_RESULT` 原因一起丢失，后台统计凭空少一次点踩。

代码本身逻辑自洽、类型干净、测试全绿，但**测试之所以全绿是因为它 mock 掉了 repository，从未触达真实唯一键语义**。这是一个典型的"单测通过而线上错误"的假绿场景。

---

## 问题列表

### 阻塞

#### 1. `uk_message(message_id)` 唯一键不含 `source`，同一条消息无法同时存在 desktop 与 feishu 两行记录；飞书 upsert 会整行覆盖桌面记录

**文件**：`backend-ts/db/migration/V123__message_feedback.sql:13`（唯一键定义）、`backend-ts/db/migration/V125__message_feedback_source.sql:5`（只加列、未改唯一键）、`backend-ts/src/feedback/feedback.repository.ts:49-56`（upsert）、`backend-ts/src/feedback/feedback.service.ts:111-125`（toggleSessionDislike）

**问题描述**：`feedback.service.ts:106-109` 的注释明确断言：

> 判定按 source 隔离：飞书 toggle 只增删自己的 feishu 记录，不与桌面端记录互相取消（**同一条消息最多一条桌面 + 一条飞书记录，各自 toggle 互不影响**）。

这个前提不成立。V123 建表语句为：

```sql
UNIQUE KEY `uk_message` (`message_id`),
```

唯一键只含 `message_id`，**不含 `source`**。V125 只 `ADD COLUMN source`，没有 `DROP INDEX uk_message` 再建 `(message_id, source)` 复合唯一键。因此 `message_id` 全局唯一，同一条消息只能有一行。

`upsert` 的 `ON DUPLICATE KEY UPDATE reason = VALUES(reason), source = VALUES(source)` 在唯一键冲突时会**整行覆盖**，包括 `source` 列。

MySQL 实测（`mao_e2e` 库，临时表按 V123+V125 还原）：

```
-- 桌面端先点踩 message_id=11
INSERT ... VALUES (11,5,9,2,'WRONG_RESULT','desktop');
  → 1 行: id=1, source=desktop, reason=WRONG_RESULT

-- 飞书 toggleSessionDislike(9,5,'feishu')
SELECT id FROM ... WHERE message_id=11 AND source='feishu';   -- 返回 0 行（exists=false，符合预期）
INSERT ... VALUES (11,5,9,2,'NO_REASON','feishu') ON DUPLICATE KEY UPDATE reason=..., source=...;
  → 仍只有 1 行: id=1, source=feishu, reason=NO_REASON    ← 桌面记录被整行覆盖！
```

反向顺序同样覆盖：

```
-- 飞书先点踩，桌面端点踩同一条消息
INSERT ... ('NO_REASON','feishu');
INSERT ... ('WRONG_RESULT','desktop') ON DUPLICATE KEY UPDATE ...;
  → 1 行: source=desktop, reason=WRONG_RESULT             ← 飞书记录被覆盖
```

**影响**（按严重度递增）：

1. **桌面端点踩记录被静默吞掉**：用户在桌面端对某条结果点踩（选了"结果错误"），之后在飞书对同一会话点「不满意」，桌面那条记录连同原因一起消失。用户视角是"我明明点过踩，怎么没了"。
2. **后台统计虚高/虚低**：实测 `SELECT reason, COUNT(*) FROM message_feedback GROUP BY reason` 在上述场景下 `WRONG_RESULT` 计数归零、`NO_REASON` 计 1。两次真实反馈只统计到一次，且原因分布失真——这正是本需求要补的统计样本。
3. **桌面端回显错乱**：`listMessageIdsBySession` 仍返回该 message_id，但记录已变成 `feishu` / `NO_REASON`。桌面端 `MessageBubble` 会显示"已点踩"，而用户实际选的原因是桌面端那四个之一，被改成了飞书的"未选择原因"。
4. **`cancelDislike` 连带误删**：`cancelDislike` 走 `deleteByMessageId(messageId)` 不带 source，会删掉唯一那一行——无论它当前是哪来的。桌面用户取消点踩可能删掉飞书的记录，反之亦然。

第一轮的修复方向（按 source 隔离判定）在"每源一行"的语义下是正确的，但**漏了配套的 DDL**：必须把唯一键改成 `(message_id, source)`，否则隔离逻辑读到的是错的数据。

**修复建议**：在 `V125__message_feedback_source.sql` 中补一条唯一键变更，让隔离前提真正成立：

```sql
ALTER TABLE `message_feedback` DROP INDEX `uk_message`, ADD UNIQUE KEY `uk_message_source` (`message_id`, `source`);
```

注意这会改变 Flyway 迁移的 checksum（V125 尚未在线上执行，属于本次需求新增文件，可以直接改；若已执行则需新增 V126 而非改 V125）。同时：

- `feedback.service.ts:106-109` 注释里的"最多一条桌面 + 一条飞书"在改键后即成立，可保留；
- `listMessageIdsBySession` 需评估是否应按 `source='desktop'` 过滤（否则桌面回显会把飞书点踩的消息也标成已点踩）——当前桌面端 `dislikeMessage`/`removeDislike` 只按 message_id 操作，两源共存后回显语义需要明确；
- `cancelDislike` 建议显式传 `source='desktop'`，避免桌面取消误删飞书记录。

若产品上明确要求"同一条消息只保留一个反馈"（桌面与飞书互斥），则应放弃 source 隔离方案，回到第一轮的单一记录语义，并把 `toggleSessionDislike` 改成"覆盖 reason/source"而非"删除"，同时更新方案文档与 `feedback.service.ts:106-109` 的注释。两种走法都要与需求方确认，当前中间态（隔离判定 + 单行覆盖）是最坏组合。

### 重要

#### 2. `renderCurrent()` 每次重算 `elapsedMs`，点踩时刻离完成越久，卡片耗时读数越虚高

**文件**：`backend-ts/src/feishu/patched-progress.ts:87-91`（`renderCurrent`）

**问题描述**：`renderCurrent()` 里 `elapsedMs = Math.max(0, now() - deps.startedAtMs)`，用**调用时刻**重新计算，没有复用完成时 `update('COMPLETED', ...)` 算出的那份值。而 `startedAtMs` 是任务起算时刻，永久不变。

实测（`startedAtMs=0`，完成时刻 `now=506_000`，10 分钟后点踩 `now=1_106_000`）：

```
完成瞬间 renderCurrent: elapsed=506000   → 「耗时 8 分 26 秒」
10分钟后点踩 renderCurrent: elapsed=1106000  → 「耗时 18 分 26 秒」
```

**影响**：用户在飞书群里过了几分钟甚至几小时才点「不满意」，卡片上的"耗时"会从真实的 `8 分 26 秒` 跳到 `18 分 26 秒` 乃至更夸张。用户感知是"点了个踩，任务耗时数据被改了"，且这个数字与任务实际耗时不符。因为点踩按钮长期挂在完成卡上，这个偏差几乎必然发生（只是幅度取决于用户多久后点）。

第一轮问题 1 的修复改走 `renderCurrent()` 后引入此问题——原来的空壳卡传 `elapsedMs=undefined`，反而不显示耗时，掩盖了它。

**修复建议**：把完成态的耗时在 `update('COMPLETED', ...)` 时固化到快照里，`renderCurrent()` 直接复用。最小改动是在 `patched-progress.ts` 中缓存终态 elapsed：

```ts
let terminalElapsedMs: number | undefined;
// send() 内：
const elapsedMs = status === 'RUNNING' ? undefined : Math.max(0, now() - deps.startedAtMs);
if (status !== 'RUNNING') terminalElapsedMs = elapsedMs;
// renderCurrent() 内：
const elapsedMs = last.status === 'RUNNING' ? undefined : terminalElapsedMs;
```

这样点踩回调拿到的卡片与完成瞬间 PATCH 出去的卡片在耗时上完全一致，只差按钮态。

### 建议

#### 3. 跨 source 共存的回归测试是假绿：mock 掉 repository 后从未触达唯一键语义

**文件**：`backend-ts/src/feedback/feedback.spec.ts:203-212`（`ignores a desktop-source record on the same message (cross-source isolation)`）

**问题描述**：该测试用 `exists.mockImplementation(async (_messageId, source) => source === 'desktop')` 模拟"库里存在桌面记录、不存在飞书记录"，然后断言 `deleteByMessageId` 未被调用、`upsert` 被调用。逻辑上验证了"飞书 toggle 在 exists(feishu)=false 时走 insert 分支"，**但没有验证 insert 之后库里到底剩几行**——因为 `repo.upsert` 本身是 `vi.fn()`，真实 SQL 与唯一键约束完全没参与。

同理 `feedback.repository.spec.ts` 的 `existsByMessageIdScopesBySource` / `deleteByMessageIdScopesBySource` 只断言 SQL 字符串与参数拼接，`db` 是假的，`ON DUPLICATE KEY UPDATE` 的真实行为同样未触达。

这正是问题 1 能带着"全绿测试"通过的原因。

**修复建议**：补一条真实 DB 的集成测试（项目已有 e2e 库 `mao_e2e` 与 `.env.e2e` 机制），或在 `feedback.repository.spec.ts` 中用一个实现了 `uk_message` 语义的内存 fake（`message_id` 唯一、重复 insert 覆盖）替代纯 `vi.fn()`，把"同消息两源共存"这条不变量钉住。否则唯一键一旦被无意改回，测试仍然全绿。

#### 4. `progress-card.spec.ts:118` 与 `card-action.service.spec.ts` 存在格式塌陷与缺失断言

**文件**：`backend-ts/src/feishu/progress-card.spec.ts:118`

**问题描述**：`describe('飞书进度卡片「会话详情」按钮', () => {  const cancelAction = ...` —— `{` 后与首条语句挤在同一行，是本次编辑留下的格式损坏（`git diff` 显示原为两行）。不影响运行与类型检查，但可读性差，且说明该处是手工拼接修改。

另外 `card-action.service.spec.ts` 的「快照缺失时退回完成态空卡」用例断言 `expect(json).not.toContain('取消任务')`，能挡住"误渲染成 RUNNING 带取消按钮"，但未断言兜底卡同样不含 `耗时` 读数（兜底卡传 `elapsedMs=undefined`，当前确实不显示，行为正确）。此处无需改，仅记录已核对。

**修复建议**：把 `progress-card.spec.ts:118` 恢复为两行。

---

## 逐项复核结论

| 第一轮问题 | 状态 | 说明 |
| --- | --- | --- |
| 1. 完成卡正文被抹掉 | **已修复，但引入新问题** | 改走 `renderProgressCard` 保住轮次/正文，方向正确；但 `renderCurrent` 的 elapsedMs 重算导致耗时虚高（本轮问题 2）。快照缺失兜底为完成态空卡、不渲染 RUNNING，处理合理且有测试覆盖。 |
| 2. 群内 PATCH 空操作 | **已修复** | 按方案 5.2.6 删除 `refreshLater` 调用，spec 改为断言 `not.toHaveBeenCalled()`。代码注释与行为现已一致。 |
| 3. 跨 source 互相取消 | **未真正修复，且为阻塞项** | service 层隔离逻辑写对了，但缺配套 DDL，唯一键仍只含 `message_id`，隔离前提不成立；实际行为比第一轮更糟（静默覆盖）。见本轮问题 1。 |
| 5. spec 类型错误 | **已修复** | `CardElement` 补 `type?: string`；`progress-card.spec.ts:174` 参数错位已修正为 `buildFeishuProgressCard(status, 1, '', [], { sessionId: 7, sender: 'ou_sender', botId: 1 }, 1000, detailUrl)`；`ask-mount.spec.ts` mock 补 `setDisliked`。`tsc --noEmit` 相关文件已零错误。 |
| 6. admin 整页不可用 | **已修复** | `refreshAll` 改 `Promise.allSettled`，`fetchSummary` 加 try/catch 并对 `total`/`byReason`/`byDay` 逐字段兜底。无新引入空态问题（`byReason` 兜底为 `[]` 时 `reasonOptions` 为空数组，下拉显示 placeholder「全部」，不抛错）。 |
| 7. 未使用导入 | **已修复** | `feedback.service.ts` 已不再导入 `FEISHU_DISLIKE_SOURCE`。 |

## 用户特别关注点的直接回答

- **toggle 时序**：正确。`create-app.ts:1916-1918` 先 `await feedbackService.toggleSessionDislike(...)` 落库，成功后才 `setDisliked(result.disliked)`；`card-action.service.ts:184-188` 再 `renderProgressCard()`。`setDisliked` 严格先于渲染。若 `toggleDislike` 抛错，`setDisliked` 不会执行，卡片保持原态，行为正确。
- **快照缺失兜底**：合理。退回 `buildFeishuProgressCard('COMPLETED', 0, '', [], ...)`，`status='COMPLETED'` 不会误带「取消任务」按钮，也有专门用例锁定。
- **source 隔离后能否共存**：**不能**。这是本轮的核心结论，详见问题 1。唯一键 `uk_message(message_id)` 未含 `source`，物理上只允许一行；飞书 upsert 会整行覆盖桌面记录。隔离逻辑与 DDL 不匹配，需要补 `DROP INDEX` + 复合唯一键，或退回互斥语义并改覆盖式实现。
- **SQL 注入/参数错位**：无问题。`filter` 是硬编码字符串片段（`' AND source = ?'` 或 `''`），`source` 值通过 `?` 占位符传入，不参与字符串拼接；`[messageId, source]` 与两个占位符一一对应，无错位。
- **测试是否假绿**：是，问题 3 存在假绿。详见本轮问题 3。
- **admin 新空态/异常**：无新问题。`byReason` 缺省为 `[]` 时 `reasonOptions` 为空，`el-select` 有 `placeholder="全部"`，不会白屏也不会抛错。
