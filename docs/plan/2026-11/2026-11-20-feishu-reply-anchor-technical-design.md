# 飞书图片 / 文件引用锚点改为「本轮触发消息」技术方案

- 状态：已实施（2026-11-21 07:50 `a345befe` 落地，13 文件 +385/-37；V199 于 2026-11-22 22:07 在生产库执行；2026-11-26 12:50 蓝绿部署后在线生效。评审的 4 处事实性偏差与 1 处加固已由实现提交直接合入本文）
- 日期：2026-11-20
- 一句话：`send_image` / `send_file` 推到飞书时，改为引用**本轮执行的那条触发消息**；没有触发消息的主动推送（定时任务、平台排队）保持今天的「最新入站」口径。
- 关联代码（撰写时已核实的现状，全部为当前 `main`）：
  - 发送工具：`backend-ts/src/harness/tool/impl/send-media-tool.ts:291-324`（`FeishuSendStrategy`）
  - 发送目标解析：`backend-ts/src/app-harness-engine.ts:249-277`（`feishuMediaSendSupport.resolveSendTarget`，锚点调用在 `:257`）
  - 锚点查询：`backend-ts/src/feishu/message.repository.ts:337-356`（`findLatestInboundMessageId`）
  - 发送落地：`backend-ts/src/feishu/media-sender.ts:62-82`（`sendFeishuMediaMessage`）
  - 会话→通道绑定表：`backend-ts/db/migration/V101__feishu_p2p_multi_session.sql:19-30`（`feishu_session_channel`）
  - 文本回复对照路径：`backend-ts/src/feishu/inbound-processor.ts:313-314` → `app-feishu-handler.ts:428` → `backend-ts/src/feishu-client.ts:58-71`（注意 `feishu-client.ts` 在 `src/` 根，不在 `src/feishu/`）
- 关联方案：[2026-11-18-unified-send-media-technical-design.md](./2026-11-18-unified-send-media-technical-design.md)（本次改动落在其「通道推送」一侧，不影响会话副本）

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 触发消息 | 真正让这一轮 Agent 执行的那条飞书消息（`FeishuInboundContext.messageId`）。合并窗口触发的取批内**首条** |
| 引用锚点（reply anchor） | 媒体消息发送时传给 `im.v1.message.reply({ path: { message_id } })` 的那个消息 ID。飞书据此渲染「回复 X：…」 |
| 轮次 | 一次 `runExecution`：从进度卡片创建到 `harnessService.execute` 收尾。同一会话串行，排队消息各自成一轮 |
| 入站消息 | 库里记下的飞书群/私聊消息：`feishu_group_message_log`、`feishu_p2p_message(direction=IN)` |
| 主动推送 | 没有飞书触发消息的发送：定时任务播报、Webhook、`message_queue` 排队执行、卡片重试 |

## 1. 现状与问题

### 1.1 现状链路（图片 / 文件）

1. `send_image` / `send_file` 判定通道为 `feishu` 后调用 `FeishuSendStrategy.pushImage`（`send-media-tool.ts:291-324`），拿不到目标时再回落父会话（边路任务）。
2. `app-harness-engine.ts:244-271`：
   - `findSessionChannel(sessionId)` 查 `feishu_session_channel` → `appId / chatId / chatType`（`message.repository.ts:323-328`）；
   - `feishuSendTargetOf()` 解析 `receive_id`（`media-sender.ts:22-29`）；
   - `findLatestInboundMessageId(sessionId, channel)` 取引用锚点（`app-harness-engine.ts:252`）。
3. `message.repository.ts:337-356` 的锚点规则：
   - 私聊：`feishu_p2p_message` 中 `session_id + direction='IN'` 按 `created_at DESC` 取一条；
   - 话题群：`feishu_thread_session.root_message_id`（保证回复落进当前话题）；
   - 普通群：`feishu_group_message_log` 中 `app_id + chat_id` 按 `created_at DESC` 取一条（**不区分是否 @机器人，也不区分发送者是不是机器人**）。
4. `media-sender.ts:62-82`：有锚点走 `message.reply()`，没有锚点退化为 `message.create()`。

