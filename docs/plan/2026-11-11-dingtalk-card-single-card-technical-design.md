# 钉钉互动卡片一卡到底（排队卡 → 进度卡）与模板合并技术方案

> 评审状态：待评审。本文档只描述方案，不包含实施。
> 前置约定：**不考虑历史数据与存量兼容**。数据库列、后台字段、环境变量一律以最终形态为准，不做迁移回填、不留双轨、不保留回落链。

## 1. 需求背景

### 1.1 现象

钉钉通道在会话繁忙时会话收到新消息，会**发出两张互不相干的卡片**：

1. 排队卡（模板 `queue_card_template_id`）：只投放一次，内容固定为「排队中」，带「立即发送」/「取消排队」按钮，**此后永不更新**；
2. 进度卡（模板 `progress_card_template_id`）：等到这条排队消息真正开始执行时，才由 `createProgressCard` **新建一张**。

结果：用户在会话忙时连发两条消息，会话里会同时躺着「排队中」旧卡 + 「正在处理」新卡 + 最终「处理完成」卡。旧排队卡永远停在排队态，成为残留信息，用户无法从会话流里看出一条消息的完整生命周期。

### 1.2 与飞书通道的差距

飞书通道早已是**一卡到底**：排队卡拿到 `card_message_id` 后写进队列行，队列被消费时 `createProgressCard` 看到 `context.progressCardMessageId` 非空，**不新建卡片，直接 `message.patch` 那张排队卡**（`backend-ts/src/feishu-cards.ts:189-195`、`backend-ts/src/feishu/agent-inbound-handler.ts:154`）。CHANGELOG 0.0.61 明确记录「卡片一卡到底…全生命周期不刷屏」。

钉钉没有做到，纯粹是因为**接线缺失**，不是因为平台不支持。

### 1.3 目标

- **第一步（核心）**：钉钉排队卡在被消费时**就地升级**为进度卡，此后沿用进度卡生命周期（执行中 → 完成/失败/取消）。全程一条消息，不新增卡片、不残留旧卡。
- **第二步（模板合并）**：把排队卡与进度卡合并为**单一模板 + 单一配置字段**，模板、`dingtalk_bot` 列、环境变量、admin 表单全部收敛为一个。

### 1.4 明确不做

| 不做项 | 说明 |
|--------|------|
| 绑定卡（OAuth 引导卡）合并 | 它是未绑定用户的一次性引导，3 分钟过期、不参与任务生命周期（`runtime.ts` `sendBindingCard`），并入只会把状态机搞复杂 |
| 微信通道同类改造 | 微信通道维持现状，本期不动 |
| 桌面/Web 端卡片 | 与 IM 通道无关 |
| 存量排队卡回刷 / 数据迁移 | 上线前遗留的旧排队卡实例不回刷；`dingtalk_bot` 两个模板 ID 列直接删旧留新，不回填旧值 |
| 前端五端其余改动 | 本期只动 `backend-ts` + `admin`（表单字段）+ `skills/mao-cli`（模板与文档） |

## 2. 关键前置调研结论

### 2.1 钉钉 `updateCard` 是增量更新，这是方案成立的基础

`PUT /v1.0/card/instances` 带 `cardUpdateOptions.updateCardDataByKey: true` 时为**增量更新**：只覆盖传入的 `cardParamMap` key，未传的变量保持原值；`false`（默认）为全量覆盖[^1^][^2^]。现有 `backend-ts/src/dingtalk/card-client.ts:70-88` 已固定传 `true`。

这意味着：**用排队卡的 outTrackId 调 `updateCard`，只传进度卡的变量，就能把排队卡改成进度卡的样子**，不需要新建实例。第一步零平台配置即可落地。

### 2.2 按钮可见性只能走 boolean 变量（本次已修复的约束）

钉钉卡片平台只把「boolean 变量 + `isTrue`/`isFalse`」渲染成可用的 `@data{...}` 条件；字符串 `isEqual` 比较导入后会被抹成空串（`@triple{'' , 'visible', 'gone'}` 恒假）。这是「取消/重试按钮不显示」的真实根因，已在提交 `032b3525` 修复（`canCancel` / `canRetry` 两个 boolean 变量）。**第二步合并模板时必须沿用该约束**，新增按钮同样只能用 boolean 变量。

### 2.3 回调路由天然支持一卡到底

`backend-ts/src/dingtalk/card-action.service.ts:37-48` 的回调分流：

```ts
if (event.actionId === 'run' || event.actionId === 'cancel') {
  const row = await this.options.queuePort.findByOutTrackId(event.outTrackId);
  if (row != null) return this.decideQueue(...);      // 排队卡
}
if (event.actionId === 'retry' || event.actionId === 'cancel') {
  const progress = await this.options.findProgress(event.outTrackId);
  if (progress != null) return this.decideProgress(...);  // 进度卡
}
```

