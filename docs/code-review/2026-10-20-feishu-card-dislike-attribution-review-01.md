# 代码审查：飞书完成卡点踩按卡归属与终态快照重建（feat/feishu-card-dislike-attribution @ cf583a13 + f04dd82e）

- **日期**：2026-10-20（第一轮）；2026-10-20（第二轮复审，BUG-1 已由 f04dd82e 修复后复核）
- **审查范围**：`git diff 6780abd6..HEAD` 全部代码变更（`create-app.ts`、`feedback/feedback.service.ts`、`feishu/{active-progress,agent-inbound-handler,card-action.service,card-progress-listener,patched-progress,card-snapshot.repository}.ts`、迁移 `V161__feishu_card_snapshot.sql` 及各 spec；CHANGELOG.md、skills/mao-cli/、docs/ 按约定不审查）。审查前 `git status` 干净，无未提交改动
- **需求依据**：`docs/plan/2026-10-20-feishu-card-dislike-attribution-technical-design.md`
- **方法**：通读 diff + 跨文件语义口径比对（卡片正文口径 vs 快照归属口径、终态时序、三级降级）+ 对每个疑似点编写临时 spec 按「正确行为」断言复现；复刻 create-app 装配跑技术方案 §9.3 联调清单核心场景作正向对照
- **验证记录**：
  - `cd backend-ts && npm run build`（tsc）→ 通过（两轮均通过）
  - `cd backend-ts && npm test` 全量 → 第一轮 **Test Files 364 passed | 1 skipped (365)，Tests 4297 passed | 13 skipped (4310)**；第二轮（修复后）**364 passed | 1 skipped (365)，Tests 4301 passed | 13 skipped (4314)**（+4 为修复自带回归测试），无回归
  - 第一轮临时测试 `src/feishu/tmp-review-attribution.spec.ts` → **2 failed | 1 passed**（失败即 BUG-1 存在性证明，对照组通过）；`src/feishu/tmp-review-e2e.spec.ts`（复刻 create-app 装配的 §9.3 联调场景）→ **4 passed**
  - 第二轮临时测试 `src/feishu/tmp-round2-fix.spec.ts`（真实 handler + listener + patched-progress + 复刻 create-app 端口/装配）→ **4 passed**（BUG-1 场景不再复现）；`src/feishu/tmp-round2-retry.spec.ts`（真实 handler `retryExecution`）→ **1 passed**（重试路径同样回传终态消息 id）
  - 全部临时 spec 已在各轮报告完成后删除，未提交、未遗留
- **修复状态**：BUG-1 已于 `f04dd82e`「fix(feedback): 飞书点踩快照归属改为终态消息 ID 回传口径」**修复**（详见 §6）；下文 §2 为**修复前快照**，保留作历史记录

---

## 1. 结论表

| 编号 | 严重度 | 位置 | 一句话 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-1 | 中（触发条件窄） | `backend-ts/src/create-app.ts:2028`（修复前；配合 `feedback/feedback.service.ts:42-53`） | `persistTerminal` 用「跳过空 content」的 `findLatestAssistantMessageId` 做卡片→消息归属，与卡片正文口径（`channelAssistantReply` 取最后一条 ASSISTANT，不论是否为空）不一致：终态回复为空/纯空白时，快照行绑定到另一条更早的 ASSISTANT 消息，点踩反馈落错消息，且会把该旧消息上已有的桌面端记录 toggle 成删除（toast「已取消点踩」） | **已修复（f04dd82e，第二轮实测验证）** |

**总体结论**：主链路（按卡归属、三级降级、disliked 按卡隔离、persistTerminal 时序、存量卡兜底、跨会话/已删消息防护、双键注册表）实现正确且单测真实覆盖，§9.3 联调场景复刻全部通过；第一轮发现的唯一 BUG（BUG-1 归属口径缺陷）已由 f04dd82e 以「终态消息 ID 同源回传」方式修复，第二轮用真实单元链路复测不再复现，重试路径同步覆盖。另有多处「疑似但验证后不成立」项与建议项，见 §3、§4。

---

## 2. BUG 详述

### 2.1 BUG-1｜终态回复为空时，快照行把卡片归属到另一条消息，点踩反馈落错对象（中）

