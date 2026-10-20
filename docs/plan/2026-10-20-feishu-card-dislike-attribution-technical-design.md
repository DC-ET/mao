# 飞书完成卡「点踩」归属与快照重建技术方案

- 日期：2026-10-20
- 状态：决策已确认（2026-10-20 与需求方复核拍板，见 §4），待实施
- 前置：`docs/plan/2026-09-28-feishu-card-dislike-technical-design.md`（飞书卡片点踩，已上线）；`docs/code-review/2026-09-28-feishu-card-dislike-review-01.md`（当年已预警「空壳卡」问题，见 §2.3）
- 涉及端：backend-ts（唯一改动端）；admin / desktop / android / agent-cli 无代码改动
- 文档同步：CHANGELOG.md、skills/mao-cli/reference/feedback.md（飞书点踩口径变更，见 §9.5）

---

## 1. 需求背景

### 1.1 已排查确认的两个线上问题

**问题 A：点踩后卡片内容整体丢失（重启后必现）**

用户在飞书对任务完成卡点「不满意」，卡片状态行更新为已点踩，但原卡的正文、轮次、耗时、工具摘要全部消失，只剩「状态：处理完成」+「👎 已点踩 · 再点取消」+「会话详情」。复现条件：任务完成后后端进程重启过（蓝绿发版、崩溃均可），再点击。

**问题 B：点击旧卡时反馈打错对象、旧卡被覆盖（长会话常态）**

飞书一个会话对应一个 session，每轮任务都会新建一张进度卡（`createFeishuProgressCard` 每条入站消息发一张新卡），聊天记录里会累积大量完成卡，每张都带「不满意」按钮。点击任意一张**非最新**的旧卡时：

1. 反馈记录写到会话**最后一条** ASSISTANT 消息上（`toggleSessionDislike` 固定取最新，`feedback.service.ts:135-148`），后台明细看到的预览不是用户不满的那条回复；
2. 旧卡被**当前进度句柄**（最新任务的快照）整体重绘——最新任务在跑，旧完成卡会变成「正在处理」+「取消任务」；最新任务已完成，旧卡内容被替换成最新回复；
3. `setDisliked` 只作用于当前句柄（`create-app.ts:2686`），点踩态串到最新卡上；
4. 若最新消息已有反馈记录（如从桌面端点踩过），点旧卡的「不满意」会**删除**该记录，toast 显示「已取消点踩」。

### 1.2 用户确认的产品判断

**旧卡可点是正常且应保留的使用场景**（用户翻上去给早前某条不满意的回复打分，是反馈数据最有价值的来源之一）。本方案不做「禁用/置灰旧卡按钮」这类砍功能式规避，而是把点击归属做对。这与全系统现有口径本应一致：桌面端按 messageId 点踩、后台明细按 messageId 展示（带 `messageExists` 标记）、`message_feedback.uk_message` 一条消息一条记录；飞书卡片是唯一走「会话级取最新消息」捷径的地方。

### 1.3 目标形态

点任意一张完成卡（新的、旧的、重启后的）的「不满意」：

- 反馈记录落在**该张卡对应的** ASSISTANT 消息上；
- 只重绘**该张卡**，内容/轮次/耗时与该卡终态一致，按钮按 toggle 后状态渲染；
- 不影响同会话其它卡片与其它消息的反馈记录；
- 同一张卡重复点击 = toggle 该消息的记录。

## 2. 根因分析

三个缺陷叠加，共同导致上述两个问题：

### 2.1 进度快照只在内存，且按 sessionId 键

`FeishuActiveProgressRegistry`（`feishu/active-progress.ts`）是一个纯内存 Map，只进不出、不过期，但**进程重启即全部清零**；键是 sessionId，一个会话只存最新任务的句柄。点踩回调 `handleProgressDislike`（`feishu/card-action.service.ts:176-198`）必须整卡返回（飞书 3 秒约束，否则客户端还原点击前旧卡），拿不到快照时命中回退分支 `buildFeishuProgressCard('COMPLETED', 0, '', [], …)`（`card-action.service.ts:189-193`）——round=0、无耗时、正文空、工具空，即问题 A 的空壳卡（截图佐证：完成卡只有状态行、没有「共 N 轮 · 耗时」，正是 round=0 + elapsedMs=undefined 的回退卡特征）。