- 排队卡 actionId：`cancel`、`run`（插队）
- 进度卡 actionId：`cancel`、`retry`
- `cancel` 共用，靠 `dingtalk_inbound_queue.out_track_id` 与 `dingtalk_progress_card.out_track_id` 谁先命中来分流

**结论：一卡到底后这张卡同时是两个表的潜在命中对象，actionId 不冲突，路由逻辑不用改。** 关键约束是：卡片升级为进度卡时，必须把 outTrackId 写进 `dingtalk_progress_card`，否则取消/重试回调第二段查不到它。

### 2.4 载体已就位，两步都不需要新表

`dingtalk_inbound_queue.out_track_id`（V120 已建）就是排队卡实例 ID，`updateCard` 接收的正是它。第二步只是**删一列、改一列**，不需要新表。

## 3. 现状代码索引

| 模块 | 位置 | 与本方案的关联 |
|------|------|----------------|
| 卡片参数拼装 | `backend-ts/src/dingtalk/card-body.ts` | `progressCardParams`（:32，已含 canCancel/canRetry boolean）/ `queueCardParams`（:70，preview 形态）变量集；第二步需统一 |
| 投放与更新 | `backend-ts/src/dingtalk/card-client.ts` | `createAndDeliverCard` / `updateCard`（:70-88，增量更新，不需要 templateId） |
| 卡片生命周期 | `backend-ts/src/dingtalk/runtime.ts` | `templateOf`(:154)、`cardProgress`(:192)、`createProgress`(:211)、`createQueueCard`(:308)、`noteReplyFailure`(:363)、`recoverProgress`(:551)、`pushScheduledResult`(:478，定时结果卡，**第二步 templateOf 调用点**，评审补充) |
| 回调路由 | `backend-ts/src/dingtalk/card-action.service.ts:37-48` | 排队/进度分流，`run`/`cancel`/`retry` 三个 actionId；`previewOf`(:8) |
| 入站编排 | `backend-ts/src/dingtalk/agent-inbound-handler.ts` | `enqueueMessage`(:413，先投卡 :432 后 setOutTrackId :433)；`executeQueued`(:505)；`contextFromQueue`(:699)；`dropQueued`(:609) |
| 队列仓储/服务 | `backend-ts/src/dingtalk/inbound-queue.{repository,service}.ts` | `outTrackId` 读写、CAS 认领、启动恢复 |
| 进度卡映射 | `backend-ts/src/dingtalk/progress-card.repository.ts` | `upsert`(:32) / `findBySessionId` / `findByOutTrackId`(:50) / `deleteBySessionId`(:58)，行含 chatType/conversationId |
| 定时结果卡 | `backend-ts/src/dingtalk/scheduled-result.ts` | `deliverScheduledDingtalkReply` 消费 `progressCardParams` + 外部传入 templateId（**第二步合并模板/参数收敛的消费方**，评审补充；不写进度卡映射，与升级分支无冲突） |
| 模板 JSON / 自检 / 说明 | `skills/mao-cli/template/` | 第二步合并对象（仓库内仅有 progress 模板 JSON，排队模板只存在于钉钉平台侧）；`check-template.js` 需扩展 |
| 飞书参照实现 | `backend-ts/src/feishu-cards.ts:189-195` | 一卡到底的既有范本 |

### 3.1 模板 ID 配置的现有引用点（第二步全部要改）

> 仓库内引用一律为 camelCase 字段（`progressCardTemplateId`/`queueCardTemplateId`）；snake_case 列名仅存在于 V120 迁移的 DDL 里——实现时不要拿 snake_case 全仓搜索。

| 层 | 位置 | 内容 |
|----|------|------|
| 数据库列 | `backend-ts/db/migration/V120__dingtalk_bot_channel.sql:10-11` | `progress_card_template_id`、`queue_card_template_id` |
| 后端类型 | `backend-ts/src/dingtalk/types.ts:13-14` | `DingtalkBot` 两个可选字段 |
| 后端仓储 | `backend-ts/src/dingtalk/bot.repository.ts:28-29,47-48` | create/update 两处各写两个字段 |
| 后端路由 | `backend-ts/src/dingtalk/admin.routes.ts:27-28,76-77,106-107` | 请求体两个字段 + create/update 赋值 |
| 后端配置 | `backend-ts/src/config/app-config.ts:13-14,222-223,582-583` | `DingtalkRuntimeConfig` 两个字段 + 两个 env |
| 装配 | `backend-ts/src/app-feishu-handler.ts:519-520` | 透传两个字段给 runtime |
| 模板选择 | `backend-ts/src/dingtalk/runtime.ts:154` | `templateOf(bot, kind)` 按 kind 读对应字段；**调用点含 `pushScheduledResult`(:497，定时结果卡)，第二步改签名时必须同步**（评审补充） |
| 管理后台 | `admin/src/views/dingtalk-bot/DingtalkBotListView.vue:105-110,148-149,169,243,252,267-268` | 两个表单输入框 + form 字段 + 提交体 |
| 文档 | `skills/mao-cli/reference/config.md:167-168`、`dingtalk-bot.md:53`、`admin.md:258` | 两个 env、两个 API 参数、后台说明 |