**文件:行号**：

- 根因：`backend-ts/src/create-app.ts:2027-2037`（`persistTerminal` 装配），核心在 `:2028`
  ```ts
  const messageId = await feedbackMessageLookup.findLatestAssistantMessageId(sessionId);
  ```
- 口径 A（快照归属）：`backend-ts/src/feedback/feedback.service.ts:42-53`——`findLatestAssistantMessageId` 的 SQL 带 `content IS NOT NULL AND TRIM(content) <> ''`，**只认有文本内容的 ASSISTANT 消息**
- 口径 B（卡片正文）：`backend-ts/src/feishu/agent-inbound-handler.ts:681` → `session/util/citation-markers.ts:75-84`——`channelAssistantReply` 从末尾向前取**最后一条 ASSISTANT**，不论 content 是否为空；`feishu/card-progress-listener.ts:99` 的 `complete()` 用的就是它

**问题**：`persistTerminal` 的职责是按 `card_message_id` 记录「这张卡对应的最终 ASSISTANT 消息」。当该终态消息的 content 为空/纯空白时，两个口径分叉：

- 卡片正文口径取到终态消息本身（正文为空，卡片只剩状态行 + 点踩按钮——点踩按钮照常渲染，`progress-card.ts:118-126` 只要求 `status === 'COMPLETED' && action.sender !== ''`）；
- 快照归属口径跳过这条空消息，落到**上一条有内容的 ASSISTANT**（可能是本任务中间某一轮的回复，也可能是更早任务的回复）。

于是快照行 `feishu_card_snapshot.message_id` ≠ 本卡终态消息。用户点这张卡的「不满意」时：

1. 反馈记录写到那条**旧消息**上——违背需求「反馈记录落在该张卡对应的 ASSISTANT 消息上」，后台明细看到的预览不是用户不满的内容；
2. 若那条旧消息上已有桌面端点踩记录（`uk_message` 唯一键，一条消息一行），`toggleSessionDislike` 的 `existsByMessageId → delete` 分支会把它**删掉**并返回 `{ disliked: false }`——用户点是「不满意」，实际效果是「已取消点踩」并丢了一条桌面端反馈数据；
3. 极端下两张卡可能绑定同一条旧消息，互相 toggle 抵消（第二张卡一点就取消第一张卡的记录）。

**触发条件**（窄，但可达）：

- 终态 ASSISTANT 消息 content 为空或纯空白：如模型空正文收尾、末轮被截断后以空 content 落库等；
- 另一条可达路径：后台子代理完成通知（`harness/delegate/background-subagent-manager.ts:866-885` 向父会话写 ASSISTANT 消息）若落在 `getLatestAssistantReply`（handler:681）与 `complete()` 内 `persistTerminal`（handler:682 → create-app:2028）之间的窗口，快照会绑定到子代理通知而非本卡终态回复。

**期望 vs 实际**（会话 5，M10 = 中间轮回复「上一轮的回复正文」，M11 = 终态回复 content 为空）：

| | 期望 | 实际 |
| --- | --- | --- |
| 快照 `message_id` | 11（本卡终态消息，与卡片正文同一条） | **10**（跳过空 content 的旧消息） |
| 点踩结果（M10 已有桌面记录时） | 给 M11 插入记录，`disliked: true` | **删除 M10 记录**，`disliked: false`，toast「已取消点踩」 |

**验证测试**（临时文件 `backend-ts/src/feishu/tmp-review-attribution.spec.ts`，用仿真 message 表驱动真实 `FeedbackDbLookup` / `FeedbackService`，断言一律按正确行为书写）：

- 命令：`cd backend-ts && npx vitest run src/feishu/tmp-review-attribution.spec.ts`
- 结果：**Tests 2 failed | 1 passed (3)**，关键输出：
  ```
  × BUG：终态回复为空时，快照 messageId 未指向本卡终态消息
    → expected 10 to be 11 // Object.is equality
  × BUG：归属错消息后，点踩删掉旧消息上已有的桌面记录而非给本卡插入
    → expected { disliked: false } to deeply equal { disliked: true }
  ✓ 对照组：终态回复非空时归属正确（同一消息）
  ```