### 2.2 点击缺少卡片身份，服务端无法归属

 dislike 按钮 value 只带 `sessionId` + `sender`（`progress-card.ts:124`），`handleProgressDislike` 也完全不读 `event.context.open_message_id`（对比 retry 路径是读的，`card-action.service.ts:206`）。服务端因此无法知道「点了哪张卡」，只能按 session 级取最新消息、按 session 键取最新句柄——即问题 B 的四连错。

### 2.3 终态即删映射，「卡片 → 消息」关系被主动丢弃

`feishu_progress_card` 表在 COMPLETED/CANCELLED 终态即删（`create-app.ts:2356-2360`，注释明确是为避免崩溃恢复误更旧卡）。删除之后，连「哪张 cardMessageId 对应哪条消息」都不复存在。而该信息在终态时刻本是现成的：任务完成时最终回复**先落库**、卡片终态 PATCH **在后**（`agent-inbound-handler.ts:680-682`：`execute()` 返回 → `onExecutionFinished` → `getLatestAssistantReply` → `cardListener.complete`）。

2026-09-28 的评审（`docs/code-review/2026-09-28-feishu-card-dislike-review-01.md:50`）当年即警告「回调不要自己重建空壳卡，改为复用已有快照渲染通道」；后续改造改为快照优先，但 null 回退仍是空壳卡——重启场景下评审提的问题原样存在。

## 3. 需求描述

### 3.1 要做的

1. 新增 `feishu_card_snapshot` 表：COMPLETED 终态时按 `card_message_id` 落一行终态快照（message_id / round / elapsed_ms / content）。
2. 点踩回调改为**按卡归属**：从 `event.context.open_message_id` 取被点卡片 ID（retry 路径同款做法，按钮 value 不变），经快照表/内存双键解析到该卡对应的消息与快照。
3. 重绘三级降级：内存按卡快照 → 持久化快照重建 → 兜底（现状会话级 + warn 日志）。任何一级都不得返回 round=0 的空壳卡，除非确实无任何快照（存量卡）。
4. 反馈记录按卡对应的 messageId toggle（`FeedbackService.toggleSessionDislike` 增加可选 messageId 参数，桌面链路与现有调用方零变化）。
5. `disliked` 态按卡隔离：注册表增加 cardMessageId 反查，点旧卡不再把态写到最新句柄上。
6. 存量兼容：改造前发出的卡（无快照行）点击时走兜底路径，行为与今天一致，仅补 warn 日志，不得报错。

### 3.2 明确不做的

| 不做项 | 说明 |
| --- | --- |
| 禁用/置灰旧卡点踩按钮 | 用户确认旧卡可点是正常场景；本方案修归属而非砍功能 |
| 改 `feishu_progress_card` 表结构与终态删除语义 | 该表的删除绑着崩溃恢复「避免误更旧卡」的注释（create-app.ts:2356），动它风险大；快照另立新表 |
| FAILED / CANCELLED 卡快照 | 这两类卡没有点踩按钮（`progress-card.ts:118` 仅 COMPLETED 渲染），无需快照行 |
| 群内其他人视图的额外 PATCH | 维持现状：点踩只更新点击者视图 |
| 快照表自动清理任务 | 记录增长评估见 §11.2；保留策略后续单独立项 |
| 钉钉 / 微信通道点踩 | 不在本期范围 |
| 把 messageId 烧进按钮 value | 见 D3：事件 context 已携带卡片身份，value 无需扩容 |

## 4. 已确认的决策记录

D1（快照另立新表）、D2（快照存正文）、D5（存量卡兜底）与「快照表不做自动清理」（§3.2、§11.2）已于 2026-10-20 与需求方复核拍板；其余为方案设计默认决策，实现中如受阻再议。