## 4. 第一步：排队卡就地升级为进度卡

### 4.1 设计思路

照搬飞书已验证的形态：把排队卡的 outTrackId 通过入站上下文传给 `createProgressCard`，命中时跳过 `createAndDeliverCard`、改用 `updateCard` 首次刷新，并补写进度卡映射。

飞书用 `context.progressCardMessageId` 承载，钉钉照此新增同义字段 `progressCardOutTrackId`，保持两端命名风格一致。

### 4.2 数据流

```
消息 D 到达（会话 BUSY）
 → enqueueMessage
    ├─ INSERT dingtalk_inbound_queue (status=QUEUED)
    ├─ createQueueCard → 投放排队卡，拿 outTrackId
    └─ setOutTrackId(queueId, outTrackId)          ← 已有

A 任务结束 → drainNext → claimNext 命中 D 行（status: QUEUED→RUNNING）
 → executeQueued(sessionId, row)
    ├─ contextFromQueue(payload, row)  → context.progressCardOutTrackId = row.outTrackId   ← 新增透传
    └─ runExecution(...)
         └─ createProgressCard(context, sessionId)
              ├─ outTrackId = context.progressCardOutTrackId
              ├─ 非空 → updateCard(outTrackId, progressCardParams({status:'running', ...}))
              │          + progressRepo.upsert({sessionId, botId, outTrackId, ...})       ← 新增映射
              │          + 返回 cardProgress(cred, outTrackId, ...)                       ← 沿用现有句柄
              └─ 为空 → 走原 createAndDeliverCard 新建路径（不变）
```

此后该卡的 running/completed/failed/cancelled 全部由 `cardProgress` 的 `updateCard` 驱动，与现有进度卡完全同一条链路。

### 4.3 详细改动点

#### 4.3.1 `types.ts`：上下文新增字段

```ts
export interface DingtalkInboundContext extends DingtalkNormalizedMessage {
  accountId: string;
  maoUserId?: number;
  groupContext?: string;
  senderLabel?: string;
  /** 排队卡实例 ID：非空表示本轮执行应就地升级该卡为进度卡，不新建卡片（飞书同义字段 progressCardMessageId）。 */
  progressCardOutTrackId?: string | null;
}
```

#### 4.3.2 `agent-inbound-handler.ts`：透传

`contextFromQueue(payload, row)`（:699）补一行：

```ts
progressCardOutTrackId: row.outTrackId,
```

`enqueueMessage`（:411）当前顺序是「先投卡、后 setOutTrackId」。注意 `createQueueCard` 的调用点在 `setOutTrackId` **之前**，因此升级用的 outTrackId 只能从**队列行**读（`row.outTrackId`），不能指望投卡返回值——`executeQueued` 拿到的 row 是后续 `claimNext` 的产物，其 `outTrackId` 已由 `setOutTrackId` 回填。**这条链路已通，不需要改 enqueueMessage。**

`createProgressCard` 的 options 签名（:95）不变（`(context, sessionId)`），因为 outTrackId 走 context 而非新增参数——与飞书保持一致，减少调用点改动。

#### 4.3.3 `runtime.ts`：`createProgress` 增加升级分支

```ts
const createProgress = async (context, sessionId) => {
  const botId = Number(context.accountId);
  const cred = await credentialsOf(botId);
  if (cred == null) return null;
  const sender = context.senderUserid ?? '';
  const startedAt = Date.now();
  const params = progressCardParams({
    status: 'running', round: 0, detail: '任务已接收，正在准备执行。',
    sessionUrl: await sessionDetailUrl(sessionId), sessionId, senderUserid: sender,
  });

  // 一卡到底：排队卡就地升级为进度卡（飞书同款）。队列行带了 outTrackId 就走 updateCard，
  // 不再 createAndDeliverCard 新建实例，避免旧排队卡残留「排队中」。
  const existing = context.progressCardOutTrackId?.trim();
  if (existing != null && existing !== '') {
    const token = await tokens.getAccessToken(cred.bot.clientId, cred.secret);
    await updateCard(fetchImpl, token, existing, params)
      .catch((error) => console.warn(`钉钉排队卡升级进度卡失败, sessionId=${sessionId}`, error));
    // 映射必须写：取消/重试回调靠 findProgress(outTrackId) 定位这张卡。
    await progressRepo.upsert({
      sessionId, botId, outTrackId: existing,
      chatType: context.chatType, conversationId: context.conversationId, senderUserid: sender,
    }).catch((error) => console.warn(`钉钉进度卡映射写入失败, sessionId=${sessionId}`, error));
    return cardProgress(cred, existing, sessionId, sender, startedAt);
  }

  const templateId = templateOf(cred.bot);          // 第二步后签名简化
  if (templateId == null) return textProgress(botId, context, sessionId);
  const outTrackId = await createAndDeliverCard(...);   // 原路径不动
  await progressRepo.upsert(...).catch(...);
  return cardProgress(cred, outTrackId, sessionId, sender, startedAt);
};
```