- 对照组（passed）证明失败不是测试写法问题：终态回复非空时 `findLatestAssistantMessageId` 与 `channelAssistantReply` 指向同一消息（11），归属正确。

**影响场景**：仅影响「终态回复为空/纯空白」或「子代理通知落入终态窗口」时发出的完成卡。此类卡点击后：反馈统计错位（落到旧消息）、可能误删桌面端已有反馈并显示「已取消点踩」、同卡重复点击 toggle 的也不是本卡消息。不影响正文非空的正常完成卡（绝大多数），不崩溃、不阻断主流程。

**修复方向**（供参考，未改动代码）：让 `persistTerminal` 的归属口径与卡片正文口径一致——终态时刻直接取「最后一条 ASSISTANT 消息 id」（不論 content 是否为空，如给 `FeedbackMessageLookup` 增加 `findLastAssistantMessageId`，或由 `complete()` 把最终回复的 messageId 回传）；若取到的消息 content 为空，可按无正文消息处理（仍写快照行，或跳过并 warn 走兜底），但不应静默绑定到更早的消息。另需注意同一条消息被两张卡绑定时 toggle 互相抵消的问题。

---

## 3. 疑似但验证后不成立（已排除）

| # | 疑似问题 | 结论与理由 |
| --- | --- | --- |
| 1 | `handleProgressDislike` 中 `toggleDislike` 返回 null（快照行存在但消息已删）时只回 toast 不回卡片，与技术方案 §6.6「返回 toast + 按快照重建的 idle 卡」不符 | **不成立（非功能 bug）**。飞书回调无 card 时客户端还原为点击前卡片（本仓 `card-action.service.ts:339-340` 等注释即此语义），用户看到 toast、卡片原样保留，比渲染成 idle 卡更安全；且与改造前 `result == null` 分支行为一致，无回归。属方案表述偏差，可在实现说明里更正 |
| 2 | 三级降级第③级 `renderProgressCard(sessionId)` 会渲染会话**当前**句柄：若同会话已有新任务在跑，存量卡会被重绘成 RUNNING 新任务卡 | **不成立（设计内行为）**。技术方案 D5 与 §8 兼容表明确「存量卡无快照行 → 兜底现状行为 + warn，不报错」，该缺陷正是今天（改造前）对旧卡的行为；有快照行的新卡走①②级不会命中。warn 日志已按 D4 补齐 |
| 3 | `rebuildCardFromSnapshot` 未校验快照行 `sessionId` 与点击 `sessionId` 一致（潜在跨会话串卡） | **不成立（不可达 + 有兜底）**。按钮 value 的 sessionId 与卡片 open_message_id 同源绑定，鉴权又要求点击者=value.sender，正常事件无法构造跨会话组合；即便发生，反馈侧 `toggleSessionDislike` 的 `ownership.sessionId !== sessionId` 校验会拒绝（`feedback.service.ts:143`），仅多渲染一张内容错误的卡，无数据写入。可作加固建议（§4） |
| 4 | `byCard` 注册表只进不出，旧卡句柄无限累积（内存增长风险） | **不成立（实际风险可忽略）**。每项仅为终态句柄快照（正文 ≤6000 字符 + 少量字段，典型 KB 级），且进程重启（蓝绿/发版 restart-backend）即整体清空；与方案 D7「旧卡句柄保留」的有意设计一致，无 TTL 不构成实际泄漏 |
| 5 | 点击链路新增 DB 查询是否撑爆飞书 3 秒回调窗口 | **不成立**。最坏路径（重启后点有快照的卡）共约 7 次轻量索引查询（getSession、快照行 ×2、findAssistantMessageOwner、existsByMessageId、upsert/delete、getEcpConfig），无外部 HTTP、无 await 竞态（`rebuildCardFromSnapshot` 在回调返回前 await 但均为本地 DB），量级远小于 3 秒 |
| 6 | V161 与 repository / create-app 装配的列序、参数序、ON DUPLICATE KEY UPDATE 覆盖列是否一致 | **不成立（一致）**。INSERT 八列 `(card_message_id, session_id, bot_id, message_id, status, round, elapsed_ms, content)` 与参数 `[cardMessageId, sessionId, botId, messageId, status, round, elapsedMs, content]` 逐列对应；ODKU 覆盖除唯一键外全部业务列（含 message_id/round/content，重试同卡覆盖语义正确）；uk 在 `card_message_id`，V161 为当前最大迁移号（V160 之后），无冲突 |
| 7 | 新增 spec 是否存在「假通过」断言 | **不成立（断言均真实）**。逐个核对：`patched-progress.spec.ts` 用 `order` 数组证明 persist 先于 patch；`card-action.service.spec.ts` 断言 `renderProgressCard` 未被调用（旧卡不触达会话级）、`rebuildCardFromSnapshot` 收到 `(7,'cm_old',true,'ou_1')`；`active-progress.spec.ts` 覆盖同会话双卡不互串、同卡重绑覆盖、未命中返回 null；`feedback.spec.ts` 覆盖显式 messageId 跳过最新消息查询、跨会话拒绝、消息不存在返回 null、不传时行为不变；`card-snapshot.repository.spec.ts` 覆盖 upsert 全列/ODKU、camel 与 snake 行映射、非法行 null。均非空转断言 |