- **D1 新表 `feishu_card_snapshot`，不动 `feishu_progress_card`**：现有表「一会话一行 + 终态即删」的语义被崩溃恢复与失败重试依赖（`create-app.ts:2086` 恢复定位、`:2691` 重试定位）；打破唯一键或保留行都会波及这两条路径。新表职责单一：只服务点踩的归属与重绘。
- **D2 快照存 content（≤6000 字符，与卡片同口径），不依赖消息表现取**：卡片正文是 `trimCardText(stripCitationMarkers(finalContent))` 的截断值（`card-progress-listener.ts:95-100`），存快照值可 1:1 重绘且零额外查询；消息被清理后旧卡仍可完整重绘（反馈侧按 `messageExists` 另行提示）。轮次与耗时**必须**存：任务完成后 `countCompletedAgentRounds(session)` 会把新轮次算进去，现算会对旧卡偏大；耗时是终态固化值（`patched-progress.ts:55-57`），也无法从 session.startedAt 反推（排队等待不计入，`create-app.ts:2049-2050`）。
- **D3 卡片身份取自 `event.context.open_message_id`，按钮 value 不改**：该字段在回调里始终携带被点卡片的消息 ID，队列卡与 retry 路径均已依赖它（`card-action.service.ts:134-135`、`:206`）；改 value 属冗余扩容。value 缺 cardMessageId 的存量卡同样能通过 context 归属——缺的只是快照行，走兜底路径（D5）。
- **D4 重绘三级降级，兜底前必须 warn**：① 内存按卡句柄 `renderCurrent()`（保真度最高，含提问表单等运行态细节）；② 快照行重建 `buildFeishuProgressCard`；③ 两者皆无才退回今天的会话级行为，并打 warn 日志便于线上发现（当前兜底路径完全静默，是问题 A 长期未暴露的原因之一）。
- **D5 存量卡兜底保持现状语义**：无快照行时按 today 行为（会话级 toggle + 当前句柄/空卡重绘），仅补日志。存量卡随自然过期消解，不值得为它引入消息反查推导。
- **D6 `toggleSessionDislike` 增可选 messageId 参数，不新增公开方法**：显式传入时跳过 `findLatestAssistantMessageId`，并用 `findAssistantMessageOwner` 校验消息归属（role=ASSISTANT、未删、属于该会话），防串会话；不传时行为与今天完全一致。桌面端点踩链路（`feedback.routes.ts`）不动。
- **D7 disliked 态按卡隔离**：注册表 `bind` 时记录 cardMessageId，新增 `renderByCard` / `setDislikedByCard`；session 键方法（ask 挂载门禁、`refreshProgress`）保持不动。
- **D8 回调窗口内不引入外部 IO**：点击链路新增 ≤2 次轻量 DB 查询（快照行 + toggle 既有查询），无 HTTP，满足飞书 3 秒约束（与原方案风险评估一致）。
- **D9 终态快照在 PATCH 前落库**：`patched-progress` 增加 `persistTerminal` 依赖注入，在 COMPLETED 分支 `patch` 前 await，避免「卡已更新、快照未落」的点击竞态；失败仅 warn 不阻断 PATCH。

## 5. 现状分析（相关代码索引）

| 环节 | 位置 |
| --- | --- |
| 点踩回调处理（含空壳回退） | `feishu/card-action.service.ts:176-198` |
| retry 读取被点卡片 ID（先例） | `feishu/card-action.service.ts:206` |
| 进度快照注册表（内存、session 键） | `feishu/active-progress.ts:10-41` |
| 快照渲染 / disliked 态 | `feishu/patched-progress.ts:124-131` |
| 完成卡点踩按钮与 value | `feishu/progress-card.ts:118-126` |
| 状态行（回退卡无轮次/耗时的原因） | `feishu/progress-card.ts:286-292` |
| 会话级 toggle（取最新消息） | `feedback/feedback.service.ts:135-148`；查询口径 `:42-53` |
| 反馈记录仓储（toggle 三件套） | `feedback/feedback.repository.ts:82,91,96` |
| 进度卡闭包装配（bind / cancelAction） | `create-app.ts:1992-2027` |
| 进度卡创建（新卡 / 排队卡升级） | `create-app.ts:2028-2075` |
| 崩溃恢复续跑装配 | `create-app.ts:2084-2119` |
| 终态清理映射（COMPLETED 即删） | `create-app.ts:2353-2360`；恢复路径 `:3185-3190` |
| 点踩装配（toggleDislike / renderProgressCard） | `create-app.ts:2681-2688`、`:2731-2732` |
| 完成时序（消息先落库、卡片后终态） | `feishu/agent-inbound-handler.ts:680-682`；重试路径 `:294-296` |
| 终态卡片构建（tools 传空） | `feishu/card-progress-listener.ts:95-100` |
| 活跃进度卡表现表 | `db/migration/V092__feishu_progress_card.sql` |
| 消息落库查询（可复用） | `create-app.ts:753`（`FeedbackDbLookup`）、`:2163`（getLatestAssistantReply） |