**关于升级失败的处理**：`updateCard` 失败时不应让任务失败——这里只 warn 并继续返回 `cardProgress`，后续每轮 `updateCard` 仍会尝试。但**映射无论如何都要写**：即使首刷失败，卡片实例仍在，写映射能让取消/重试继续可用。若连实例都已不存在，后续 `updateCard` 持续失败会由 `FeishuCardProgressListener` 折算为 `false`，终态自动回落文本回复（`agent-inbound-handler.ts:338-339` 已有该逻辑），用户不会两边都收不到。

#### 4.3.4 升级后 `templateOf` 检查的语义变化

原逻辑「`templateOf(cred.bot,'progress') == null` → 退化为文本进度」。升级分支**不再检查模板 ID**：卡片已经存在，更新它不需要模板 ID。这反而是个附带好处——**只配了模板 ID 的 bot，现在也能一卡到底**（原先这种配置下排队消息会另建文本/新卡）。`recoverProgress`（:513）与 `noteReplyFailure`（:357）仍保留模板 ID 检查，语义不变。

### 4.4 边界与竞态

| 场景 | 行为 |
|------|------|
| 用户点「立即发送」（`run`）插队 | `decideQueue` 把卡刷成「已插队」后 `interruptAndDrain`；drain 认领该行 → `executeQueued` → 升级分支把同一张卡刷成「任务已接收，正在准备执行。」**符合预期**：插队后紧接着就是执行。与飞书同（飞书此处靠回调 card 展示插队态，随后被进度卡覆盖） |
| 用户点「取消排队」（`cancel`） | `decideQueue` 刷成「已取消」，队列行被 `cancel()` 删除（`inbound-queue.service.ts` `cancel` → `deleteById`）。**卡片不会被升级**（行已不存在，drain 认领不到），残留一张终态「已取消」卡——正确 |
| 队列行被 `dropQueued` 丢弃（`---` 换会话） | 同上，卡片停留在最后一次状态，不再更新。可接受：会话指针已切走 |
| 升级分支 `updateCard` 抛错 | 只 warn，任务继续；后续轮次继续尝试更新 |
| 双实例同时消费同一队列行 | 行级 CAS（`claimNextQueued`）保证单实例消费，升级只发生一次 |
| 升级后 `afterDelivery` 删映射 | 按 sessionId 删 `dingtalk_progress_card`，一卡到底后语义更干净：卡片终态已由最后一次 `updateCard` 写入，删映射只是让回调不再命中 |

### 4.5 第一步的固有遗留（第二步的必要性）

第一步**不改任何模板**：排队卡仍是排队模板、进度卡仍是进度模板。升级只是「用进度卡变量刷新排队卡实例」——由于 `updateCardDataByKey=true` 是增量更新，排队卡模板里**只声明了自己用到的变量**，进度卡传进来的 `body`/`canCancel` 等 key 在排队卡模板中不存在，会被平台忽略，卡片主体保持排队卡排版。

**这意味着升级后的卡片排版仍是「排队卡排版」，只是文字变成了进度卡文字。** 第一步先拿到「一条消息、无残留」的行为收益，第二步再拿到排版收益。

此判断需上线后实证：增量更新遇到「模板中未声明的 key」的确切行为（忽略 vs 报错）尚未验证。若平台报错，第一步需改为「模板也加变量但隐藏」，或直接把第二步的合并模板提前。见 §7 风险 R1。

## 5. 第二步：模板与配置字段一并合并

### 5.1 目标形态

一个模板覆盖全部状态，`dingtalk_bot` 只保留一个模板 ID 列。

| 状态 | `status` 值 | 可见按钮 | boolean 变量 |
|------|-------------|----------|--------------|
| 排队中 | `queued` | 立即发送、取消排队 | `canRun=true` |
| 已插队 | `started` | 无 | 全 false |
| 已取消（排队） | `cancelled` | 无 | 全 false |
| 执行中 | `running` | 取消任务 | `canCancel=true` |
| 完成 | `completed` | 无 | 全 false |
| 失败 | `failed` | 重试 | `canRetry=true` |
| 取消（任务） | `cancelled` | 无 | 全 false |

`cancelled` 在排队取消与任务取消两种语义下复用：都是「这条消息不再执行」，终态文案由 `title`/`body` 区分即可，不需要两个值。

### 5.2 变量契约（并集）