### 1.2 与文本回复的口径差异

文本最终回复走的是另一条路：`inbound-processor.ts:313-314` 把 `first.event` 传给 `sendReply`，`app-feishu-handler.ts:428` → `feishu-client.ts:58-71` 直接用 `event.messageId` 做 `message.reply`，**锚定的是触发消息**（仅群聊；私聊文本因 `chatType === 'group'` 分支不命中走 `message.create()`，本就不带引用）。

于是群聊里同一轮「文字回 A、图片回 B（B = 发图那一刻群里的最后一条消息）」；私聊里则是「文本无引用、图片回最新一条」。

### 1.3 线上证据（2026-11-20 09:02 那条）

群 `oc_75c697fd0f08561400ef235a325c55f1`：

| id | 发送者 | 内容 | 入库时间 |
|---|---|---|---|
| 25662 | 贾海勇 | 搞定了 | 2026-11-19 20:45:27 |
| 25718 | 贾海勇 | [图片] dealer-member 的 api 模块… | 2026-11-20 09:10:51 |

09:02 发图时该群最新行为 25662，下一条 09:10:51 才入库 → 截图里「回复 贾海勇：搞定了」就是「发送时刻最新入站消息」的结果，而不是「触发这一轮的那条消息」。

### 1.4 问题

1. **锚点随时间漂移**：任务跑得久、群里有人插话（哪怕没 @机器人），图片就挂到后一条消息下，看起来像回错了人。
2. **会挂到别的机器人**：`feishu_group_message_log` 里存在 `sender_name = 机器人_xxxx` 的行（其他 Mao bot 在同一群里发的卡片），极端情况下图片 reply 到机器人卡片上。
3. **同秒并列不确定**：`created_at` 是秒级 `DATETIME`（`V084__feishu_bot_channel.sql:79`），`ORDER BY created_at DESC` 没有 `id DESC` 兜底，同秒多条时锚点随机。
4. **两套口径**：文本回触发消息、媒体回最新消息，用户观感不一致，也让「引用」这个动作失去可预期性。
5. **私聊排队错引**：用户连发两条，第一条轮次发图时会引用第二条（`p2p` 取的是最新 IN）。

## 2. 目标与非目标

### 2.1 目标

1. 轮次内发送的图片 / 文件，引用**本轮触发消息**；群聊、话题群、私聊三种形态一致。
2. 没有触发消息的主动推送，行为与今天完全一致（最新入站 → 兜底 `message.create()`）。
3. 触发消息不可回复（被撤回 / 删除）时自动降级为普通消息，不让整次发送失败。
4. 锚点读写失败一律降级，不阻断执行主流程。

### 2.2 非目标

- 不改文本回复链路（群聊 `sendFeishuText` 已是触发消息锚定；私聊文本本就不带引用，改后会出现「私聊媒体有引用、文本无引用」的不对称，属有意保留——媒体引用突出附件归属，文本紧跟在进度卡片之后不致歧义）。
- 不给 `send_image` / `send_file` 增加「指定引用某条消息」的参数：模型不能自选锚点。
- 不改 `feishu_group_message_log` 结构，不改群上下文注入与水位线逻辑。
- 不迁移历史消息、不做存量回填（新列 `NULL` 即旧口径）。
- 不修复「同秒并列」本身，只让锚点命中时不再依赖它。
- 不改微信 / 钉钉通道的发送语义。

## 3. 技术选型

