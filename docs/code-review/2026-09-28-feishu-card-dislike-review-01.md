# 代码审查报告：飞书卡片点踩反馈

**日期**：2026-09-28
**审查范围**：git 工作区未提交改动（15 个代码文件 + 1 个新增迁移；CHANGELOG.md / skills/mao-cli/reference/feedback.md / desktop/package*.json 按约定不审查）
**需求概述**：飞书任务完成卡片（COMPLETED 终态）新增「👎 不满意」点踩按钮（toggle，置于「会话详情」左侧），点踩固定原因 `NO_REASON`、来源 `feishu`；仅消息发送者可操作；状态以 `message_feedback` 表为准；管理后台明细新增「来源」列、原因筛选项改读汇总接口 `byReason`。

**验证记录**：`cd backend-ts && npm test` → Test Files 219 passed / 1 skipped，Tests 2305 passed / 14 skipped；`cd admin && npm run build` → 通过。`npx tsc --noEmit -p tsconfig.json` 存在大量**存量** spec 类型错误（auth/inbound-processor 等，与本次改动无关），但本次改动的 spec 引入了 3 处新的类型错误（见问题 5）。

---

## 总体结论

**可合并，无阻塞项。**

发现 3 个重要问题（点踩后完成卡正文/轮次/耗时被抹掉、群内其他人的 PATCH 实际不生效、toggle 后再次点击会重复计数）+ 2 个建议项。问题 1、2 直接影响用户可见的飞书卡片内容，建议在发布前修复；问题 3 影响统计准确性但不影响主链路可用性。

---

## 问题列表

### 重要

#### 1. 点踩回调返回的卡片抹掉了完成卡正文、轮次与耗时

**文件**：`backend-ts/src/feishu/card-action.service.ts:192-197`

**问题描述**：`handleProgressDislike` 回调内直接重建一张"空壳"完成卡：

```ts
data: buildFeishuProgressCard(
  'COMPLETED', 0, '', [],          // ← round=0、content=''、tools=[]
  { sessionId: action.sessionId, sender: action.sender },
  undefined, await this.resolveSessionDetailUrl(action.sessionId),
  undefined, result.disliked,
),
```

`round=0` + `content=''` + `tools=[]` + `elapsedMs=undefined`，返回的卡片只剩一行 `**状态：处理完成**` 和两个按钮。原始完成卡上的「共 8 轮 · 耗时 8 分 26 秒」、任务结果正文、「本轮工具」全部消失。

实测对比（同一会话、`COMPLETED, 8, '这是任务的最终结果正文…', ['read_file：执行中…'], {sessionId:7,sender:'ou_sender',botId:1}, 506000, detailUrl`）：

| | 原始完成卡 | 点踩回调返回的卡 |
| --- | --- | --- |
| 状态行 | `**状态：处理完成** · 共 8 轮 · 耗时 8 分 26 秒` | `**状态：处理完成**` |
| 正文 | `这是任务的最终结果正文，很长很重要。` | 无 |
| 本轮工具 | `- read_file：执行中…` | 无 |

**影响**：飞书卡片按钮回调的语义是「用返回的卡片替换点击者看到的卡片」。用户点一次「👎 不满意」，整张完成卡瞬间缩水成两行 —— 任务结果正文（用户正是要评价它的内容）直接消失。这是高频可见的功能回退，比「按钮没变红」严重得多。取消点踩时同样会再抹一次。

**修复建议**：回调不要自己重建空壳卡，改为复用已有快照渲染通道。`handleAskSubmit` 已有现成写法（`card-action.service.ts:251-260`）：先取 `const card = this.currentProgressCard(action.sessionId, action.sender)`，让进度卡闭包把 `disliked` 透传进 `buildCard`。即：

```ts
this.refreshLater(action.sessionId);
const card = this.options.renderProgressCard?.(action.sessionId)
  ?? buildFeishuProgressCard('COMPLETED', 0, '', [], { sessionId: action.sessionId, sender: action.sender }, undefined, await this.resolveSessionDetailUrl(action.sessionId), undefined, result.disliked);
return { toast: {...}, card: { type: 'raw', data: card } };
```

由于 `create-app.ts:1918` 已在此之前调用 `setDisliked(result.disliked)`，`renderCurrent()` 会带上正确的 toggle 态，同时保留 round/content/tools/elapsedMs。这样也与方案 5.5「以当前进度快照重建 COMPLETED 卡」的口径一致（方案明确写了"以当前进度快照"，空壳卡不符合方案）。