| 变量 | 类型 | 说明 |
|------|------|------|
| `title` | string | 卡片标题（当前模板不渲染，仅语义占位） |
| `body` | markdown | 单一 markdown 变量，承载排队提示 + 状态行 + 正文 + 工具列表 |
| `status` | string | 七值语义占位，**不渲染成文本** |
| `canRun` | boolean | 排队态显示「立即发送」+「取消排队」 |
| `canCancel` | boolean | 执行中显示「取消任务」 |
| `canRetry` | boolean | 失败显示「重试」 |
| `senderUserid` | string | 原发送者（回调鉴权） |
| `queueId` | string | 队列行 ID（排队态需要） |
| `sessionId` | string | 会话 ID |
| `tag` | string | 卡片标签（当前未传，保留占位） |

`sessionUrl` 当前后端传了但模板未使用（已实证：`dingtalk-progress-card.json` 无 `sessionUrl`/`title` 绑定，只绑 `body`），合并时若不加「会话详情」按钮就不声明。

### 5.3 关键约束：所有 boolean 必须补齐

钉钉对未传变量的表现未实证。稳妥做法：**两个 `*CardParams` 都把三个 boolean 显式下发，无关态置 `false`**。这样任何一次更新都不会留下 undefined。

- `progressCardParams` 增补 `canRun: 'false'`（进度卡永远不该显示插队按钮）
- `queueCardParams` 增补 `canCancel: 'false'`, `canRetry: 'false'`，并新增 `canRun`
- 同时 `queueCardParams` 需要能发 `body`（替代 `preview`）才能让合并模板正确渲染——这是模板侧的前提，见 5.4

### 5.4 `preview` 与 `body` 合一

排队卡现在用 `preview`（80 字截断）单独一个变量。合并后统一用 `body`：排队态由 `queueCardParams` 自己拼一段 markdown（`**状态：排队中**` + 队列位次 + 消息摘要），运行/终态由 `progressCardParams` 拼。`preview` 变量删除。

**影响面**：`card-action.service.ts` 的 `decideQueue` 回调用 `queueCardParams({status, preview, queueId, senderUserid})`，签名随之调整；`previewOf(payload)` 辅助函数保留（从队列 payload 提取原文）。

### 5.5 actionId 与成功判定条件

| 按钮 | actionId | actionType | 可见性 | 成功判定条件 |
|------|----------|------------|--------|--------------|
| 立即发送 | `run` | `request` | `isTrue(canRun)` | `status == 'started'` |
| 取消排队 | `cancel` | `request` | `isTrue(canRun)` | `status == 'cancelled'` |
| 取消任务 | `cancel` | `request` | `isTrue(canCancel)` | `status == 'cancelled'` |
| 重试 | `retry` | `request` | `isTrue(canRetry)` | `status == 'running'` |

两个 `cancel` 是**同一个 actionId 出现在两个按钮上**，靠可见性互斥（`canRun` 与 `canCancel` 不会同时为 true）。回调侧 `decide` 已按 outTrackId 分流，能正确定位到队列行或进度卡映射。**这一点必须实测**：平台是否允许同模板内两个按钮共用 actionId（不同 id/不同 visible）——若不允许，需要把排队取消改名 `cancelQueue`，并相应改 `decide`。见 §7 风险 R2。

沿用已修复的硬约束：actionId 必须字面量、actionType 必须 `request`、按钮 `status` 不能 `disabled`、可见性只能 boolean + `isTrue`、`successCondition` 不能为空、ButtonBlock 要带区块级 `visible`。详见 `skills/mao-cli/template/README.md`。

### 5.6 配置收敛（一刀切，不做兼容）

按「不考虑历史数据与兼容」的约定，两个模板 ID 全部收敛为一个， naming 用 `cardTemplateId`（不再带 progress/queue 语义）。

#### 数据库

新增 `backend-ts/db/migration/V192__dingtalk_bot_single_card_template.sql`（当前最大版本 V191）：

```sql
ALTER TABLE `dingtalk_bot`
    ADD COLUMN `card_template_id` VARCHAR(128) NULL COMMENT '钉钉互动卡片模板ID（排队/进度/终态共用同一模板）' AFTER `model_id`;

ALTER TABLE `dingtalk_bot` DROP COLUMN `queue_card_template_id`;
ALTER TABLE `dingtalk_bot` DROP COLUMN `progress_card_template_id`;
```

不回填 `card_template_id`：新列为 NULL，上线后由用户在后台重新填一次。迁移只做结构变更，不搬运旧列的值。

#### 环境变量

`DINGTALK_PROGRESS_CARD_TEMPLATE_ID` 与 `DINGTALK_QUEUE_CARD_TEMPLATE_ID` 合并为 `DINGTALK_CARD_TEMPLATE_ID`。`app-config.ts` 的 `DingtalkRuntimeConfig` 只留 `cardTemplateId`，删掉两处 env 读取。`/opt/mao/backend-ts/.env` 当前未配这两个变量，无需同步清理。

#### 模板选择

