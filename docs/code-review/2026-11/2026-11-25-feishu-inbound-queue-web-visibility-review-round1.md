# 飞书入站排队 Web 可见性（一期）代码审查 · round1

- 日期：2026-11-25
- 审查范围：`mao/` 工作区未提交改动（审查时快照：22 个已跟踪文件修改 + 8 个新增，含方案文档与 changelog；功能代码集中于 `backend-ts/src/feishu/*`、`backend-ts/src/session/session.routes.ts`、`backend-ts/src/session/ws/*`、`backend-ts/src/app-feishu-handler.ts`、`backend-ts/src/create-app.ts`、`desktop/src/components/chat/QueuePanel.vue`、`desktop/src/composables/*`、`desktop/src/stores/session/messages.ts`、`desktop/src/utils/queue-view.ts`）
- 需求基线：`docs/plan/2026-11/2026-11-25-feishu-inbound-queue-web-visibility-technical-design.md`
- 审查方式：只读代码走查 + 对 4 个新增/改动 spec 实跑（`inbound-queue-view.spec.ts` / `inbound-queue.service.spec.ts` / `session.routes.inbound-queue.spec.ts` / `feishu-cards.queue.spec.ts`，45 例全绿）+ 用 `tsx` 直接调用新增纯函数做输入输出实证（见各条「验证」）。**未改任何产品代码**，仅新增本报告。
- 结论：**可合并，无阻塞项**（P0 = 0，P1 = 0）。发现 4 项 P2（展示口径 / 状态复位类），均不影响排队、取消、接力的主流程与数据一致性。

## 1. 问题清单

| # | 级别 | 位置 | 一句话 |
|---|---|---|---|
| R1-P2-1 | P2 | `backend-ts/src/feishu/inbound-queue-view.ts:84` | `fileCount` 统计的是 `context.text`（原始正文），而 `@{path}@` 引用实际由 `composeContent` 拼进 `message`，导致面板的「[N 个文件]」永不显示 |
| R1-P2-2 | P2 | `desktop/src/components/chat/QueuePanel.vue:5,21,88-100` | 折叠只作用于本地组：本地为空且飞书 > 5 条时「展开/收起」是无效果按钮；飞书项永不折叠；折叠文案把页面上已显示的飞书项也算进「还有 N 条」 |
| R1-P2-3 | P2 | `desktop/src/stores/session/messages.ts:1043-1066,1068-1093` | 新增的 `sessionInboundQueue` / `sessionLastRunFailed` / `sessionRunningChannel` 未纳入 `purgeSessionRuntime()` 与 `reset()`，删除会话 / 登出后残留 |
| R1-P2-4 | P2 | `backend-ts/src/feishu/inbound-queue-view.ts:15-18,110-127` | 存量行（`summary IS NULL`）与空摘要回退解析四处口径问题：p2p 引用把「引用内容」当摘要、p2p 正文首行「xxx：」被误剥、`ContentPart[]` 分支漏剥段标记、可解析但空正文被标成「无法解析的排队消息」 |

> 修复建议的优先级：R1-P2-1、R1-P2-2 建议本期顺手修（各自约 5–10 行）；R1-P2-3、R1-P2-4 可放下期（影响面小、且 R1-P2-4 随存量行被消费会自然衰减）。

---

## 2. 详情

### R1-P2-1（P2）飞书排队项的「[N 个文件]」永不显示

**文件与位置**：`backend-ts/src/feishu/inbound-queue-view.ts:73-86`（关键行 `:84` `fileCount: countFileRefs(body)`；`body` 在 `:77` 取自 `context.text`）

**问题**：`buildQueueViewColumns(context, message)` 里 `summary` / `fileCount` 都基于 `body = context.text`（原始正文）。但文件附件引用是在 `AgentFeishuInboundHandler.composeContent()`（`agent-inbound-handler.ts:1245-1248`）里把 `@{path}@` 追加到**构建后的 message**，`context.text` 本身不含引用（`event-normalizer` 只写入 `content.text` 与 mentions 还原后的文本，见 `event-normalizer.ts:105` `extractText`）。设计 §4.1.1 明确要求「`fileCount`：正文里 `@{...}@` 引用数（…以引用形式拼进正文，来源 `composeContent`）」，实现读错了入参。

**影响**：会话忙时以「富文本正文 + 文件」入队的消息（`isInboundAttachmentOnly()` 对 `post` 且正文非空返回 false，会走排队路径，见 `event-normalizer.ts:221-231`），面板上永远不出现 `[1 个文件]` 标记；用户以为附件没带上。`summary` 与 `imageCount` 不受影响（图片计数取自 `message` 的 `image_url` part，正确）。反证：存量行回退分支 `parseQueuePayloadSummary()` 统计的是 payload 里的 `message`（含引用），口径与新行相反，属实现不一致而非设计取舍。