## 6. 方案设计

### 6.1 总体思路

```
点击「不满意」(任意一张完成卡)
   │
   ├─ 鉴权：operator.open_id === value.sender（不变）
   │
   ├─ 归属：cardMessageId = event.context.open_message_id
   │
   ├─ toggle：快照行.messageId → FeedbackService.toggleSessionDislike(..., messageId)
   │          （无快照行 → 兜底按会话最新消息，warn）
   │
   └─ 重绘该卡（三级降级）：
        ① 内存：activeProgress.renderByCard(cardMessageId)
        ② 持久：cardSnapshot 行 → buildFeishuProgressCard(...)
        ③ 兜底：现状会话级路径 + warn（仅存量卡）
```

### 6.2 数据模型：`feishu_card_snapshot`

一行 = 一张完成卡的终态快照（DDL 见 §7）。写入时机：COMPLETED 终态 PATCH 前（D9）；写入内容：`card_message_id`（闭包已知）、`session_id`、`bot_id`、`message_id`（终态时刻查最后一条 ASSISTANT 消息，此时已落库）、`round` / `elapsed_ms` / `content`（来自 handle 终态快照，与卡片展示同口径）。重试（`retryFailed`）会为同一 cardMessageId 重新绑定句柄并在再次完成时覆盖快照行，语义正确。

### 6.3 卡片身份来源

`handleProgressDislike` 增加读取 `event.context?.open_message_id ?? event.open_message_id`（与 retry 完全同款，`card-action.service.ts:206`）。该字段为空（理论上不出现）时退化为今天的 session 级行为。按钮 value 不扩容（D3），`parseActionValue` 无需改动。

### 6.4 注册表双键

```ts
// feishu/active-progress.ts
bind(sessionId, senderOpenId, handle, cardMessageId?)   // 新增第四参，记录 card → handle
renderByCard(cardMessageId): Record<string, unknown> | null   // 新增
setDislikedByCard(cardMessageId, disliked): void               // 新增
// session 键方法（current / hasRunning / senderOpenId / refresh / render）保持不变，
// ask 挂载门禁（create-app.ts:1995,2000）与 refreshProgress 语义不受影响
```

### 6.5 终态快照持久化

```ts
// feishu/patched-progress.ts：createFeishuPatchedProgress 依赖新增（可选）
persistTerminal?: (snapshot: { round: number; content: string; elapsedMs?: number }) => Promise<void>

// send() 内：status === 'COMPLETED' 且注入存在时，在 patch 前 await；try/catch，失败仅 warn
```

create-app 装配（闭包内可直接拿到 cardMessageId / sessionId / botId）：

```ts
persistTerminal: async ({ round, content, elapsedMs }) => {
  const messageId = await feedbackMessageLookup.findLatestAssistantMessageId(sessionId); // create-app.ts:753 已装配
  if (messageId == null) { console.warn(...); return; }   // 极端：终态时消息未落库，降级兜底
  await cardSnapshotRepo.upsert({ cardMessageId, sessionId, botId, messageId, status: 'COMPLETED', round, elapsedMs: elapsedMs ?? 0, content });
}
```

### 6.6 点击处理流程（`handleProgressDislike` 重写）

```ts
const clickedCardId = event.context?.open_message_id ?? event.open_message_id ?? null;
const result = await toggleDislike(action.sessionId, clickedCardId);   // 签名扩展第二参；null = 无可反馈消息
if (result == null) return { toast: { type: 'info', content: '未找到可反馈的任务结果' } };

const card =
  (clickedCardId != null ? this.options.renderProgressCardByCard?.(clickedCardId) : null)      // ① 内存按卡
  ?? (clickedCardId != null ? await this.options.rebuildCardFromSnapshot?.(action.sessionId, clickedCardId, result.disliked) : null)  // ② 快照重建
  ?? this.options.renderProgressCard?.(action.sessionId)                                        // ③ 兜底（现状）
  ?? buildFeishuProgressCard('COMPLETED', 0, '', [], { sessionId, sender }, undefined, url, undefined, result.disliked);
if (走了③且 clickedCardId != null) console.warn(`飞书点踩无快照可重绘, cardMessageId=${clickedCardId}, sessionId=...`);
return { toast: ..., card: { type: 'raw', data: card } };
```