| # | 决策点 | 结论 | 理由 / 备选否决 |
|---|---|---|---|
| D1 | 锚点存哪里 | **`feishu_session_channel` 加列 `last_trigger_message_id`** | 该表按 `session_id` 唯一、会话创建时必落行（p2p / 群 / 话题三条路径都会 `upsertSessionChannel`）。备选「新表」要多一套 CRUD 与迁移；备选「进程内 Map」在蓝绿重启、崩溃恢复下丢锚点且不可观测 |
| D2 | 何时写 | **`runExecution` 开头**（每轮真正开始执行时） | 入队时写会提前覆盖上一轮锚点（排队消息尚未成为「本轮触发」）；`FeishuInboundProcessor.prepareOne` 阶段还没有 sessionId |
| D3 | 何时清 | **`runExecution` 的 `finally` 里清空** | 不清则定时任务播报会引用上一次有人 @bot 的旧消息，甚至跨话题。清空后主动推送回到今天的「最新入站」口径，零回归 |
| D4 | 话题群是否也改用触发消息 | **改** | 触发消息本身在话题内，reply 它会自动落进该话题，同时带上正确引用。`root_message_id` 继续作为回退（主动推送时仍落话题） |
| D5 | 私聊是否一并改 | **改（同一列，零额外成本）** | 修掉「连发两条时第一轮错引第二条」 |
| D6 | reply 失败的降级条件 | **只在 `message.reply` 返回非 0 `code` 时降级 `message.create()`** | 飞书明确拒绝（典型：触发消息已撤回 / 删除）才降级。网络超时等未知结果不降级，避免同一张图发两遍 |
| D7 | 读取优先级 | **锚点 → 原三分支回退**，方法改名 `findReplyAnchorMessageId` | 名字必须反映「锚点」语义，否则下一个读代码的人还会以为是最新入站 |
| D8 | 合并窗口取哪条 | **批内首条 `messageId`** | `triggerMerged` 的 `context.messageId` 已是 `first.messageId`，与文本回复 `sendReply(accountId, first.event, …)` 完全一致，无需额外取数 |
| D9 | 失败处理 | **写/清失败只 `console.warn`；读失败降级 `null`** | 与 `message.service.ts` 现有降级风格一致（`findLatestInboundMessageId` 已如此） |

## 4. 详细设计

### 4.1 数据模型（迁移 V199）

```sql
-- V199__feishu_reply_anchor.sql
ALTER TABLE `feishu_session_channel`
  ADD COLUMN `last_trigger_message_id` VARCHAR(128) NULL
  COMMENT '本轮执行的触发消息 ID（图片/文件 reply 锚点，轮次结束清空）'
  AFTER `awaiting_first_message_title`;
```

- 可空、不回填：`NULL` = 沿用旧口径，存量会话立即兼容。
- 不加索引：读取恒按 `uk_feishu_session_channel(session_id)` 命中一行。
- `updated_at` 带 `ON UPDATE CURRENT_TIMESTAMP`，每轮开始/结束各刷新一次；全仓对该表只有 3 条 SQL（`upsertSessionChannel` / `findSessionChannel` / `clearAwaitingFirstMessageTitle`），**没有任何逻辑依赖 `updated_at`**，无副作用。
- Flyway 在服务启动时执行（`create-app.ts:231` → `db/flyway.ts:378` `runFlywayIfEnabled`），蓝绿期间旧实例不读该列，前后兼容。

### 4.2 仓储层（`feishu/message.repository.ts`）

接口新增 / 改名：

```ts
/** 记录本轮触发消息作为 media reply 锚点。 */
setReplyAnchor(sessionId: number, messageId: string): Promise<void>;
/** 清空锚点：主动推送回到「最新入站」口径。 */
clearReplyAnchor(sessionId: number): Promise<void>;
/** reply 锚点：优先本轮触发消息；缺省回退最新入站（p2p / 话题根 / 群最新）。 */
findReplyAnchorMessageId(
  sessionId: number,
  channel: { appId: string; chatId: string; chatType: 'p2p' | 'group' },
): Promise<string | null>;
```

> `channel` 沿用现有内联结构（当前 `findLatestInboundMessageId` 与其 service 封装各自重复写了一遍），本方案不额外抽类型别名，避免扩大 diff。

实现：