**验证**（实跑 `tsx` 调用真实函数，模拟 `buildMessage` 产物）：

```
summary   = "看下这个文件"
imageCnt  = 0
fileCount = 0 (期望 1)      # message = '【用户消息】\n杨佳毅：看下这个文件\n@{/workspace/sess/a.pdf}@'
```

**修复建议**：把计数源换成构建后的消息（摘要仍用 `context.text`）：

```ts
const fileBody = typeof message === 'string' ? message : fromParts.text;
...
fileCount: countFileRefs(fileBody),
```

并在 `inbound-queue-view.spec.ts` 补一条「`context.text` 不含引用、`message` 含 1 处引用 → `fileCount === 1`」的用例（现有 `counts file references in the body` 用例把引用写在 `context.text` 里，掩盖了该缺陷）。

---

### R1-P2-2（P2）折叠/展开只覆盖本地组：飞书项永不折叠，本地为空时按钮失效

**文件与位置**：`desktop/src/components/chat/QueuePanel.vue:5`（`v-if="visibleCount > 5"` 的切换按钮）、`:21`（本地列表 `v-if="expanded || visibleCount <= 5"`）、`:88-100`（折叠行）、`:99`（`还有 {{ visibleCount - 1 }} 条`）

**问题**：折叠分支位于 `<template v-if="localCount > 0">` 内，飞书组（`:103` 起）没有任何折叠条件。因此：

1. `localCount === 0 && inboundCount > 5`（群聊连发多条飞书消息的典型场景）时，标题右侧出现「展开」按钮，点击只翻转 `expanded`，界面无任何变化——死按钮；同时飞书列表会全量铺开（`.queue-list` 无 max-height/滚动），条数多时把消息区/输入区持续压缩。
2. `localCount > 0 && visibleCount > 5` 时，本地组折叠成一行并显示「还有 N 条」，但 N = `visibleCount - 1` 把**下方正在显示**的飞书项也算了进去（例如本地 1 + 飞书 6 → 「还有 6 条」，而那 6 条就在下面）。

设计 §4.2.4 规则 6 要求「折叠行取『本地首条，否则飞书首条』」，`desktop/src/utils/queue-view.ts:90` 的 `queueGroupsCollapsedText()`（`本地 2 条 · 飞书 1 条`）也实现了并有单测，但**组件没有引用它**（全仓仅 `queue-view.test.ts` 使用），说明折叠态实现与方案不一致。

**影响**：仅展示层，不影响取消/排队数据。但「点了没反应」的按钮和失控的面板高度是可感知缺陷；本地队列为空时的折叠行为是方案手工验收项之一（「本地队列为空时折叠态正常显示（不白屏）」——当前不白屏，但也无法折叠）。

**修复建议**：把折叠状态按组拆开（或对飞书组复用同一 `expanded` 阈值），折叠行按「本地首条 → 否则飞书首条」取值，文案改用 `queueGroupsCollapsedText(localCount, inboundCount)`；飞书组折叠时用首条摘要 + `飞书 N 条`。

---

### R1-P2-3（P2）新增的三个 Map 未纳入会话清理 / 全局 reset

**文件与位置**：`desktop/src/stores/session/messages.ts:1043-1066`（`purgeSessionRuntime`）、`:1068-1093`（`reset`）

**问题**：本次新增 `sessionInboundQueue`（`:86`）、`sessionLastRunFailed`（`:88`）、`sessionRunningChannel`（`:90`），但 `purgeSessionRuntime(sid)` 只清了 `sessionQueueMessages` 等既有 key，`reset()`（登出路径 `stores/auth.ts:75` 调用）也没有重建这三个 Map；`useChat.ts:962` 的 `newSession()` 同样只清本地队列缓存。

**影响**：删除会话 / 登出后这三个 Map 里的条目常驻内存（会话 id 全局唯一，不会跨用户串数据），属状态复位遗漏与内存滞留；若后续有「同 id 会话重建」或会话详情复用逻辑，会看到过期队列快照。不阻断功能。

**修复建议**：`purgeSessionRuntime` 补三行 `delete`，`reset()` 补三个 `new Map()`；`newSession()` 视需要一并清 `sessionInboundQueue`（保持与实际拉取时机一致，避免旧会话快照被复用）。

---