- `rebuildCardFromSnapshot` 由 create-app 实现：查快照行 → 行缺失返回 null → 否则 `buildFeishuProgressCard('COMPLETED', row.round, row.content, [], { sessionId, sender }, row.elapsedMs, sessionDetailUrl, undefined, disliked)`。card-action.service 不感知快照表结构。
- 快照行存在但消息已被清理：toggle 侧校验不过（D6），返回「未找到可反馈的任务结果」+ 按快照重建的卡（idle 态），与桌面端「消息已不存在」口径一致。

### 6.7 反馈记录按 messageId toggle

```ts
// feedback.service.ts
async toggleSessionDislike(userId, sessionId, source = 'desktop', messageId?: number): Promise<{ disliked: boolean } | null> {
  let targetId = messageId;
  if (targetId != null) {
    const owner = await this.messageLookup.findAssistantMessageOwner(targetId);  // 校验 role/未删/归属
    if (owner == null || owner.sessionId !== sessionId) return null;             // 防串会话
  } else {
    const owner = await this.sessionOwnerLookup(sessionId);
    if (owner == null) return null;
    targetId = await this.messageLookup.findLatestAssistantMessageId(sessionId);
    if (targetId == null) return null;
  }
  // 以下 existsByMessageId → delete / upsert(agentId=sessionAgentLookup) 逻辑不变
}
```

create-app 装配调整：`toggleDislike` 内先按 cardMessageId 查快照行取 messageId（无行传 undefined 走兜底），toggle 成功后按卡 `setDislikedByCard`（无卡时退回 session 级 `setDisliked`）。

## 7. 数据模型变更

### 7.1 迁移 V161（当前最新 V160）

`backend-ts/db/migration/V161__feishu_card_snapshot.sql`：

```sql
CREATE TABLE IF NOT EXISTS `feishu_card_snapshot` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `card_message_id` VARCHAR(128) NOT NULL COMMENT '被点击的进度卡片messageId',
    `session_id` BIGINT NOT NULL COMMENT '会话ID',
    `bot_id` BIGINT NOT NULL COMMENT '飞书Bot应用ID(feishu_bot.id)',
    `message_id` BIGINT NOT NULL COMMENT '卡片对应的最终ASSISTANT消息ID(message.id)',
    `status` VARCHAR(16) NOT NULL DEFAULT 'COMPLETED' COMMENT '卡片终态(仅COMPLETED有点踩按钮)',
    `round` INT NOT NULL DEFAULT 0 COMMENT '卡片展示轮次(共N轮)',
    `elapsed_ms` BIGINT NOT NULL DEFAULT 0 COMMENT '卡片展示耗时(毫秒,终态固化值)',
    `content` MEDIUMTEXT NULL COMMENT '卡片正文(与卡片同口径,截断6000字符)',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_feishu_card_snapshot_card` (`card_message_id`),
    KEY `idx_feishu_card_snapshot_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='飞书完成卡终态快照(点踩归属与重绘)';
```

- 无存量数据订正（新表）。
- `feishu_progress_card` 不动：终态删除语义、崩溃恢复与失败重试路径保持原样。

### 7.2 repository

新增 `backend-ts/src/feishu/card-snapshot.repository.ts`，仿 `progress-card.repository.ts` 写法：接口 `FeishuCardSnapshotRepository { upsert(row); findByCardMessageId(cardMessageId): Promise<FeishuCardSnapshotRow | null> }` + Mysql 实现 + 行映射（兼容 camel/snake，非法行返回 null）。upsert 走 `ON DUPLICATE KEY UPDATE`（uk 在 card_message_id）。

## 8. 兼容性与存量处理