```ts
const templateOf = (bot: DingtalkBot): string | null => {
  const value = (bot.cardTemplateId != null && bot.cardTemplateId !== '' ? bot.cardTemplateId : deps.config.cardTemplateId).trim();
  return value === '' ? null : value;
};
```

去掉 `kind` 参数。调用点：`createProgress`（新建路径）、`createQueueCard`、`recoverProgress`、`noteReplyFailure`、**`pushScheduledResult`（:497，定时结果卡——评审补充；同链路的 `deliverScheduledDingtalkReply` 还消费 `progressCardParams`，`canRun: 'false'` 增补对其自动生效且语义正确：定时结果卡不该显示插队按钮）**。

#### 管理后台

`DingtalkBotListView.vue`：两个输入框合并为一个「卡片模板」，form 字段 `cardTemplateId`，提交体同步。

#### 模板文件

`skills/mao-cli/template/dingtalk-progress-card.json` 重命名为 `dingtalk-card.json`，并就地改造为合并模板。改名需同步：`check-template.js` 的 `file` 常量、`README.md` 的文档内引用。旧文件名不再保留。平台侧旧的排队卡模板成为孤儿实例（仓库内本就没有排队模板 JSON，实证 template 目录仅有 progress 一份），可由用户在钉钉开放平台手动删除（可选，不阻塞）。

### 5.7 自检脚本扩展

`skills/mao-cli/template/check-template.js` 的 `ACTION_STATUS` / `ACTION_VISIBLE` 目前硬编码 `cancel`/`retry` 两个按钮。改为按 `(actionId, visibleVar)` 组合校验：

```js
const ACTION_STATUS = { cancel: 'cancelled', retry: 'running', run: 'started' };
const ACTION_VISIBLE = { cancel: ['canCancel', 'canRun'], retry: ['canRetry'], run: ['canRun'] };
```

（`cancel` 有两个可见性来源，任一命中即通过，且必须同时校验 boolean 声明。）同时把 `REQUIRED_VARS` 扩到并集，并新增检查：`preview` 变量不得再出现在 variableList（已与 `body` 合一）。

## 6. 两步的依赖关系与顺序

```
第一步（接线 + 配置收敛前的纯行为改动，零模板改动）
   ├─ 收益：一条消息、无残留卡、取消/重试全链路可用
   └─ 遗留：升级后的卡片排版仍是排队卡排版
第二步（模板合并 + 配置字段一刀切）
   ├─ 前置：第一步已上线且稳定（升级路径已被验证）
   ├─ 收益：排版正确、单一模板、单一配置字段
   └─ 依赖：平台行为实证（§7 R1/R2）
```

**第一步可独立上线并交付价值**，第二步是其排版与配置层面的完善。两步都做，第一步先行。

> 注意：第二步的迁移会删列，因此**第二步不能回退到第一步的代码状态**（代码已不读旧列）。部署顺序必须是「先发代码 + 迁移，再在后台填新模板 ID」；若迁移执行后未及时填 ID，卡片退化为文本进度（`templateOf` 返回 null），任务本身不受影响。

## 7. 风险与未实证项

| # | 风险 | 影响 | 缓解 |
|---|------|------|------|
| R1 | 增量更新（`updateCardDataByKey=true`）遇到「本次传入但模板未声明的 key」时，平台行为未知（忽略 / 报错 / 其他） | 决定第一步能否零模板改动上线 | 第一步上线前先用现有排队卡模板 + 进度卡变量实测一次 `updateCard`；若报错，则第一步同时给排队卡模板补上 `body`/`canCancel`/`canRetry` 变量（排版仍不变，仅让 key 有声明），或直接把第二步的合并模板提前 |
| R2 | 同一模板内两个按钮共用 actionId `cancel`（靠 visible 互斥）是否被平台允许 | 决定 5.5 的设计能否成立 | 导入前先在卡片平台试；若不允许，排队取消改名 `cancelQueue`，同步改 `decide` 的 actionId 判断与 `decideQueue` |
| R3 | 未传变量在 boolean `isTrue` 下的表现 | 可能导致按钮意外显示/隐藏 | 5.3 的两个 `*CardParams` 都补齐全部 boolean；上线前用 dist 端到端验证四种状态的 `canXxx` 取值（与本次 `canCancel`/`canRetry` 的验证方式相同） |
| R4 | 升级首刷 `updateCard` 失败（卡片实例已过期/被删） | 卡片停在旧内容 | 已按 4.3.3 处理：warn + 继续 + 写映射；终态回落文本回复的既有逻辑兜底 |
| R5 | 模板导入发布是人工步骤，容易漏「发布」 | 以为改了没生效 | 沿用 README 已有告警（只保存不发布 → `param.templateUnpublished`）；自检脚本 + 部署后在钉钉侧实测 |
| R6 | 第二步删列后若未填新模板 ID，卡片退化为文本 | 用户看不到卡片 | 部署清单把「后台填模板 ID」列为上线前置步骤；`templateOf` 返回 null 时已有文本进度降级路径，任务不失败 |