```ts
async setReplyAnchor(sessionId: number, messageId: string): Promise<void> {
  await this.db.execute(
    'UPDATE feishu_session_channel SET last_trigger_message_id = ? WHERE session_id = ?',
    [messageId, sessionId],
  );
}

async clearReplyAnchor(sessionId: number): Promise<void> {
  await this.db.execute(
    'UPDATE feishu_session_channel SET last_trigger_message_id = NULL WHERE session_id = ?',
    [sessionId],
  );
}

async findReplyAnchorMessageId(sessionId, channel): Promise<string | null> {
  const row = await this.db.queryOne<{ lastTriggerMessageId: string | null }>(
    'SELECT last_trigger_message_id FROM feishu_session_channel WHERE session_id = ? LIMIT 1',
    [sessionId],
  );
  const anchor = row?.lastTriggerMessageId;
  if (anchor != null && anchor !== '') return anchor;
  return this.latestInboundMessageId(sessionId, channel);  // 原 findLatestInboundMessageId 转私有，逻辑不变
}
```

- 原 `findLatestInboundMessageId` 的三段逻辑（p2p IN 最新 / 话题根 / 群最新）整体保留，只是降级为回退分支，`SQL` 一字不改。
- `UPDATE` 命中 0 行（历史异常数据缺通道行）不报错，静默跳过，读取侧自然回退。

### 4.3 服务层（`feishu/message.service.ts`）

沿用现有薄封装 + 降级风格（参照 `findLatestInboundMessageId` 的 `try/catch` + `console.warn`）：

```ts
/** 记录本轮触发消息锚点；失败只告警（发送时回退最新入站）。空 messageId 视为 no-op。 */
async setReplyAnchor(sessionId: number, messageId: string | null | undefined): Promise<void>
/** 清空锚点；失败只告警（下轮 begin 会覆盖）。 */
async clearReplyAnchor(sessionId: number): Promise<void>
/** reply 锚点（触发消息优先）；查询失败降级 null → 发送侧回退 create。 */
async findReplyAnchorMessageId(sessionId: number, channel): Promise<string | null>
```

### 4.4 发送目标解析（`app-harness-engine.ts`）

只改一行调用（`:257`）：

```ts
const replyMessageId = await d.feishuMessageService.findReplyAnchorMessageId(sessionId, channel);
```

`resolveSendTarget` 的其余逻辑（通道行查询、`feishuSendTargetOf`、`target.sessionId`、父会话回落）不动；`FeishuSendTarget.replyMessageId` 契约不变，因此 `send-media-tool.ts`、`media-sender.spec.ts` 的既有用例不需要改语义。

### 4.5 轮次生命周期（`feishu/agent-inbound-handler.ts`）

`runExecution`（`:752-804`）是直接执行与排队消费两条路径的公共入口（仅 `executeDirect:619` / `executeQueued:719` 两个调用点），当前结构是 `try { … } catch { … }`、**没有 finally**。改动：

```ts
private async runExecution(sessionId, context, message, executionUserId, cancelFlag, queueRow?) {
  let executionId = '';
  let cardListener: FeishuCardProgressListener | null = null;
  try {
    try { await this.options.replyAnchor?.begin(sessionId, context.messageId); }  // ← 新增：本轮锚点
    catch (error) { console.warn(`记录飞书触发消息锚点失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`); }
    try { /* 进度卡片（不变） */ } catch { /* 不变 */ }
    …（原有执行体不变）
  } catch (error) {
    …（原有失败分支不变）
  } finally {
    try { await this.options.replyAnchor?.end(sessionId); }                       // ← 新增：轮次结束清空
    catch (error) { console.warn(`清除飞书触发消息锚点失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