---

## 4. 建议项（非 bug，不阻断合并）

1. **点击链路快照行被查两次**：`create-app.ts:2707`（toggleDislike 内）与 `:2772`（rebuildCardFromSnapshot 内）各查一次 `findByCardMessageId`。可在 `toggleDislike` 返回结果里带上快照行（或二级降级复用首次查询结果）省一次往返，点击链路更稳。
2. **`rebuildCardFromSnapshot` 增加 sessionId 交叉校验**：`snapshot.sessionId !== sessionId` 时返回 null 走兜底，与反馈侧校验对齐，纵深防御。
3. **`persistTerminal` 无 try/catch 的直接调用方保护**：`findLatestAssistantMessageId` 抛错时会经 `patched-progress.ts:113-119` 的 catch 降级为 warn，行为正确；但 warn 文案目前只有「终态快照持久化失败」，查询失败的场景可加更明确日志便于线上区分。

---

## 5. 核对结论汇总（对应审查清单）

- a) 点踩归属全链路：`event.context.open_message_id`（`card-action.service.ts:198`，与 retry 同款读法）→ 快照表 `findByCardMessageId` → `toggleSessionDislike(..., messageId)`，接线正确；跨会话防护（`feedback.service.ts:143`）、消息已删/角色非 ASSISTANT 防护（`feedback.service.ts:31-37` 的 role/deleted/session.deleted 条件）均有效且有单测覆盖。唯一缺陷为 BUG-1 的归属口径分叉（已修复，见 §6）
- b) 三级降级顺序（内存按卡 → 快照重建 → 会话级兜底 + warn）与方案 D4 一致；①②级不会返回 round=0 空壳或 RUNNING；③级仅存量卡/DB 查询失败时命中，行为同今天（见 §3-2）
- c) disliked 按卡隔离：`setDislikedByCard` 只写被点卡句柄，同会话新任务句柄零影响（§9.3 场景 1 复刻通过）；事件缺 open_message_id 时退化为会话级 `current().setDisliked`，有单测覆盖
- d) persistTerminal 时序：COMPLETED 且注入存在时先于 `patch` await（`patched-progress.ts:113-120`，spec 用 order 数组证明）；失败仅 warn 不阻断 PATCH；FAILED/CANCELLED/RUNNING 不触发；重试同卡经 ODKU 覆盖快照行 + `bind` 覆盖 byCard，语义正确
- e) 存量卡兜底：无快照行 → 会话级 toggle + 会话级/空卡重绘 + warn，不抛错、不比现状差（与改造前一致）
- f) 注册表双键：同会话多卡互不串、旧卡句柄保留、同卡重试/崩溃恢复覆盖、内存增长风险可忽略（§3-4）
- g) 3 秒回调窗口：仅轻量索引查询、无外部 HTTP（§3-5）；唯一改进点为快照行重复查询（§4-1）
- h) V161 ↔ repository ↔ create-app：列序/参数序/ODKU 覆盖列一致（§3-6）
- i) 单测真实性：无假通过（§3-7）

---

## 6. 第二轮复审：BUG-1 修复验证（f04dd82e）

**修复方式**：终态消息 ID 同源回传，消除两套口径——