## 8. 测试计划

单元测试（Vitest，`backend-ts/src/dingtalk/`）：

1. `card-body.spec.ts`：
   - 第二步新增 `queueCardParams` 的 `body` 拼装（状态行 + 队列位次 + 摘要）与 `canRun/canCancel/canRetry` 三值组合；
   - `progressCardParams` 的 `canRun` 恒为 `false`；
   - 固化四态映射（running → canCancel、failed → canRetry、completed/cancelled → 全 false）——沿用 `032b3525` 已加的回归用例。
2. `agent-inbound-handler.spec.ts`：`contextFromQueue` 把 `row.outTrackId` 透传为 `context.progressCardOutTrackId`。
3. `card-action.service.spec.ts`：保持现有 `run`/`cancel`/`retry` 分流用例；第二步若 R2 触发改名，补 `cancelQueue` 用例。
4. `runtime` 侧若可注入 fake fetch，补：升级分支走 `updateCard` 而非 `createAndDeliverCard`，且 `progressRepo.upsert` 被调用。

模板自检：

- `cd skills/mao-cli/template && node check-template.js` 全绿；
- 反向验证：把可见性改回 `isEqual(status,...)` 或删掉 boolean 声明，确认自检报 FAIL。

全量回归：

- `cd backend-ts && npm test > /tmp/x.log 2>&1; echo exit=$?`，再 `grep -E 'Test Files|Tests ' /tmp/x.log`；
- `npm run build`。

端到端（部署后，钉钉侧人工）：

- [ ] 会话忙时连发两条 → 各收一张排队卡；A 完成后 B **在同一张卡上**变为「正在处理」→ 终态，会话中无残留「排队中」卡
- [ ] 排队卡点「取消排队」→ 卡变「已取消」，当前任务不受影响
- [ ] 排队卡点「立即发送」→ 当前任务卡显示「已被下一条指令中断」，目标消息跳队首执行且**同一张卡**变进度态
- [ ] 执行中点「取消任务」→ 同一张卡变「任务已取消」，后续排队消息继续
- [ ] 失败态「重试」→ 同一张卡变「正在重试」
- [ ] `restart-backend` 后：`dingtalk_inbound_queue` 中 QUEUED 行被接力消费，卡片按钮仍可用
- [ ] 第二步：合并模板导入发布后重跑以上全流程，并确认只填一个模板 ID 的 bot 行为正常

## 9. 落地清单

### 第一步

- [ ] `backend-ts/src/dingtalk/types.ts`：`DingtalkInboundContext` 增 `progressCardOutTrackId`
- [ ] `backend-ts/src/dingtalk/agent-inbound-handler.ts`：`contextFromQueue` 透传
- [ ] `backend-ts/src/dingtalk/runtime.ts`：`createProgress` 增加升级分支
- [ ] `backend-ts/src/dingtalk/agent-inbound-handler.spec.ts`：透传用例
- [ ] `CHANGELOG.md` 新增版本小节（`### 后端`）
- [ ] `skills/mao-cli/reference/dingtalk-bot.md`：补充一卡到底说明
- [ ] 全量测试 + build + 部署 + 钉钉侧实测

### 第二步

- [ ] `backend-ts/db/migration/V192__dingtalk_bot_single_card_template.sql`：新增 `card_template_id`，删两个旧列
- [ ] `backend-ts/src/dingtalk/card-body.ts`：`queueCardParams` 改发 `body` + 三 boolean；`progressCardParams` 补 `canRun: 'false'`
- [ ] `backend-ts/src/dingtalk/card-action.service.ts`：`decideQueue` 适配新 `queueCardParams` 签名
- [ ] `backend-ts/src/dingtalk/types.ts`：`DingtalkBot` 两个字段 → `cardTemplateId`
- [ ] `backend-ts/src/dingtalk/bot.repository.ts`：create/update 改单字段
- [ ] `backend-ts/src/dingtalk/admin.routes.ts`：请求体与赋值改单字段
- [ ] `backend-ts/src/config/app-config.ts`：`DingtalkRuntimeConfig.cardTemplateId` + `DINGTALK_CARD_TEMPLATE_ID`
- [ ] `backend-ts/src/app-feishu-handler.ts`：装配透传改单字段
- [ ] `backend-ts/src/dingtalk/runtime.ts`：`templateOf(bot)` 去掉 `kind`
- [ ] `admin/src/views/dingtalk-bot/DingtalkBotListView.vue`：两个输入框合并为一个
- [ ] `skills/mao-cli/template/dingtalk-card.json`（由 `dingtalk-progress-card.json` 重命名）：三按钮 + 三 boolean + `body` 合一（改 `editorData` 必须用函数形式 replace，避免 `$$key` 被吞）
- [ ] `skills/mao-cli/template/check-template.js`：`file` 常量指向新文件名；`ACTION_STATUS`/`ACTION_VISIBLE`/`REQUIRED_VARS` 扩展
- [ ] `skills/mao-cli/template/README.md`：更新契约表与踩坑记录
- [ ] `backend-ts/src/dingtalk/card-body.spec.ts`：新契约回归
- [ ] 自检 + 反向验证 + 全量测试 + build + `admin` 侧 `npm run build`
- [ ] **人工**：卡片平台导入 → 保存 → **发布** → 后台填模板 ID
- [ ] `CHANGELOG.md` + `skills/mao-cli/reference/{dingtalk-bot,config,admin}.md` 同步
- [ ] `backend-ts/src/dingtalk/runtime.ts` 的 `pushScheduledResult`（:497）与 `backend-ts/src/dingtalk/scheduled-result.ts`（`progressCardParams` 消费方）：templateOf 签名/参数收敛同步（评审补充）
- [ ] 部署 + 钉钉侧全流程实测