#### 2. 群内其他人的 PATCH 实际不会发生（`refresh` 早退）

**文件**：`backend-ts/src/feishu/active-progress.ts:29-32`（配合 `card-action.service.ts:187` 与 `create-app.ts:1964`）

**问题描述**：`handleProgressDislike` 调 `this.refreshLater(action.sessionId)` 想给群里其他人补一次 PATCH，链路是：

```
refreshLater → options.refreshProgress → feishuActiveProgress.refresh(sessionId)
             → if (entry == null || !entry.handle.isRunning()) return false;   // ← 早退
             → entry.handle.refresh() → if (last.status !== 'RUNNING') return;  // ← 又早退
```

完成卡场景 `last.status === 'COMPLETED'`，两道 `isRunning` 守卫都会拦住，`handle.refresh()` 根本不会执行，PATCH 不会发出。

**影响**：`card-action.service.ts:186` 注释与 `card-action.service.spec.ts:596-603` 的测试（「点踩回调给群内其他人补一次进度卡刷新」）都声称会补 PATCH，但实际是空操作。群内除点击者以外的人看到的按钮仍是点击前的中性灰/红色态，与需求 2.1「点踩后卡片刷新」以及方案 5.2.6「群内其他人靠回调响应只更新点击者视图」的表述都有偏差 —— 方案说不做额外 PATCH，代码却尝试做但没做成，行为与文档两头不落。

**修复建议**：二选一，保持代码与方案一致即可：
- **若按方案（推荐）**：删掉 `card-action.service.ts:186-187` 的 `refreshLater` 调用及对应 spec 断言，并修正注释 —— 完成卡场景 `refresh()` 本就是 no-op，保留它只会造成"已同步"的错觉；
- **若确实要让群里其他人也看到**：给 `FeishuProgressHandle` 增加一个终态专用的强制重绘入口（如 `repaint()`，不读 `isRunning` 守卫，直接按 `last` 快照 `patch` 一次），`refreshProgress` 对非 RUNNING 会话改走该入口。注意这会多一次飞书 API 调用，需在 3 秒回调窗口外执行（当前 `void Promise.resolve(...)` 已满足）。

#### 3. 同一条消息在桌面端与飞书端交叉 toggle 会重复计数/互相取消

**文件**：`backend-ts/src/feedback/feedback.service.ts:111-124`

**问题描述**：`toggleSessionDislike` 的判定只看 `message_feedback` 里该 `message_id` 有没有行：

```ts
const exists = await this.repository.existsByMessageId(messageId);
if (exists) { await this.repository.deleteByMessageId(messageId); return { disliked: false }; }
```

不区分 `source`、也不看 `reason`。而 `message_feedback` 对 `message_id` 是 `uk_message` 唯一键（`V123__message_feedback.sql`），同一会话的最后一条 ASSISTANT 消息只有一个 message_id。

**影响**：用户先在桌面端点踩了该消息（reason=`WRONG_RESULT`, source=`desktop`），再在飞书完成卡上点「不满意」—— 期望是新增一条飞书点踩，实际却把桌面端那条记录**删掉**并返回 `disliked: false`，卡片显示「已取消点踩」。反向亦然。后台统计上表现为"一次飞书点踩把一次桌面点踩抵消了"，总量少 1。这与桌面端"已点踩可重新选择原因"的覆盖语义（`upsert` 走 `ON DUPLICATE KEY UPDATE reason`）也不一致。

**修复建议**：让 toggle 只认飞书来源自己的记录，与桌面端语义解耦：

```ts
const exists = await this.repository.existsByMessageIdAndSource(messageId, source);
if (exists) { await this.repository.deleteByMessageIdAndSource(messageId, source); return { disliked: false }; }
```

对应 SQL（`feedback.repository.ts` 新增）：

```sql
SELECT id FROM message_feedback WHERE message_id = ? AND source = ? LIMIT 1
DELETE FROM message_feedback WHERE message_id = ? AND source = ?
```

若产品上明确希望"同一条消息只保留一个反馈"（桌面 + 飞书互斥），则应在方案中写明该语义，并给 `toggleSessionDislike` 补一条跨 source 回归测试锁定现状；当前实现既非互斥也非共存，处于中间态。