```

`options` 新增可选端口（缺省不启用，测试替身无需实现）：

```ts
/** 图片/文件 reply 锚点：轮次开始记录触发消息，结束清空。实现内部吞错，不阻断执行。 */
replyAnchor?: {
  begin(sessionId: number, messageId: string | null | undefined): Promise<void>;
  end(sessionId: number): Promise<void>;
};
```

要点：

- **三个 return（CANCELLED / COMPLETED / FAILED）都经过 finally**，锚点不会漏清。
- **`begin` / `end` 各自包一层本地 `try/catch`**：服务层（message.service）已吞错，这里是第二道结构保险——`finally` 里直接 `await end()` 一旦 reject 会**顶掉 try 块的原返回值**（JS 语义），`begin` 抛错则会落进外层 catch 把整轮误标 FAILED。目标 4（锚点失败不阻断主流程）必须由 `runExecution` 自身结构保证，不能依赖端口实现自觉。生产适配器吞错后此层 warn 不会触发，也不会与服务层 warn 双份打日志。
- 锚点在 `saveUserMessage` 之前写入，与 `harnessService.execute` 内的工具调用之间有足够时序余量。
- 排队消息在自己的轮次开始时才写锚点（`reconstructFromQueue` 已恢复 `context.messageId`，`agent-inbound-handler.ts:147`），因此"排队两条各引各的"天然成立。
- 同一会话轮次经 busy/mutex 串行，上一轮 `finally` 清空先于下一轮 `begin` 写入，中断/排队接力场景不会出现「新一轮锚点被旧一轮收尾清掉」。

### 4.6 装配（`app-feishu-handler.ts`）

`AgentFeishuInboundHandler` 的 options（`:130` 起）里加：

```ts
replyAnchor: {
  begin: (sessionId: number, messageId: string | null | undefined) =>
    feishuMessageService.setReplyAnchor(sessionId, messageId),
  end: (sessionId: number) => feishuMessageService.clearReplyAnchor(sessionId),
},
```

`feishuMessageService` 在该作用域已存在（`:130` 之前的装配），无需新增依赖。

### 4.7 发送侧降级（`feishu/media-sender.ts:62-82`）

```ts
async function sendFeishuMediaMessage(client, target, msgType, content, label) {
  const replyId = target.replyMessageId;
  if (replyId != null && replyId !== '') {
    const replied = await client.im.v1.message.reply({
      path: { message_id: replyId },
      data: { msg_type: msgType, content },
    });
    if (Number(replied.code ?? 0) === 0) {
      return (replied as { data?: { message_id?: string } }).data?.message_id ?? null;
    }
    // 触发消息被撤回 / 删除等明确拒绝：降级为普通消息，避免整次发送失败
    console.warn(`飞书${label}消息 reply 失败，降级为普通消息: messageId=${replyId}, code=${replied.code}, msg=${replied.msg}`);
  }
  const response = await client.im.v1.message.create({
    params: { receive_id_type: target.receiveIdType },
    data: { receive_id: target.receiveId, msg_type: msgType, content },
  });
  if (Number(response.code ?? 0) !== 0) {
    throw new Error(`飞书${label}消息发送失败: code=${response.code ?? 'unknown'}, msg=${response.msg ?? 'no message'}`);
  }
  return (response as { data?: { message_id?: string } }).data?.message_id ?? null;
}
```

- 只在「飞书返回非 0 `code`」时降级；`reply` **抛异常**（超时 / 连接中断）直接失败，不猜测成功与否，避免同一张图发两遍（与今天行为一致）。
- 降级路径**保留兜底错误信息**：`create` 也失败时抛的是 `create` 的 code/msg，reply 的原因只进日志。

### 4.8 时序（群聊，有人插话）

```
用户A @bot "看下昨天的告警"        ──► inbound-processor.prepareOne → onMessage → runExecution
                                        ├─ replyAnchor.begin(session, om_triggerA)        ← 写库
                                        ├─ harness.execute(...) → send_image
                                        │     └─ resolveSendTarget → findReplyAnchorMessageId → om_triggerA
                                        │        → im.v1.message.reply(om_triggerA)  【引用 A 那条】
用户B 插话 "顺便看下今天的"（未 @bot）  ──► 只落 feishu_group_message_log，不影响锚点
                                        └─ finally: replyAnchor.end(session)              ← 清空