## 10. 参考资料

- 飞书一卡到底范本：`backend-ts/src/feishu-cards.ts:189-195`（`existingMessageId` PATCH 分支）
- 飞书入站队列设计：`docs/plan/2026-08-28-feishu-inbound-queue-technical-design.md`（决策 5「一卡到底」）
- 钉钉卡片更新语义（增量/全量）：钉钉开放平台「卡片更新」[^1^][^2^]
- 本次已修复的按钮可见性约束：`skills/mao-cli/template/README.md`

## 11. 评审修订记录（2026-11-12）

1. **定时结果卡链路纳入第二步影响面（重要）**：本方案写作后，同批代码新增了 `dingtalk/scheduled-result.ts`（定时任务结果卡）与 `runtime.ts` 的 `pushScheduledResult`（:488-497）——后者调用 `templateOf(cred.bot, 'progress')`，是 §5.6 调用点清单遗漏的一处；`deliverScheduledDingtalkReply` 消费 `progressCardParams`（`canRun:'false'` 增补自动覆盖，语义正确：定时结果卡不显示插队按钮；其「不写进度卡映射」行为与第一步升级分支无冲突）。§3 索引、§3.1、§5.6、§9 落地清单已补。
2. **行号全面更新**：templateOf :151→:154、cardProgress :190→:192、createProgress :208→:211、createQueueCard :305→:308、noteReplyFailure :357→:363、recoverProgress :513→:551、enqueueMessage :411→:413（contextFromQueue :699 / executeQueued :505 / dropQueued :609 / card-action.service :37-48 复核精确）。
3. **§3.1 引用点表述修正**：仓库内引用为 camelCase 字段，snake_case 列名仅存在于 V120 DDL——防止实现者拿 snake_case 全仓搜索扑空。
4. **§5.2 两条声明标注「已实证」**：`dingtalk-progress-card.json` 无 `sessionUrl`/`title` 绑定（node 实证），合并时不声明的口径成立。
5. **平台侧孤儿模板说明**：仓库 template 目录只有 progress 模板 JSON（无 queue 模板 JSON，实证）——排队模板只存在于钉钉平台侧，合并后成为孤儿实例，可手动删除（可选，不阻塞）。§5.6。
6. **升级分支语义复核确认**：升级不检查模板 ID 的附带好处成立——只配 queue 模板 ID 的 bot 升级后每轮 `updateCard` 同样无需模板 ID（`updateCard` 按 outTrackId 定位，实证 `card-client.ts` 签名）；`progressRepo.upsert` 行含 chatType/conversationId，§4.3.3 片段的字段在 context 作用域内可得（`types.ts:52` DingtalkInboundContext extends NormalizedMessage，chatType/conversationId 实证存在）。
7. **V192 迁移编号确认**：当前迁移最大版本 V191（实证 db/migration 目录），V192 编号正确；V120 列名与 `AFTER model_id` 锚点实证存在。
8. **实现轮 review 修正（2026-11-12，落地轮）**：①§2.3「路由逻辑不用改」的结论有一处 RUNNING 窗口遗漏——升级卡执行期间共用队列行 outTrackId，而行要到执行结束才删除，`decide()` 对 cancel 回调「队列行命中即 return」会让执行中的「取消任务」被 `decideQueue` 的 ALREADY_STARTED 挡掉、永远失败；已修：队列分支加 `row.status === 'QUEUED'` 闸门，RUNNING 行落到 `findProgress` 进度分支（升级卡必有映射），并补回归用例；②`decideProgress` 对非 retry 回调原本一律落入取消分支，加显式 `actionId === 'cancel'` 守卫（闸门放行后 RUNNING 行的陈旧 run 回调不得误取消）；③`enqueue` 返回 `{ id, rankNo }` 并接线到 `createQueueCard`，排队态 body 的「当前排在第 N 位」行从不可达变为可达（dedupe 路径 rankNo 取原行）；§5.4 的位次承诺兑现。