| 场景 | 现状 | 改造后 |
| --- | --- | --- |
| 点最新完成卡（未重启） | 内存快照重绘，正常 | 不变（内存按卡优先） |
| 点最新完成卡（重启后） | 空壳卡，内容全丢（问题 A） | 快照行重建完整卡（正文/轮次/耗时/按钮态） |
| 点旧完成卡（会话已有新任务） | 反馈打给最新消息；旧卡被新任务快照覆盖； disliked 串到新卡（问题 B） | 反馈打在旧卡对应消息；旧卡按自身快照重绘；新卡与新消息零影响 |
| 点旧完成卡（重启后） | 空壳卡 | 快照行重建 |
| 最新消息已点踩时点旧卡 | 删除最新消息记录，toast「已取消点踩」 | 只 toggle 旧卡消息；最新记录不动 |
| 同一张卡二连点 | toggle 最新消息（错对象） | toggle 该卡消息，按钮文案/颜色正确翻转 |
| 改造前发出的存量卡 | — | 无快照行 → 兜底现状行为 + warn，不报错 |
| 非发送者点击 | toast 拒绝 | 不变 |
| FAILED 卡重试 / CANCELLED 卡 | 映射保留 / 无点踩按钮 | 不变（不写快照行） |
| 桌面端 / 管理后台点踩链路 | 按 messageId | 不变（飞书记录改按卡对应消息后，与桌面口径统一） |

升级注意：改造后发出的第一张完成卡起，快照行才存在；升级前已发出的卡片在点击时走兜底。无数据迁移脚本需求。

## 9. 实现步骤

### 9.1 后端（backend-ts）

1. **迁移**：`V161__feishu_card_snapshot.sql`（§7.1）。
2. **新 repository**：`feishu/card-snapshot.repository.ts`（§7.2）+ 单测。
3. **`feishu/patched-progress.ts`**：`createFeishuPatchedProgress` 增可选依赖 `persistTerminal`；`send()` 在 `status === 'COMPLETED'` 时于 patch 前 await（D9），try/catch 仅 warn。补单测：COMPLETED 触发且参数正确；FAILED/CANCELLED 不触发；抛错不阻断 patch。
4. **`feishu/active-progress.ts`**：`bind` 增第四参 `cardMessageId`；新增 `renderByCard` / `setDislikedByCard`；session 键方法不动。补单测：同会话两张卡互不串；未命中返回 null。
5. **`feishu/card-action.service.ts`**：
   - 构造函数增 `renderProgressCardByCard?: (cardMessageId) => Record<string, unknown> | null` 与 `rebuildCardFromSnapshot?: (sessionId, cardMessageId, disliked) => Promise<Record<string, unknown> | null>`；`toggleDislike` 签名扩展为 `(sessionId, cardMessageId: string | null)`。
   - `handleProgressDislike` 按 §6.6 重写；兜底路径补 warn。
6. **`create-app.ts`**：
   - `createPatchedProgress`：`bind` 传 cardMessageId（闭包已持有）；装配 `persistTerminal`（§6.5）。
   - `cancelAction` 构造点（`:2032` 新卡与排队卡升级共用、`:2096-2098` 崩溃恢复、`:2713-2718` 重试）无需改字段——按钮 value 不变（D3）；仅 `createPatchedProgress` 内 `bind` 调用点（`:2025`）补 cardMessageId 参。
   - `toggleDislike` 装配（`:2681-2688`）：按 cardMessageId 查快照行 → messageId 传入 `toggleSessionDislike`；toggle 成功后 `setDislikedByCard`（无卡退回 session 级）。
   - 装配 `renderProgressCardByCard` 与 `rebuildCardFromSnapshot`（后者查快照行并 `buildFeishuProgressCard`，拼 `sessionDetailUrl`）。
   - 实例化 `MysqlFeishuCardSnapshotRepository(db)`。
7. **`feedback/feedback.service.ts`**：`toggleSessionDislike` 增可选 `messageId` 参数与归属校验（§6.7）；`feedback.spec.ts` 补用例（显式 messageId 跳过最新消息查询、跨会话拒绝、不传时行为不变）。

### 9.2 测试补齐（`cd backend-ts && npm test`，输出先落盘再 grep 摘要）

- `card-action.service.spec.ts`：旧卡点击只走按卡通道（断言 `toggleDislike` 收到 cardMessageId、返回卡来自 `rebuildCardFromSnapshot`、未触达 session 级 `renderProgressCard`）；内存优先于快照行；快照缺失走兜底且 warn；非发送者拒绝；event 无 context 时退化。
- `progress-card.spec.ts`：回归断言 dislike 按钮 value 形状未变（无 cardMessageId 扩容）。
- `patched-progress.spec.ts` / `active-progress` 相关 spec：见 §9.1-3/4。
- `card-snapshot.repository.spec.ts`：upsert 覆盖、按 cardMessageId 查、非法行映射 null。