### R1-P2-4（P2）存量行 / 空摘要的 payload 回退解析口径不一致

**文件与位置**：`backend-ts/src/feishu/inbound-queue-view.ts:15-18`（`PROMPT_SECTION_MARKERS` / `SENDER_PREFIX_LINE`）、`:110-118`（string 分支）、`:119-123`（`ContentPart[]` 分支）、`:125-127`（空正文 → 占位）

**问题与验证**（实跑真实函数，输入为 `composePromptText` / `composeContent` 的真实产物形态）：

```
p2p:       message = '结论：可以上线'                          → 摘要 '可以上线'（期望 '结论：可以上线'）
p2p+引用:  message = '【引用的消息】\n昨天那段需求描述\n\n我的看法：先别上线'
                                                              → 摘要 '昨天那段需求描述 我的看法：先别上线'（期望 '我的看法：先别上线'）
parts:     message = [{text:'【用户消息】\n杨佳毅：看图'},{image_url}]  → 摘要 '【用户消息】 杨佳毅：看图'（期望 '看图'）
空正文:    message = '【用户消息】\n杨佳毅：'                    → 摘要 '[无法解析的排队消息]'（payload 合法）
```

四处成因：
1. `SENDER_PREFIX_LINE`（`/^[^\n：]*：/`）无条件剥首个全角冒号前缀；`composePromptText` 的 p2p 分支（`agent-inbound-handler.ts:153-155`）**不加**发送者前缀，于是用户自己写的「结论：…」被吃掉。
2. `PROMPT_SECTION_MARKERS` 用「最后一个段标记之后」定位正文，但 p2p 只有「【引用的消息】」段、没有「【用户消息】」段，切片点落在引用段之后 → 摘要主体变成被引用内容。
3. `ContentPart[]` 分支只拼 `text` part，未复用 string 分支的段标记剥离 → 存量带图行摘要泄漏 `【用户消息】 发送者：`。
4. 正文为空（表情/无文本入队、或新行 `summary` 列为 NULL）时统一落 `[无法解析的排队消息]`，把「合法但空」误报成「脏数据」。

**影响**：只影响 V210 之前入队的存量行（部署后随消费自然消失）与「摘要列为 NULL 的新行」（罕见输入）。属文案/摘要误导，不影响顺序、权限与取消。

**修复建议**：
- 前置 `chatType === 'group'` 判断：只有群聊才做「段标记切片 + 发送者前缀剥离」；p2p 原文直接作为摘要（或仅在有「【引用的消息】」段时取其后最后一个 `\n\n` 之后的正文）。
- 把「剥段标记 + 剥发送者前缀」抽成小函数，string 分支与 `ContentPart[]` 分支共用。
- 入队侧保证 `summary` 非空占位（空正文且无图时写 `[空消息]`／有文件写 `[文件]`），或在 `resolveItem` 里区分「新行空摘要」与「存量行」再做回退，避免合法空正文被标成「无法解析」。

---

## 3. 已核实无问题（按审查清单逐项）