定时任务播报 09:00                      ──► 无 begin → 锚点 NULL → 回退「最新入站」= B 那条（与今天一致）
```

## 5. 行为对照表

| # | 场景 | 今天 | 改后 |
|---|---|---|---|
| 1 | 群聊 @bot，轮次内发图，无人插话 | 引用最新入站（通常就是那条 @） | 引用触发消息（结果相同，但不再依赖时序） |
| 2 | 群聊 @bot → 别人插话（含未 @bot）→ 发图 | **引用插话那条** | 引用 @bot 那条 |
| 3 | 群聊 @bot → 其他机器人发卡片 → 发图 | 可能引用机器人卡片 | 引用 @bot 那条 |
| 4 | 话题群 @bot → 发图 | 引用话题根 | 引用话题内触发消息（reply 仍在同一话题） |
| 5 | 私聊连发两条，第一条轮次中发图 | **引用第二条** | 引用第一条 |
| 6 | 合并窗口批内多条 | 引用最后入库的一条 | 引用批内首条（与文本回复一致） |
| 7 | 定时任务播报（含图片） | 引用群里最新一条 | **不变**（锚点已清空 → 最新一条） |
| 8 | 触发消息被撤回后发图 | reply 失败，整次发送失败 | 降级普通消息，图仍发到群里 |
| 9 | 会话缺 `feishu_session_channel` 行 | 无锚点 → `message.create()` | 行为不变：`resolveSendTarget` 解析不到目标即报错/回落父会话，锚点查询不会执行；仓储/服务的「SELECT 无行、锚点空串 → 回退」分支保留作兜底（UPDATE 0 行同样静默） |
| 10 | 边路任务回落父会话发图 | 引用父会话最新入站 | 引用父会话本轮触发消息 |

## 6. 兼容与迁移

| 项 | 处理 |
|---|---|
| 迁移 | `V199`，只加列；Flyway 启动执行（`db/flyway.ts` + `create_lock`）。旧实例不读该列，蓝绿期间双向兼容 |
| 存量数据 | 不回填。`NULL` 的行为与今天完全一致，直到对应会话下一轮触发写入 |
| 回滚 | 回退代码即可；列留在库里无副作用（旧代码不 SELECT 它） |
| 方法改名 | `findLatestInboundMessageId` → `findReplyAnchorMessageId`，调用点仅 3 处：`app-harness-engine.ts:257`、`message.service.ts:120-122`、`message.service.spec.ts:38`（替身）。仓储里的私有实现保留原名 `latestInboundMessageId` 作为回退分支 |
| 测试替身 | `replyAnchor` 为可选端口，`agent-inbound-handler.spec.ts` 现有 options 不需要补字段；只在新增用例里注入 |

## 7. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | 进程崩溃 / 强杀发生在轮次中，锚点残留 | 之后的主动推送（定时任务）可能引用上一次触发消息（甚至跨话题） | 正常路径由 `finally` 清理；崩溃残留影响面限于「引用位置」，不影响消息送达。本期不加 TTL；若评审要求，可再评估 `last_trigger_at` + 时效判断（多一列、多一次判断，收益低） |
| R2 | `reply` 网络超时但实际已成功 | 本轮报「发送失败」，群里实际有图 | 与今天完全一致（今天也抛错）。不做自动重试，避免重复发送 |
| R3 | 每轮多 2 次 `UPDATE` | 写放大 | 飞书轮次 QPS 极低；`updated_at` 刷新无消费方 |
| R4 | 触发消息所在话题与发送目标不一致 | reply 落到错误位置 | 不可能：锚点写的是本轮 `context.messageId`，话题会话的 context 必然在同一 `threadId` 下 |
| R5 | 边路任务回落父会话时读到父会话锚点 | 引用父会话那轮触发 | 可接受；父会话串行执行，不存在"另一轮同时在跑"的常规场景 |
| R6 | 话题根被删除后 reply 降级 | 图落到主群而不是话题 | 可接受的降级（记 warn），比整次失败好 |

## 8. 测试

### 8.1 单测清单

| 文件 | 用例 |
|---|---|
| `feishu/message.repository.spec.ts` | ① 锚点非空 → 只查 `feishu_session_channel`，不查日志表；② 锚点为空 / 无行 → 回退 p2p、话题根、群最新三分支（各一条）；③ `setReplyAnchor` / `clearReplyAnchor` 的 SQL 与参数断言 |
| `feishu/message.service.spec.ts` | ① 仓储抛错 → `findReplyAnchorMessageId` 返回 null 且 warn；② `setReplyAnchor` / `clearReplyAnchor` 异常不外抛；③ 空 messageId no-op |
| `feishu/agent-inbound-handler.spec.ts` | ① 普通轮次：`begin(sessionId, messageId)` 在 `saveUserMessage` 前调用、`end(sessionId)` 在结束后调用；② 排队轮次：`begin` 使用队列行恢复的 `messageId`；③ 执行抛错 / 取消：`end` 仍被调用；④ 注入直接抛错的端口替身：`begin` / `end` 抛错不外溢、轮次终态与返回值不受影响（校验 runExecution 自身的 try/catch，而非依赖 service 吞错） |
| `feishu/media-sender.spec.ts` | ① `reply` 返回 `code≠0` → 走 `create` 并返回新 messageId；② `reply` 抛异常 → 直接抛、不调 `create`；③ 无 `replyMessageId` → 直接 `create`（现有用例保留） |

### 8.2 手工验证（测试群）

1. 群里 @bot：「看下昨天的错误日志，发个图给我」；
2. 机器人执行期间，让另一位同事在群里随意发言（不 @bot）；
3. 机器人 `send_image` 后检查飞书：引用应为第 1 步那条 @ 消息，并带姓名。
4. 对照项：同一群里让定时任务播报一次，引用仍应是群里最新一条消息。

### 8.3 数据 / 日志验证

```sql
-- 轮次进行中：锚点存在
SELECT session_id, last_trigger_message_id, updated_at
FROM feishu_session_channel WHERE session_id = ?;
-- 轮次结束后：应为 NULL
```

日志关键字：`飞书图片消息 reply 失败，降级为普通消息`（降级发生）、`清除飞书触发消息锚点失败` / `记录飞书触发消息锚点失败`（写失败降级）。

## 9. 实施步骤与工作量

| # | 文件 | 改动 | 预估 |
|---|---|---|---|
| 1 | `backend-ts/db/migration/V199__feishu_reply_anchor.sql` | 新增加列迁移 | +4 |
| 2 | `feishu/message.repository.ts` | 接口 +3、实现 +25、原方法转私有 | +30 / -8 |
| 3 | `feishu/message.service.ts` | 三个封装（含降级） | +18 |
| 4 | `app-harness-engine.ts` | 改 1 行调用 | +1 / -1 |
| 5 | `feishu/agent-inbound-handler.ts` | options 端口 + begin/finally end | +12 |
| 6 | `app-feishu-handler.ts` | 端口装配 | +4 |
| 7 | `feishu/media-sender.ts` | reply 失败降级 | +12 / -4 |
| 8 | 三个 spec + `media-sender.spec.ts` | 见 §8.1 | +70 |
| 9 | `changelog/unreleased/YYYY-MM-DD-feishu-reply-anchor.md` | 按 unreleased 约定新增碎片（只写 `### 后端` 小节和条目；根 `CHANGELOG.md` 是索引勿手改）。「图片引用口径」的完整说明由本方案文档承担，`docs/agents/` 目录不存在、不新建运维文档 | +8 |

合计 **9 项改动、12 个文件**（1 个迁移 + 6 个源码 + 4 个 spec + 1 个 changelog 碎片），约 **160 行**，其中生产代码约 75 行。

实施顺序：迁移 → 仓储/服务 → 装配与轮次生命周期 → 发送侧降级 → 单测 → 文档。
验证：`npm run build`、`npx vitest run src/feishu`。发布：工作区提交并推 `origin/main`，线上在 `/opt/mao` 拉取后跑 `restart-backend.sh`（Flyway 随启动执行 V199，蓝绿重启；仓库内部署脚本只有 admin/desktop 两个，后端无 `deploy-mao.sh`）。

## 10. 待确认

| # | 事项 | 默认 |
|---|---|---|
| 1 | 轮次结束清空锚点（D3）——若希望定时任务也挂"上一次触发"，去掉 `finally` 的 `end` 即可，但会出现跨天 / 跨话题引用 | 清空 |
| 2 | 话题群是否也改用触发消息（D4） | 改 |
| 3 | 是否为 R1 增加锚点时效兜底 | 本期不做 |
| 4 | 是否需要给 `feishu_session_channel` 补 `last_trigger_at` 便于排障 | 本期不做（`updated_at` 已随写入刷新） |