### 9.3 联调（真实机器人，参考原方案验收清单）

1. 连发两轮任务得到两张完成卡；点**旧卡**「不满意」→ 旧卡按钮变红且正文/轮次/耗时保留，最新卡不变；后台明细出现记录且预览为旧卡对应回复。
2. 重启后端后再点任意完成卡 → 内容完整保留（问题 A 消解）。
3. 旧卡二连点 → 记录删除、按钮恢复灰色；同时最新消息的点踩记录不受影响。
4. 非发送者点击旧卡 → 拒绝。

### 9.4 回归关注点

- 取消任务 / 失败重试 / 提问表单 / 会话详情按钮行为不变（`renderCurrent` 不因新增字段报错）。
- 崩溃恢复续跑后完成卡仍可写快照行并可点踩。

### 9.5 文档与 CHANGELOG（同任务完成，AGENTS.md 要求）

- `CHANGELOG.md` 顶部新增/追加修复小节（section 后端）：修复飞书完成卡点踩后内容丢失与旧卡点踩反馈错位。
- `skills/mao-cli/reference/feedback.md`：更新飞书点踩口径——记录落在被点卡片对应的 ASSISTANT 消息（不再固定会话最后一条）；快照表一行说明。

## 10. 测试计划

见 §9.2 单测清单与 §9.3 联调清单。验收标准：

1. 问题 A 场景（重启后点踩）卡片内容零丢失；
2. 问题 B 场景（旧卡点踩）反馈记录、卡片重绘、其它卡片三者全部正确隔离；
3. 存量卡点击不报错、行为与今天一致；
4. 全部后端单测通过，无新增 `any` / 类型绕行。

## 11. 风险与权衡

### 11.1 回调 3 秒窗口

点击链路新增 ≤2 次轻量查询（快照行 + toggle 既有 2-3 次），无外部 HTTP，量级 <10ms；与原方案风险评估结论一致。

### 11.2 快照表增长

一行 = 一张飞书完成卡，content ≤6000 字符（utf8mb4 最坏 ~24KB，典型远低）。以日均千卡估算年增约数十 MB，可接受；保留策略（如按 created_at 清理 N 天前）列为后续单独立项，本期不做——清理会让被清卡片退化回兜底路径，需产品确认可接受。

### 11.3 时序依赖

`persistTerminal` 依赖「终态 PATCH 时最终 ASSISTANT 消息已落库」。主路径（`agent-inbound-handler.ts:680-682`）与重试路径（`:294-296`）均满足（`execute()` 返回后才 `complete()`）。若异常导致查不到消息：跳过持久化并 warn，该卡点击退化为兜底路径，不阻断主流程。

### 11.4 存量卡兜底

升级前发出的卡片无快照行，点击仍复现今天的行为（会话级 toggle + 可能空卡）。这是有意的兼容选择（D5）：为存量卡做消息反查推导成本高、收益随卡片过期归零。

### 11.5 与既有飞书卡片机制的交互

- ask 表单门禁、`refreshProgress`、崩溃恢复定位、失败重试定位全部走 session 键或 `feishu_progress_card` 表，与本方案双键注册表/新快照表无交叉影响。
- dislike 按钮仅存在于 COMPLETED 卡，不会与 RUNNING 态取消按钮、提问表单同场出现。

## 12. 里程碑拆分

| 里程碑 | 内容 | 交付物 |
| --- | --- | --- |
| M1 数据层 | 迁移 V161 + card-snapshot repository + 单测 | 表与仓储可独立合并 |
| M2 持久化接线 | patched-progress `persistTerminal` + create-app 装配 + 单测 | 完成卡自动落快照（问题 A 的数据基础） |
| M3 归属与重绘 | 注册表双键 + card-action 重写 + feedback messageId 参数 + 单测 | 问题 A/B 全解 |
| M4 收尾 | 联调清单、回归、CHANGELOG、mao-cli 同步 | 可发版 |

每个里程碑独立可回滚：M1/M2 不回滚点踩行为（只加表加写入），M3 是行为切换点，出问题可按 D5 口径快速退化为 session 级（移除按卡解析即可）。