#### 4. `existsByMessageId` → `deleteByMessageId` 是非原子两步，并发点击可能漏删/重复删

**文件**：`backend-ts/src/feedback/feedback.service.ts:116-119` + `backend-ts/src/feedback/feedback.repository.ts:64-68`

**问题描述**：先 `SELECT` 判断存在、再 `DELETE`，两步之间没有事务/行锁。快速连点两次 dislike 按钮时，两次回调都可能读到 `exists=false`，随后都走 `upsert`（因唯一键最终只有一行，结果正确）；反向连点（已点踩态）时两次都可能读到 `exists=true`，第二次 `DELETE` 影响 0 行但仍返回 `disliked: false`，与库里实际状态一致，问题不大。

**影响**：极端并发下 `disliked` 返回值与最终库态可能短暂不一致，卡片渲染态与 DB 出现一拍偏差。实际触发需要用户在 3 秒内对同一按钮连点两次以上，概率低，且飞书客户端点击后有 loading，不易复现。

**修复建议**：可接受现状；若想彻底消除，把 toggle 收敛为一条 SQL（如 `INSERT ... ON DUPLICATE KEY UPDATE` 前先 `DELETE WHERE message_id=? AND source=?` 并读 `affectedRows` 决定返回值），或在 repository 层用 `db.transaction` 包住两步。

### 建议

#### 5. `progress-card.spec.ts` 与 `ask-mount.spec.ts` 新增的类型错误

**文件**：`backend-ts/src/feishu/progress-card.spec.ts:158`、`:164`、`:174`；`backend-ts/src/feishu/ask-mount.spec.ts:8-13`

**问题描述**：`npx tsc --noEmit -p tsconfig.json` 报出本次改动新引入的 3 个错误：

```
src/feishu/progress-card.spec.ts(158,20): error TS2339: Property 'type' does not exist on type 'CardElement'.
src/feishu/progress-card.spec.ts(164,20): error TS2339: Property 'type' does not exist on type 'CardElement'.
src/feishu/progress-card.spec.ts(174,60): error TS2322: Type '{ sessionId: number; sender: string; botId: number; }' is not assignable to type 'string'.
```

`CardElement` 局部类型缺 `type` 字段；`buildFeishuProgressCard(status, 1, '', [...], 1000, detailUrl)` 的第 5 个实参（action）被写成了数组，`1000` 落到了 `elapsedMs` 位、`detailUrl` 落到了 `sessionDetailUrl` 位 —— 该用例实际没有验证"非完成态不渲染按钮"，参数错位后被试对象已不是预期输入。

另外 `ask-mount.spec.ts:8` 因 `FeishuProgressHandle` 新增必选成员 `setDisliked` 而类型不兼容（该文件内 mock 未补）。

**影响**：`npm test` 全绿是因为 vitest 不做类型检查；但 `npx tsc --noEmit` 会在 CI/编辑器中报错，且第 3 个错误说明该用例的断言实际无效（假绿）。

**修复建议**：给 `CardElement` 加 `type?: string`；修正 `progress-card.spec.ts:174` 的实参为 `buildFeishuProgressCard(status, 1, '', [], { sessionId: 7, sender: 'ou_sender', botId: 1 }, 1000, detailUrl)`；给 `ask-mount.spec.ts` 的 `handle()` 补 `setDisliked: vi.fn()`。

#### 6. 管理后台原因筛选项在 `byReason` 恒为非空，但 `summary` 请求失败时会整页不可用

**文件**：`admin/src/views/feedback/FeedbackView.vue:214`、`:227-232`、`:244-246`

**问题描述**：`reasonOptions` 完全由 `summary.value.byReason` 派生。后端 `getSummary` 用 `FEEDBACK_REASONS.map(...)` 恒返回 5 项（含 count=0），所以正常情况下下拉不会是空的，这点没问题。

但 `refreshAll()` 是 `await Promise.all([fetchSummary(), fetchList()])`：任一请求失败（`fetchSummary` 未 try/catch，异常直接冒泡到 `onMounted` 未捕获），`fetchList` 也会被 Promise.all 一并拒绝，`loading` 停在 true，页面整体白屏/转圈，且没有任何错误兜底。这是本次改动前就存在的问题，但因筛选项数据源从常量改成了接口，失败时的可见影响面比以前更大（原来至少下拉还是可用的）。