- `FeishuSessionAdapter.getLatestAssistantReply` → `getLatestAssistantReplyWithId`（`agent-inbound-handler.ts:15-22`）：create-app 端口（`:2185-2198`）在同一批 messages 上先扫出「最后一条 ASSISTANT」的 id（不论 content 是否为空），与 `channelAssistantReply` 选消息的循环完全同源，文本与 id 一次取出；
- `complete(finalContent, terminalMessageId?)`（`card-progress-listener.ts:100-106`）→ `update(..., terminalMessageId?)` → `send(..., terminalMessageId?)` → `persistTerminal({ ..., messageId })` 全链路透传（`patched-progress.ts:44-52,97-120,131-132`）；
- `persistTerminal` 装配（`create-app.ts:2027-2040`）改为 `messageId ?? await findLatestAssistantMessageId(sessionId)`：回传优先，未回传路径（崩溃恢复续跑）才落库查询兜底。

**漏传路径排查**（全部 COMPLETED 终态入口逐一核对）：

| 入口 | 是否回传 | 说明 |
| --- | --- | --- |
| `runExecution` 主路径（`agent-inbound-handler.ts:687-688`） | ✅ | `reply.messageId ?? undefined` |
| `runRetry` 重试路径（`:301-302`） | ✅ | 同款回传（原 spec 未断言，本轮临时测试实测通过） |
| `CrashRecoveryRunner` 崩溃恢复（`harness/core/crash-recovery-runner.ts:419`） | ⚠️ 兜底 | `complete(latestAssistantReply(sessionId))` 不带 id，走落库查询兜底。其正文口径 `latestAssistantReply`（`:463-476`）同样跳过空 content，与兜底查询 `findLatestAssistantMessageId` 一致，**无新分叉**（提交说明已注明） |

**第二轮验证**（临时测试，跑后已删）：

- `src/feishu/tmp-round2-fix.spec.ts`（真实 `AgentFeishuInboundHandler` + `FeishuCardProgressListener` + `createFeishuPatchedProgress` + 逐行复刻的 create-app 端口/装配）→ **4 passed**：① 终态回复为空时快照绑定本卡终态消息 11（修复前为 10，BUG-1 复现用例转绿）；② 同链路点踩落在终态消息、不误删旧消息桌面记录；③ 未回传 id 时落库查询兜底仍生效（=10，与恢复路径正文口径一致）；④ 端口正文/id 同源扫描四组用例（含空 content、无 ASSISTANT）全部一致；
- `src/feishu/tmp-round2-retry.spec.ts`（真实 handler `retryExecution`）→ **1 passed**：重试完成后 `persistTerminal` 收到终态消息 id 12；
- 全量 `npm test` → 364 files / 4301 tests 通过，`npm run build` 通过，无回归。

**4 个新回归测试质量**：均真实有效——handler 测试断言 `updates` 含 `{ status: 'COMPLETED', messageId: 11 }`（不回传即为 `undefined`，会失败）；listener 测试同时断言带 id / 不带 id 两种转发；patched-progress 两个测试断言 `persistTerminal` 收到 `messageId: 42` 与 `messageId: undefined`。非空转断言。

**修复后残留（非 bug，记录备查）**：

1. 崩溃恢复路径的兜底分叉仅剩「raw content 非空但可见文本为空」的极端类（如仅含 image part 的终态回复：`session.service.ts:930-965` 的 `extractVisibleText` 返回空 → 恢复正文口径跳过，而 `findLatestAssistantMessageId` 按 raw content 选中）——属修复前即存在的旧类，触发条件极窄，且只影响崩溃恢复卡；
2. 测试覆盖缺口（不影响正确性）：create-app 端口 id 扫描与 `persistTerminal` 的 `messageId ?? 兜底` 装配无单测（内联在 create-app，本轮以复刻测试代验）；重试路径回传无 spec 断言（代码正确，本轮临时测试实测通过）。建议后续将端口逻辑下沉为可测函数或补 create-app 级集成断言。

**第二轮结论**：BUG-1 已真正修复，主路径/重试路径无漏传，崩溃恢复兜底口径自洽；cf583a13 + f04dd82e 完整改动中**未发现新的 bug**；§3 已排除项与 §4 建议项继续有效。