1. **`inbound-queue-view.ts` 主路径**：摘要列优先、payload 回退（群聊 string 分支保留全部剩余段落）、`cancelable = maoUserId == null || === viewer`、`lastRunFailed = phase === 'FAILED'`、`cancel()` 的「行不存在 / 非本会话 → NOT_FOUND」「他人发送 → FORBIDDEN」「`cardMessageId` 为空跳过 PATCH」「PATCH 失败仅 warn 且仍返回 CANCELLED」「cancel 输竞态不 PATCH」均与方案一致；`senderLabel` 仅群聊有值（p2p 空串）与卡片同口径。
2. **`onChanged` 钩子**：`enqueue`（含幂等冲突回退分支）/ `claimNext` / `complete` / `cancel` / `jumpToFront` 全部触发，`notify()` 内部 try/catch 不阻塞主流程；`complete(id, sessionId?)` 的回退 `findById` 在 `deleteById` **之前**执行，删行后取不到 sessionId 的问题不存在；唯一调用点 `agent-inbound-handler.ts:979` 透传了正确的 `sessionId`。
3. **仓储**：`listQueuedBySession` 显式列不含 `payload`、只取 `QUEUED`、`ORDER BY rank_no, id`；`db.query` 走 `toCamelList`（`common/case.ts`），列名与 `FeishuInboundQueueListItem` 一一对应；`jumpToFront` 返回值改为 `{ok, sessionId}` 后，外部消费方只有 `FeishuTaskQueueService`（仍对外返回 `boolean`，`card-action.service.ts:391` 契约不变），`insert()` 新增 4 列经 `toSnakeRow` 正确映射到 `summary/sender_label/image_count/file_count`。
4. **装配**：`queueChangeHooks` 先构造后赋 `onChanged`（对象属性晚绑定，`notify` 每次调用时读取，生效）；`feishuInboundQueueView` 在 `feishuInboundHandler`（:160）之后构造（:478），resolver 闭包无 TDZ 风险；通知 100ms debounce + `unref`，异常不外抛；`patchQueueCard` 与原 `cardActionService.patchCard` 实现逐行等价（仅搬到装配层共用）；`countLocalQueue` 未装配时降级为不显示附加文案。
5. **路由**：`GET /v1/sessions/:id/inbound-queue`、`DELETE .../:queueId` 均 `requireUserId` + `requireSessionOwner`；`DELETE` 统一 HTTP 200 + `result`（`handleError` 对 1001/1002 才 401/403，符合方案）；`pathId(request,'queueId')` 校验正整数；`RouteDeps` / `SessionRouteDeps` / `create-app` 传递完整（`feishuInboundQueueView` 缺省时 GET 返回空列表、DELETE 返回 NOT_FOUND），`wsHandler.setRunningChannelResolver` 在 `assembleFeishuHandler` 之后晚绑定。
6. **WS**：`sendQueueUpdated` 新增 `runningChannel` 为**新增字段**，既有 `queue_updated` 消费方（前端只读 `data.queue`）不受影响；`inbound_queue_updated` 已登记 `CRITICAL_EVENT_TYPES`；`registry.send(userId, …)` 按用户广播全部连接（`deliver` 对 `target: 'ALL'` 不过滤订阅），面板能收到事件。
7. **前端**：`messages.ts` 新状态/方法已随 `messageRuntime` 展开进 store；`fetchSessionQueue` 与 `refreshQueue` 双请求各自 `.catch(() => null)`（本地队列为空返回 `[]` 仍为 truthy，不会被误跳过）；`inbound_queue_updated` 分支与 `queue_updated` 的 `runningChannel` 同步均正确；终态与 RUNNING 兜底刷新落在 `session_status` 既有分支内；`cancelInboundQueueMessage` 的 `CANCELLED/ALREADY_STARTED/NOT_FOUND` 分支与「403 由拦截器统一提示、不重复 toast」一致；`QueuePanel` 的折叠分支被 `v-if="localCount > 0"` 包住，**本地队列为空时不会索引 `queueView[0]`，无崩溃**；拖拽只在本地 `VueDraggable` 内，飞书项不参与，下标不会被污染；`cancelingInboundId` 有「列表变化即复位 + 8s 兜底」双保险。
8. **迁移与类型**：`V210` 4 列与查询列一致；`INT NOT NULL DEFAULT 0` 对存量行安全；`dayjs`/`dateStrings` 下 `created_at` 映射为 `createdAt` 字符串；`FeishuInboundQueueListItem = Omit<Row,'payload'|'updatedAt'>` 未污染 `claimNext` / `reconstructFromQueue` 的 `SELECT *` 路径。
9. **既有测试**：新增/改动 4 个 spec 实跑 45 例全绿；未发现既有行为被改坏（卡片文案改动有 `feishu-cards.queue.spec.ts` 覆盖；`complete` 签名变更有 `agent-inbound-handler.spec.ts:1252` 同步）。

## 4. 与方案的设计偏差（非 bug，记录备查）

1. `inbound-queue.service.ts:132-145` `hydrate()` 未触发 `onChanged`（方案 §4.1.5 表格列入），但启动窗口客户端尚未连接、收敛依赖前端重连/进入会话拉取，实际无可观察影响。
2. 飞书卡片「另有 M 条本地排队消息**将在其后执行**」在「当前执行来自 Web/本地」时顺序表述可能相反（本地队列先于飞书队列被消费）。这是方案 §4.2.5 指定的固定文案，非实现偏差，仅提示后续可考虑中性措辞（如「另有 M 条本地排队消息」）。

## 5. 残余风险 / 未覆盖

- 未做端到端联调：飞书卡片 PATCH 的真实回执、蓝绿切换窗口的丢帧收敛、多端并发取消只做了静态核对 + 单测，未经真实飞书环境验证。
- 未跑前端全量 vitest（按委托方说明已跑过，仅 `src/utils/approvalFlashPreference.test.ts` 在干净 HEAD 上也失败，属环境问题）。
- 本次只读审查，未执行修复；上述 4 项 P2 的修复请交由后续 worker 实施并按建议补回归用例。