**修复建议**：给 `refreshAll` 加 `try/catch`（或 `Promise.allSettled`），`fetchSummary` 失败时保留上一次 `summary` 或回退为空数组，避免一个接口失败拖垮整页；`fetchSummary` 内的 `summary.value = data ?? {...}` 也建议加一层 `byReason: data?.byReason ?? []` 兜底，防止后端异常返回缺字段时 `reasonOptions` 计算抛错。

#### 7. `FEISHU_DISLIKE_SOURCE` 在 `feedback.service.ts` 中是未使用的导入

**文件**：`backend-ts/src/feedback/feedback.service.ts:4-7`

**问题描述**：`FEISHU_DISLIKE_SOURCE` 被 import 但全文件只出现这一次（唯一使用方是 `create-app.ts:1916`，它从 `feedback.repository.js` 直接导入）。属无用导入，不影响运行。

**修复建议**：从 `feedback.service.ts` 的 import 中删除 `FEISHU_DISLIKE_SOURCE`。

---

## 已核对无问题的点

为避免重复排查，以下风险点经核对确认实现正确：

- **`upsert` 的 `ON DUPLICATE KEY UPDATE`**：已同步覆盖 `source`（`feedback.repository.ts:54`），且 `VALUES(source)` 在 MySQL 8.0.20+ 可用（项目为 MySQL8），不存在桌面端点踩后 source 停留旧值的问题。注意 `VALUES()` 在新版 MySQL 已标记 deprecated，项目内其他地方（`progress-card.repository.ts:46-47`）同样用法，保持一致即可。
- **`V125__message_feedback_source.sql` 与表结构**：`AFTER reason`、`VARCHAR(16) NOT NULL DEFAULT 'desktop'` 与 `V123` 建表匹配；版本号 V125 未与 V124 冲突（V124 是 `task_panel_preference_version`）；存量行回填语句对 NOT NULL 列是 no-op，无害。存量桌面端记录经默认值得到 `desktop`，符合方案 4.1。
- **`findLatestAssistantMessageId` 口径**：`session_id = ? AND role = 'ASSISTANT' AND deleted = 0 ORDER BY created_at DESC, id DESC LIMIT 1`，与 `getLatestAssistantReply` 走的 `listBySession`（`... AND deleted = 0 ORDER BY created_at ASC, id ASC` 后从尾部找第一条 ASSISTANT）完全等价；`deleted=0` 过滤、排序方向均一致。
- **`parseActionValue` 放行 dislike + 未知 act 兜底**：`card-action.service.ts:373` 已加入 `obj.act !== 'dislike'` 判断，未知 act 仍返回 null 由 `handle()` 早退（有 `ignores progress action with unsupported act` 测试覆盖）。
- **飞书 3 秒约束**：toggle 链路只有 3 次轻量 DB 查询 + 1 次 `settingService.getEcpConfig()`（走 settingRepo 单行查询），无外部 HTTP；PATCH 走 `void Promise.resolve(...)` 不阻塞回调。返回 `toast` + `card` 双字段，不会触发客户端还原。唯一的实质问题是返回的 card 内容被抹空（见问题 1），而非超时。
- **按钮渲染位置**：`progress-card.ts:90` 在 cancel/retry 之前 push，`sessionDetailButton` 最后 push，故「点踩」在「会话详情」左侧，符合方案 5.1；有 `dislikeIndex < detailIndex` 测试锁定。
- **toggle 后 `setDisliked` 时序**：`create-app.ts:1913-1920` 先写库、成功后才 `setDisliked`，`refreshLater` 在其后触发；若 `toggleDislike` 抛错，飞书 SDK 的 `card.action.trigger` handler 有 try/catch 兜底（`monitor.service.ts:67-72`），不会导致回调悬挂。返回 `{ disliked }` 语义与 DB 一致，进程重启后重新以 DB 查询为准，符合方案 2.1.8。
- **管理后台来源列**：`FeedbackDetailRow.source` → `FeedbackDetailItem.source` → `row.source === 'feishu' ? '飞书' : '桌面端'`，数据流完整；`asSource` 对空值/异常值兜底 `desktop`，不会渲染空白。
- **桌面端不受影响**：`dislike()` 的 `source` 默认 `'desktop'`，桌面端 `FeedbackReason` 联合类型仍不含 `NO_REASON`（`desktop/src/api/index.ts:313`、`useMessageFeedback.ts:9-14`），不会把飞书专属原因暴露给桌面用户。
