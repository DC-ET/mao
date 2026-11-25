# Web 端可见飞书入站排队队列技术方案

- 状态：评审中（2026-11-25 四项决策已确认，见 §8；待代码实现评审）
- 日期：2026-11-25
- 一句话：把 `feishu_inbound_queue` 里本会话的 QUEUED 行并入 web/桌面端 QueuePanel——可见、可取消（同步 PATCH 飞书卡片）、并标注两组队列的接力顺序与失败滞留状态。
- 关联方案：
  - [2026-08-28-feishu-inbound-queue-technical-design.md](../2026-08/2026-08-28-feishu-inbound-queue-technical-design.md)（飞书入站队列本体；其 §2.2「不做桌面/Web 端消息队列」正是本文要补的边界）
- 关联代码（撰写时已在当前 `main` 核实；行号以撰写时为准）：
  - 飞书队列表：`backend-ts/db/migration/V088__feishu_inbound_queue.sql`
  - 队列仓储 / 服务：`backend-ts/src/feishu/inbound-queue.repository.ts`、`inbound-queue.service.ts`
  - 入队 / 消费：`backend-ts/src/feishu/agent-inbound-handler.ts`（`enqueueMessage`、`drainNext`、`executeQueued`、`runExecution`）
  - 队列端口与行类型：`backend-ts/src/feishu/types.ts`（`FeishuInboundQueueRow`、`FeishuTaskQueuePort`、`FeishuQueueStoredContext`）
  - 飞书卡片动作：`backend-ts/src/feishu/card-action.service.ts`（`handleRun` / `handleCancel`）
  - 平台队列：`backend-ts/src/session/message-queue.repository.ts`、`message-queue.service.ts`
  - 队列 REST：`backend-ts/src/session/session.routes.ts:769`（`GET /v1/sessions/:id/queue`）、`backend-ts/src/session/session-vo.ts:669`（`toQueueMessageVO`）
  - 队列 WS 事件：`backend-ts/src/session/ws/streaming-ws-handler.ts:2449`（`sendQueueUpdated`）、`backend-ts/src/session/ws/streaming-ws-registry.ts:96`（`CRITICAL_EVENT_TYPES`）
  - 跨通道接力：`backend-ts/src/app-utils.ts:288`（`createPlatformQueueRelay`）、`backend-ts/src/create-app.ts`（`platformQueueRelay` / `registerImQueueDrainHandler` 接线）
  - 前端面板：`desktop/src/components/chat/QueuePanel.vue`、`desktop/src/composables/useChatQueue.ts`、`desktop/src/composables/chatSessionActions.ts:7`（`fetchSessionQueue`）
  - 前端事件与状态：`desktop/src/composables/useStreamWS.ts:1584`（`queue_updated`）、`desktop/src/stores/session/messages.ts:850`（`setQueueMessages`）、`desktop/src/types/chat.ts:168`（`QueueMessage`）

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 飞书队列 | `feishu_inbound_queue`，飞书通道在会话繁忙时把入站消息排进去；状态 `QUEUED → RUNNING →` 行删除 |
| 本地队列 / 平台队列 | `message_queue`，web/桌面端在执行中发送、定时任务、Webhook、开放 API 写入 |
| 接力 | 一侧队列排空且会话空闲后，自动去消费另一侧队列（两侧互斥由忙检查保证） |
| 下一组 | 当前执行收尾后，最先被消费的那一组队列 |
| 排队项 | 面板里的一条待执行消息（本地项 = `message_queue` 行，飞书项 = `feishu_inbound_queue` 行） |

## 1. 现状与问题

### 1.1 两套队列，两套生命周期

| 维度 | 飞书队列 | 本地队列 |
|---|---|---|
| 表 | `feishu_inbound_queue` | `message_queue` |
| 写入时机 | 飞书消息到达且会话忙（含 WS 侧在跑） | web 端 `enqueue_message`、定时任务/Webhook/API busy 入队 |
| 排序 | `rank_no`（FIFO；插队取 `min-1`） | `sort_order`（FIFO；支持拖拽重排） |
| 用户可见入口 | 飞书排队交互卡片（「立即发送 / 取消本次任务」） | web QueuePanel（编辑 / 立即发送 / 删除 / 拖拽） |
| 消费入口 | `AgentFeishuInboundHandler.drainNext()` | `StreamingWsHandler.autoConsumeQueue()` |
| 收尾接力 | 飞书队列空 → `onQueuesDrained` → `autoConsumeQueue(..., { relayToIm: false })` | 本地队列空 → `relayToImQueues()` → `drainNextIfPending()` |

两侧都做了跨通道忙检查（`hasRunningSession` / `isSessionExecuting` / `registerExternalBusyCheck`），保证同一会话不会双跑。

### 1.2 web 端为什么看不到飞书排队项

1. 入队路径 `agent-inbound-handler.ts` 的 `enqueueMessage()` 只做两件事：`queueService.enqueue()` + 发飞书排队卡片。**不调 `saveUserMessage`、不发任何 WS 事件** → 会话 `message` 表里没有这条消息。
2. 只有排队项被 `drainNext()` 认领、进入 `runExecution()` 时才 `saveUserMessage()` + `echoUserMessageSaved()`（WS `user_message_saved`）+ `broadcastRunning()`，此刻 web 消息流才出现该消息。
3. web 端队列面板只读 `message_queue`：`GET /v1/sessions/:id/queue` → `messageQueueService.listPending()`，前端 `setQueueMessages()` 灌入，`QueuePanel.vue` 渲染。飞书队列完全不在这条链路上。
4. 飞书卡片上的「第 N 位」由 `createQueuePositionHelper`（`feishuInboundQueueRepo.countPending`）计算，**只统计飞书队列**，web 端也拿不到。

### 1.3 由此产生的三个可感知问题

1. **队列不可见**：用户发出飞书消息后，只在飞书收到一张排队卡；切到 web 页面看不到任何排队痕迹，只能靠回忆判断「我是不是发过去了」。
2. **顺序不可知**：web 端即使能看到自己发的本地排队项，也看不出前面还有几条飞书排队；本地面板显示的「第 1 位」可能实际是全局第 3 条。
3. **异常不可见**：飞书侧执行 `FAILED` 后 `drainNext` 不再接力、也不会 `relayPlatformQueues`，本地排队项会滞留；此时 web 端只看到「排队中」，看不出是「前面还有飞书队列」还是「卡住了」。

### 1.4 线上证据（2026-11-25 会话 3105）

| 时间 | 事件 | 库内状态 |
|---|---|---|
| 14:07:49 | 飞书「发布生产环境」入队 | `feishu_inbound_queue` id=798 QUEUED |
| 14:08:02 | 飞书「压测链路需求调研」入队 | id=799 QUEUED rank=2 |
| 14:10:02 | 798 被认领 | 798 RUNNING；`message` 表写入「发布生产环境」，metadata `{"feishuQueueId":798}` |
| 14:14:41 | 799 被认领 | 799 RUNNING；`message` 表写入对应内容 |
| 14:17:4x | 799 完成 | 队列行删除，两队列为空 |

期间 web 页面在 14:07–14:10 完全看不到「发布生产环境」这条（如图），14:10 之后才随落库出现在消息流——正是 §1.2 描述的行为。

## 2. 目标与非目标

### 2.1 目标

1. web/桌面端 QueuePanel 能看到本会话的飞书入站排队项：发送者、内容摘要、入队时间、飞书队列内位次。
2. 面板能表达两组队列的接力顺序（哪一组是「下一组」），不发明与后端不一致的全局顺序。
3. 飞书排队项变化（入队 / 被认领 / 取消 / 插队 / 执行完成）能在 web 端实时反映，断连或蓝绿切换后能自愈收敛。
4. **一期即支持 web 端「取消排队」**：仅会话 owner，且仅限本人发送的项（发送者未绑定 mao 账号时 `maoUserId` 为 null，按 owner 放行，见 §8 决策 2）；取消成功后**同步 PATCH 飞书排队卡片为「已取消」终态**。
5. 失败滞留可感知：会话上一轮执行 `FAILED` 且仍有排队项时，面板展示明确提示（不静默卡住）。
6. 不影响现有任何一条消费/接力语义，不改 `feishu_inbound_queue` 与 `message_queue` 的写入方。

### 2.2 非目标（明确不做）

| 不做项 | 理由 |
|---|---|
| 往 `message` 表插「排队占位」消息 | 会污染 Agent 上下文与消息流，且与编辑/删除语义冲突 |
| 把飞书队列行复制进 `message_queue` | 破坏飞书队列的卡片、rank、幂等键与 `hydrate` 语义，两套状态机会立刻打架 |
| web 端拖拽调整飞书队列顺序 | 排序由 `rank_no` 与飞书卡片「立即发送」决定，跨端双写极易冲突 |
| web 端「立即发送」飞书项（跨通道打断） | 会中断当前执行，风险与收益不匹配；飞书卡片已有该能力，本期不做 |
| web 端「一键继续消费队列」 | 现有「失败卡重试 / 再发一条消息」已能恢复；新增跨通道触发入口需要独立的并发与权限论证 |
| 展示 `RUNNING` 状态的飞书行 | 执行中的消息已落库并出现在消息流 + 飞书进度卡，重复展示没有增量信息 |
| 改两套队列的消费与接力语义 | 只增加一个受控取消入口，不动 `drainNext` / `autoConsumeQueue` 的行为 |
| admin 端新增队列页面 | 沿用「admin 不新增页面」的既有决策 |

## 3. 方案选型

| 候选 | 做法 | 结论 |
|---|---|---|
| A. 统一队列 | 飞书入站直接写 `message_queue`，删掉 `feishu_inbound_queue` | ✗ 推翻 2026-08 方案：卡片 PATCH、`rank_no`、`(bot_id,message_id)` 幂等、`hydrate` 恢复全部要重做，且飞书卡片生命周期与 message_queue 的「可编辑/可拖拽」语义冲突 |
| B. 消息流占位 | 入队时写一条 SYSTEM 占位消息，执行时替换 | ✗ 污染上下文与消息流，需要消息类型迁移与历史清理，失败路径留下脏数据 |
| C. 双队列并读 + 面板分组（推荐） | 新增查询/取消接口 + 新增 WS 事件，前端 QueuePanel 分组渲染 | ✓ 零回归：不动写入方与消费语义，改动集中在「读侧 + 展示侧 + 单个受控写操作」 |

**选 C**。核心原则：**飞书队列的事实只有一份（`feishu_inbound_queue`），web 端只是它的一个视图 + 受控取消入口，不复制状态。**

## 4. 详细设计

### 4.1 后端

#### 4.1.1 存储与仓储：轻量摘要列 + 只读查询

**问题**：`payload` 是 MEDIUMTEXT 且含 data URI 图片（单行可达 MB 级）。若列表查询 `SELECT *` 再逐行 `JSON.parse`，3 条各带一张大图的排队项就会在每次推送时解析数 MB JSON，成本由**单行体积**决定、而非队列长度。

**方案**：新增迁移 `V210__feishu_inbound_queue_view_columns.sql`，把面板要用的展示字段在**入队时**落成轻量列：

```sql
ALTER TABLE feishu_inbound_queue
  ADD COLUMN summary      VARCHAR(255) NULL COMMENT '入队时截断的正文摘要（面板展示用）',
  ADD COLUMN sender_label VARCHAR(64)  NULL COMMENT '发送者展示名',
  ADD COLUMN image_count  INT NOT NULL DEFAULT 0 COMMENT '图片数',
  ADD COLUMN file_count   INT NOT NULL DEFAULT 0 COMMENT '文件引用数';
```

- 入队写入：`buildQueuePayload()` 旁边新增 `buildQueueViewColumns(context, message)`，与 payload 同一次 `INSERT` 落库（`FeishuTaskQueuePort.enqueue` 参数扩展 4 个字段，`FeishuInboundQueueRepository.insert()` 同步补列）。
- **列表项单独定义类型**：新增 `FeishuInboundQueueListItem`（与 `FeishuInboundQueueRow` 同字段但 `payload` 可选/不含），避免把 `payload` 改成可选后污染 `claimNext` / `reconstructFromQueue` 等认领路径（它们仍靠 `SELECT *` 取完整行）。
- 存量行（`summary IS NULL`）：查询到后按 id 单查 `payload`（`findById`）**一次性回填 4 个展示字段**（`summary/senderLabel/imageCount/fileCount` 一起回退计算，否则带图老行会显示 0 张图），量少且只发生在老数据上；新行**永远不读 MEDIUMTEXT**。
- `listQueuedBySession(sessionId)` 显式列、不带 payload：

```sql
SELECT id, bot_id, session_id, message_id, card_message_id, sender_open_id, mao_user_id,
       rank_no, status, summary, sender_label, image_count, file_count, created_at
FROM feishu_inbound_queue
WHERE session_id = ? AND status = 'QUEUED'
ORDER BY rank_no ASC, id ASC
```

走现有 `idx_session_status_rank`，无需新索引。**取消权限不需要新增 `sender_union_id` 列**：`mao_user_id` 存的就是发送者的 mao 用户 id（`resolveUserId` 按发送者 `unionId` 解析，未绑定才为 `null`），见 §4.1.7。

#### 4.1.2 视图服务：把行转成面板项

新增 `backend-ts/src/feishu/inbound-queue-view.ts`（纯函数 + 轻量服务，便于单测）：

```ts
export interface FeishuInboundQueueItemVO {
  id: string;            // 行 id（字符串，与前端已有 id 归一化口径一致）
  senderLabel: string;   // sender_label，缺省「飞书用户」
  summary: string;       // 正文摘要，≤60 字
  imageCount: number;
  fileCount: number;
  createdAt: string | null;
  queuePosition: number; // 飞书队列内位次，1 起（按 rank 排序后的序号，不直接暴露 rank_no）
  cancelable: boolean;   // 当前查看者能否取消（判定见 4.1.7）
}

export function toInboundQueueItemVO(
  row: FeishuInboundQueueListItem, position: number, cancelable: boolean,
): FeishuInboundQueueItemVO
```

**摘要来源**：

1. 优先用列 `row.summary`（入队时已算好）。
2. 列为 `null`（存量行）→ 回退解析 `row.payload`：
   - `message` 为 `string`：命中群聊前缀 `【用户消息】\n{label}：` 时剥掉，**保留全部剩余内容**（不按 `\n\n` 只取最后一段，否则用户自己写的多段落只剩末段），再截断。
   - `message` 为 `ContentPart[]`：拼接 `type === 'text'` 的 `text`，`type === 'image_url'` 的 part 计入 `imageCount`（`FeishuContentPart` 只有这两种形态）；正文为空时用 `[图片]` 占位。
   - 解析失败（脏数据）→ `[无法解析的排队消息]`，不抛错。
3. 截断统一用 `clipByCodePoints`（`backend-ts/src/common/utf8.ts` **已导出**，直接 import，勿再实现一份）。

**入队时的摘要与计数**（`buildQueueViewColumns`）：

- `summary`：取 `context.text`，trim + 折叠连续空白 + 60 字截断；`context.text` 为空且 message 含图片时写 `[图片]`。
- `imageCount`：`message` 为 `ContentPart[]` 时统计 `image_url` 的 part 数。
- `fileCount`：正文里 `@{...}@` 引用数（文件附件在入队时已落盘并以引用形式拼进正文，来源 `composeContent`）。
- 与卡片摘要的差异是有意的：卡片走 `buildFeishuQueueCard` 的纯截断（`context.text` 前 60 字），面板额外做 trim/折叠空白。**只承诺「截断长度一致」，不承诺逐字符一致**。

#### 4.1.3 REST：查询与取消接口

`backend-ts/src/session/session.routes.ts` 新增两个路由，**都遵循仓库既有错误约定**（`common/http-error.ts` 的 `BusinessException` 除 401/403/413 外一律返回 HTTP 200 + `code`，不要指望 HTTP 409/404）：

```
GET    /v1/sessions/:id/inbound-queue
DELETE /v1/sessions/:id/inbound-queue/:queueId
```

**GET 返回**：

```json
{
  "code": 0,
  "data": {
    "runningChannel": "feishu",
    "lastRunFailed": false,
    "items": [
      {
        "id": "799",
        "senderLabel": "杨佳毅",
        "summary": "现在有一个需求需要调研评估一下…",
        "imageCount": 0,
        "fileCount": 0,
        "createdAt": "2026-11-25 14:08:02",
        "queuePosition": 1,
        "cancelable": true
      }
    ]
  }
}
```

- 鉴权：`requireUserId` + `requireSessionOwner`（与 `/queue` 完全一致；非 owner 走既有 403 通道）。
- `runningChannel`：当前会话执行来源，取值 `'feishu' | 'local' | null`，供前端决定「下一组」徽标（4.1.6）。
- `lastRunFailed`：布尔，`session.phase === 'FAILED'` 时为 `true`（4.1.8）。
- 视图服务在 `app-feishu-handler.ts` 内构造（该文件持有 `feishuInboundQueueRepo`，避免把 repo 透出到装配层），从 `FeishuHandlerResult` 导出为 `feishuInboundQueueView`，再经 `app-routes.ts` 的 `RouteDeps` / `SessionRouteDeps` 传入 `session.routes.ts`。
- 为什么新开接口而不是扩展 `/queue`：`/queue` 的返回是数组，桌面端与既有单测都按数组消费；新接口零回归，语义也更清晰（`queue` = 本地待发送，`inbound-queue` = 通道入站排队）。

#### 4.1.4 新增 WS 事件 `inbound_queue_updated`

- 事件名：`inbound_queue_updated`（**当前只覆盖飞书**；将来接钉钉/微信时按通道加前缀或复用同一事件扩展字段，不预先改名）。
- `data = { runningChannel, lastRunFailed, items }`，结构与 REST 一致。
- 投递对象：会话 owner（`session.userId`），由 `wsRegistry.send` 广播给该用户所有在线端（`send` 按 userId 投递全部连接，已核实）。
- 登记到 `streaming-ws-registry.ts` 的 `CRITICAL_EVENT_TYPES`：事件量级与 `queue_updated` 相同（人工发消息触发），丢失会让面板停在旧状态且无主动重拉入口，走关键队列更稳。
- 前端 `useStreamWS` 新增分支：`setInboundQueue` + `setRunningChannel` + `setLastRunFailed`。
- **`sendQueueUpdated` 同步补 `runningChannel`**：否则「飞书 → 本地」接力后（`relayPlatformQueues` → `autoConsumeQueue` 只发 `queue_updated`），前端会一直保留上一帧的 `runningChannel`，「下一组」徽标长期错标。两个事件共用同一个 resolver；`wsHandler` 构造早于飞书 handler，需通过 `setRunningChannelResolver()` 晚绑定（见 4.1.6）。

#### 4.1.5 通知接入点（飞书队列变化 → 推送）

在 `FeishuTaskQueueService` 增加可选钩子（构造第二参数，缺省不启用，保持单测可直构）：

```ts
constructor(repo, hooks?: { onChanged?: (sessionId: number) => void })
```

触发点（全部为 `await` 主体成功后 `void this.notify(sessionId)`，不阻塞主流程、异常只记日志）：

| 方法 | 变化 | 面板效果 | sessionId 来源 |
|---|---|---|---|
| `enqueue` | 新增 QUEUED 行 | 出现新项 | 入参 |
| `claimNext` | QUEUED → RUNNING | 项从「排队」消失（同一时刻消息流会出现该消息） | 入参 |
| `complete` | 行删除 | 项消失 | **调用方透传**（`executeQueued` 的 finally 手里有 `row.sessionId`），签名改为 `complete(id, sessionId?)`，不新增查询 |
| `cancel` | 行删除 | 项消失 | 内部已 `findById`，取 `row.sessionId` |
| `jumpToFront` | rank 变化 | 位次变化 | 事务内已读到 `row.sessionId` |
| `hydrate` | 启动复位/清理 | 启动后首次推送（客户端未连上时无副作用；启动窗口的收敛依赖前端重连/进入会话） |

装配（`backend-ts/src/app-feishu-handler.ts`，与 `feishuTaskQueue` 同处构造）：

```ts
const notifyInboundQueueChanged = (sessionId: number) => { /* debounce 100ms 后执行 */ };
const feishuTaskQueue = new FeishuTaskQueueService(feishuInboundQueueRepo, {
  onChanged: notifyInboundQueueChanged,
});
```

`notifyInboundQueueChanged` 的实现：

1. `sessionService.getSession(sessionId)` → 取 `userId` 与 `phase`（后者供 `lastRunFailed`）；会话不存在直接返回。
2. `feishuInboundQueueRepo.listQueuedBySession(sessionId)` → 组装 VO；`cancelable` 用 `session.userId` 作为 viewer（通知只发给 owner）。
3. `resolveRunningChannel(sessionId)`（见 4.1.6）→ `runningChannel`；`lastRunFailed = session.phase === 'FAILED'`。
4. `wsRegistry.send(userId, wsEvent('inbound_queue_updated', sessionId, { runningChannel, lastRunFailed, items }))`。

**debounce 100ms**：`enqueue` 与紧随其后的 `claimNext`（会话恰好空闲收尾）可能连发两次，合并后前端只刷新一次，避免面板闪动。

**晚绑定注意**：`resolveRunningChannel` 依赖 `feishuInboundHandler`（构造顺序在 `feishuTaskQueue` 之后），必须用可赋值的 `let` 闭包或 `setResolver()` 注入，不能在构造时直接引用。这是实现阶段最容易踩的坑，单测要覆盖「resolver 未注入时不抛错」。

#### 4.1.6 `runningChannel` 解析

由 `create-app.ts` 在 `assembleFeishuHandler` 之后构造（`wsHandler` 在 1030 行、`feishuHandler` 在 1104 行，**晚绑定是硬约束**）：

```ts
const resolveRunningChannel = (
  sessionId: number, phase?: string | null,
): 'feishu' | 'local' | null => {
  // 终态保护：phase 已知且是终态时直接归零，不依赖 busy 清理时序
  // （complete() 触发通知时 busy.delete 可能还没执行）。
  if (phase != null && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(phase)) return null;
  if (feishuInboundHandler.hasRunningSession(sessionId)) return 'feishu';
  if (wsHandler.hasExecutionClaim(sessionId)) return 'local';
  // 钉钉/微信/崩溃恢复续跑等：返回 null（不归入任何一组）。
  return null;
};
```

注入方式（三处，注意各自的时序约束）：

1. **视图与通知器**：`resolveRunningChannel` 在 `app-feishu-handler.ts` 内、`feishuInboundHandler` 实例化之后构造；`feishuInboundQueueView`（导出给路由）与通知器都在该函数内闭包捕获它。`feishuInboundQueueRepo` 是局部变量，**不导出到装配层**。
2. **飞书通知器**：`notify` 本就会先取 `session`，把 `session.phase` 传进 resolver。
3. **`sendQueueUpdated`**：`wsHandler` 早于 `feishuInboundHandler` 构造，**不能在 `assembleWsHandler` 时注入**。`StreamingWsHandler` 新增 `setRunningChannelResolver(fn)`，由 `create-app.ts` 在 `assembleFeishuHandler` 之后调用（与既有 `wsHandler.registerExternalBusyCheck(...)`、`registerImQueueDrainHandler(...)` 同款晚绑定）。

- 两个忙检查都是同步内存查询，**不额外查库**；`sendQueueUpdated` 路径不带 `phase`（无会话实体），只靠 claims/busy 判定，属可接受近似。
- `null` 表示「当前没有可归类的执行在跑」——前端此时不给任何一组打「下一组」徽标（见 4.2.4 规则 2）。

#### 4.1.7 取消排队（一期）

实现分两层，路由只做鉴权与转发：

1. `session.routes.ts`：`requireUserId` + `requireSessionOwner` → `feishuInboundQueueView.cancel(session, queueId, userId)`。
2. `cancel()`（在 `app-feishu-handler.ts` 内构造，持有 repo / `feishuTaskQueue` / 卡片 PATCH 能力）：
   - `findById(queueId)`；行不存在 → `NOT_FOUND`。
   - `row.sessionId !== session.id` → `NOT_FOUND`（不泄露行存在性）。
   - 发送者校验（见下）失败 → 403（走 `BusinessException(FORBIDDEN)`，`handleError` 对 1002/403 返回 HTTP 403，是仓库唯一可靠的 4xx）。
   - 调 `FeishuTaskQueueService.cancel(id)`，按结果组装响应。

**发送者校验（回到 `maoUserId`，不做 union_id 迁移）**

已核实 `maoUserId` **就是发送者的 mao 用户 id**：`resolveFeishuUserId` / `resolveUserId` 都按发送者 `senderUnionId` 查 `feishu_binding`（`feishu-session.ts:148-152`），群聊与话题路径把它作为 `executionUserId` 传给 handler，入队时写入 `session.executionUserId ?? context.maoUserId ?? null`（`agent-inbound-handler.ts:1083`）。发送者未绑定飞书账号时该值为 `null`——这正是决策 2 要放行的场景。

判定口径：

1. `row.maoUserId != null && row.maoUserId !== userId` → 403「仅消息发送者可操作」。
2. `row.maoUserId === userId` → 允许（本人）。
3. `row.maoUserId == null`（发送者未绑定 mao 账号 / 存量行）→ **允许会话 owner 取消**（决策 2），日志记 `legacy=true`。

> 为什么不再引入 `sender_union_id` 列：`mao_user_id` 已能表达发送者身份，多存一列 unionId 只会在「用户解绑/换绑」时产生额外语义，且每次推送多一次绑定查询。保持单列。

**结果映射（全部 HTTP 200 + `result`，符合仓库约定）**

| `cancel()` 返回 | 响应体 | 前端处理 |
|---|---|---|
| `CANCELLED` | `{ result: 'CANCELLED' }` | 依赖 `inbound_queue_updated` 更新列表，不额外提示 |
| `ALREADY_STARTED` | `{ result: 'ALREADY_STARTED' }` | toast「该消息已不在队列」，随后刷新 |
| `NOT_FOUND` | `{ result: 'NOT_FOUND' }` | toast「该消息已失效」，随后刷新 |

- 为什么不用 HTTP 409/404：`BusinessException` 一律映射到 200（仅 401/403/413 例外，`common/http-error.ts:68-84`）；桌面端 axios 拦截器对「200 + code≠0」走错误提示、对 4xx 走 `error.response` 分支。用 200 + `result` 与现有能力一致，也不用新增 ErrorCode。
- 前端按 `result` 自行 toast 即可：200 + `result` 走的是 axios 成功分支，不会触发拦截器错误提示；403 由拦截器统一 `ElMessage.error`（`desktop/src/api/index.ts:134-141`，无静默开关），调用方**不要重复 toast**。

**与消费的竞态**：`cancel()` 内部是 `UPDATE ... WHERE id=? AND status='QUEUED'` 的 CAS，与 `claimNextQueued` 互斥；二者必有一方失败。取消先赢 → 该行不会被消费；认领先赢 → 返回 `ALREADY_STARTED`，消息照常执行。**两端同时取消**：输的一方可能收到 `ALREADY_STARTED` 而非「已取消」，故 toast 文案用中性表述「该消息已不在队列」。

**飞书卡片同步**（决策 1 的核心）：

- `FeishuCardActionService` 新增公开方法 `renderCancelledCard()`，内部复用现有 `buildQueueCardText('✖️ 已取消', '这条消息已取消，未进入执行。')`，**不传 `sessionDetailUrl`**——与卡片按钮取消（`handleCancel` 当前就不传 URL）保持完全一致，否则 web 取消出的卡会多一个「会话详情」按钮。
- `app-feishu-handler.ts` 把现有 `cardActionService.patchCard` 的 PATCH 实现抽成 `patchQueueCard(botId, cardMessageId, card)`（`client.im.v1.message.patch`，与 `:529` 同款），供卡片回调与取消接口共用。
- 顺序：`cancel()` → PATCH → **再手动 notify 一次**。`cancel()` 自身也会触发 `onChanged`（100ms debounce），两路推送内容一致、幂等；不承诺 PATCH 与面板推送的严格先后，只保证最终一致。
- PATCH 失败只记 `warn`，**不影响响应结果**（库内行已删）；飞书旧卡再点会走 `findByCardMessageId` 查不到行 → toast「消息已失效，请重新发送」。
- `cardMessageId == null`（卡片发送失败已降级为文本）→ 跳过 PATCH。

**前端**：仅在 `cancelable === true` 的项上渲染「取消排队」按钮；点击弹 `ElMessageBox.confirm`（沿用 QueuePanel 删除本地项的风格）；结果分支见上表。

#### 4.1.8 失败滞留提示（一期）

**为什么需要（双向门禁，不只飞书侧）**：

- 飞书侧执行 `FAILED` → `drainNext` 的 `phase !== 'FAILED'` 门禁不再接力；
- 本地/WS 侧执行 `FAILED` → `autoConsumeQueueInner` 的 `phaseBlocked` 同时挡住本地队列与 `relayToImQueues`（飞书接力）。

两侧任一侧失败，**两组队列都不会自动继续**。`runningChannel` 在失败场景下为 `null`（没有执行在跑），单看它无法区分「正常空闲」与「卡住」。

**数据字段**：`list()` 与 `inbound_queue_updated` 的 `data` 同时返回：

```ts
lastRunFailed: boolean
```

- 判定：`session.phase === 'FAILED'` 即 `true`。
- **不在后端判定「是否还有排队项」**：本地队列条数会随 web 端入队/删除实时变化，后端只在飞书队列变化时推送，把这个判定放后端会立刻过期。`lastRunFailed` 只表达「上一轮执行失败」这一事实，是否展示由前端结合两组队列长度决定（见 §4.2.4 规则 5）。
- 不使用 `session.updatedAt` 作「失败时间」：该列是 `ON UPDATE CURRENT_TIMESTAMP`，任何会话更新（含 `updatePhase` 写 `lastActivityAt`）都会刷新，不能代表失败时刻；前端也不展示时间，故字段简化为布尔。
- 只做「提示」，不做自动重试：`FAILED` 门禁是既有设计（避免基于失败上下文连跑），本方案不改变它。

**推送时机**：飞书队列变化时随 `inbound_queue_updated` 一起推；本地队列变化或执行终态时由前端兜底刷新拿到（§4.2.3），不新增事件。**已知延迟**：飞书卡片「重试」、admin 失败会话批量恢复、`CrashRecoveryRunner` 续跑都会把 `phase` 从 FAILED 改走，但都不触发 `inbound_queue_updated`，提示条不会立刻消失，需等下一次终态刷新/进入会话。

**前端展示条件**：`lastRunFailed === true && (飞书项数 + 本地项数 > 0)`。两组皆空时不展示（没有滞留就没有提示）。

**前端展示**：面板顶部（两组队列之上）一条提示条：

```
⚠️ 上一条任务执行失败，排队消息不会自动继续。重新发送一条消息，或点击失败卡片的「重试」后恢复。
```

- 样式：`--aw-danger`/`--aw-warning` 浅底 + 12px 文案，不放按钮。
- 不给「一键继续」按钮：现有失败卡「重试」与「再发一条消息」都能让 `phase` 离开 `FAILED` 并触发 `autoConsumeQueue`；新增跨通道一键触发面收益不抵风险（列为后续可选，见 §8）。

### 4.2 前端

#### 4.2.1 状态与拉取

`desktop/src/stores/session/messages.ts`（沿用该文件已有的 `sessionQueueMessages` 模式）：

```ts
const sessionInboundQueue = ref<Map<string, FeishuInboundQueueItem[]>>(new Map())
const sessionLastRunFailed = ref<Map<string, boolean>>(new Map())
const sessionRunningChannel = ref<Map<string, 'feishu' | 'local' | null>>(new Map())

function setInboundQueue(sessionId: string, items: FeishuInboundQueueItem[]): void  // id 统一转字符串
function getInboundQueue(sessionId: string): FeishuInboundQueueItem[]
function setLastRunFailed(sessionId: string, failed: boolean): void
function getLastRunFailed(sessionId: string): boolean
function setRunningChannel(sessionId: string, channel: 'feishu' | 'local' | null): void
function getRunningChannel(sessionId: string): 'feishu' | 'local' | null
/** 主面板无 sessionId prop：与 activeQueueMessages 同款，按当前活跃会话取值 */
const activeInboundQueue = computed(() => sessionInboundQueue.value.get(getActiveSessionId() ?? '') ?? [])
```

`desktop/src/types/chat.ts` 新增 `FeishuInboundQueueItem`（字段与 4.1.2 VO 一致）。

`desktop/src/composables/chatSessionActions.ts` 的 `fetchSessionQueue` 扩展为并行拉两个接口，各自独立兜底（一个失败不影响另一个，失败侧保留旧值）：

```ts
const [local, inbound] = await Promise.all([
  api.get(`/sessions/${sid}/queue`).catch(() => null),
  api.get(`/sessions/${sid}/inbound-queue`).catch(() => null),
])
if (local?.data) sessionStore.setQueueMessages(sid, local.data)
if (inbound?.data) {
  sessionStore.setInboundQueue(sid, inbound.data.items ?? [])
  sessionStore.setRunningChannel(sid, inbound.data.runningChannel ?? null)
  sessionStore.setLastRunFailed(sid, inbound.data.lastRunFailed === true)
}
```

#### 4.2.2 事件

`desktop/src/composables/useStreamWS.ts` 新增：

```ts
case 'inbound_queue_updated': {
  if (sessionId) {
    sessionStore.setInboundQueue(sessionId, data?.items || [])
    sessionStore.setRunningChannel(sessionId, data?.runningChannel ?? null)
    sessionStore.setLastRunFailed(sessionId, data?.lastRunFailed === true)
  }
  break
}
```

#### 4.2.3 刷新兜底

事件是「尽力而为」：WS 断连重连、蓝绿切换窗口、多标签页时可能丢帧。兜底按「扩展现有入口」而不是新写一套拉取：

1. **扩展 `refreshQueue`**（`useStreamWS.ts:161`）为同时拉 `/queue` 与 `/inbound-queue`。这样已有的重连路径（`resubscribe` 里对每个订阅会话 `refreshQueue(sid)`，`useStreamWS.ts:479`）**自动覆盖**，不需要额外接线。
2. `session_status` 进入终态（`COMPLETED/FAILED/CANCELLED`）时刷新——`lastRunFailed` 与「项消失」都靠这条收敛（现状该分支确实不刷新队列，只有 `queue_message_consumed` 会刷，顺手补上）。
3. `session_status` 进入 `RUNNING` 时也刷新一次：用于纠正「飞书 → 本地接力」后的 `runningChannel`（`sendQueueUpdated` 已带上该字段，这条是双保险）。
4. `visibilitychange` 回到前台且当前会话有排队项时拉一次（可选，节流 5s）。

> **不要顺手改的三处**：`useChat.ts:623/839/877` 与 `SideChatPanel.vue:692` 的 `getQueueMessages(sid).length === 0` 判断的是「本地队列是否已排空」以决定要不要补拉消息流；若改成「两组合计」，终态后会跳过 `fetchMessages()`，消息流停在旧快照。这些判断保持仅本地口径。

#### 4.2.4 QueuePanel 分组渲染

`desktop/src/components/chat/QueuePanel.vue`：

```
待发送消息 (3)
┌ 本地排队 (2)                         [下一组]
│  1. 让发布脚本跑…              [编辑][立即发送][删除]
│  2. 顺便加个单测
└ 飞书排队 (1)
   1. 飞书 · 杨佳毅 · 14:08  「压测链路需求调研…」
```

规则：

1. **可见性计数改用两组合计**：新增 `visibleCount = queueMessages.length + inboundMessages.length`；根节点 `v-if`、标题「待发送消息 (N)」、折叠阈值全部用 `visibleCount`。**只改条件不改数据源**：`queueMessages` / `queueView` 仍然只装本地项（拖拽下标、`reordering`、`insertingQueueId` 复位都依赖它），飞书项走独立的 `inboundView`。
   - `inboundMessages` 取数与本地同款双分支：`props.sessionId ? getInboundQueue(props.sessionId) : activeInboundQueue`（边路面板依赖 `sessionId` prop，不能只加 `activeInboundQueue`）。
   - 展示段复用 `truncateSegments`：该函数当前是 `QueuePanel.vue` 内私有，需**连同 `splitUserMessageForDisplay` 一起抽到 `desktop/src/utils/queue-view.ts`**（组件与单测共用），否则折叠首行/摘要无法纯函数化测试。
2. **下一组算法**（显式计算，避免「正在跑的那组已空」漏标）：

```ts
const nextGroup = computed<'local' | 'feishu' | null>(() => {
  if (localCount === 0 && inboundCount === 0) return null
  if (localCount === 0) return 'feishu'
  if (inboundCount === 0) return 'local'
  if (runningChannel === 'local') return 'local'
  if (runningChannel === 'feishu') return 'feishu'
  return null   // 两组都非空且无执行在跑：不猜顺序，两组都不打标
})
```

组头 `[下一组]` 徽标只加在 `nextGroup` 对应的组上；两组都空时不渲染整块。`null` 分支不再「默认飞书优先」——没有执行在跑时后端不会自动接力，标任何一方都是发明顺序。
3. **飞书项**：不渲染拖拽手柄与编辑（不可重排、不能回填本地输入框）；行内展示 `飞书 · {senderLabel} · {HH:mm}` + 摘要 + 位次，右侧 `[图片 n]`/`[文件 n]` 标记；`cancelable === true` 时渲染「取消排队」按钮（4.1.7），否则不渲染任何操作按钮。
4. **位次**：本地项 = 数组下标 + 1（现状）；飞书项 = 后端 `queuePosition`（不用前端下标，避免两组渲染顺序影响位次含义）。
5. **失败滞留提示**：`lastRunFailed === true && visibleCount > 0` 时在两组之上渲染提示条（4.1.8），文案固定，不带按钮。
6. **折叠态**：阈值改为 `visibleCount > 5`；折叠行取「本地首条，否则飞书首条」，**不要直接索引 `queueView[0]`**（本地为空时会 `undefined` 崩溃），文案 `本地 2 条 · 飞书 1 条`。
7. **空态**：`visibleCount === 0` 时整块不渲染；此时即使 `lastRunFailed === true` 也不展示提示条。
8. **样式**：沿用 `--aw-*` tokens，飞书项左侧加 2px 竖条（`--aw-primary` 40% 透明度）+ 「飞书」小徽标区分来源；不引入新色板。
9. **结构性约束（回归红线）**：
   - `.queue-title` 必须保留 `role="status" aria-live="polite"`（`chat-a11y.test.ts` 按源码断言）；
   - `@media (pointer: coarse)` 块内必须继续出现 `.queue-item-actions .action-btn` 与 `32px`；
   - 飞书项的「取消排队」按钮放在同一 `.queue-item-actions` 容器内，保证触屏命中区规则覆盖它。

#### 4.2.5 飞书卡片文案对齐

现状卡片写「当前任务正在执行中，这条消息已进入队列（第 N 位），将在当前任务完成后自动开始处理。」（`backend-ts/src/feishu-cards.ts` 的 `buildFeishuQueueCard`），`N` 取自入队那一刻的 `countPending`（只统计飞书队列），**是快照、之后不会更新**（前面有人取消/插队时卡片位次会失真）。

为避免与 web 面板并列后产生困惑：

- 文案改为「已进入飞书队列（第 N 位）」，并在**存在本地排队时**追加一句「另有 {M} 条本地排队消息将在其后执行」；`M = 0` 时整句不出现（不显示「另有 0 条」，也不留空行）。
- 实现：`buildFeishuQueueCard(context, queueId, position, localQueuedCount?)` 增加可选参数；`createFeishuQueueCardHelper` 注入 `countLocalQueue: (sessionId) => Promise<number>`（内部 `messageQueueService.listPending(sessionId).length`），入队发卡时一并传入。与既有 `queuePositionOf` 同款装配方式。
- 面板展示的 `queuePosition` 是**实时位次**（每次推送按 rank 重算），与卡片快照可能不同；这正是「web 面板看实时状态」的价值点，文档与文案都不承诺两者一致。

### 4.3 数据流总览

```
飞书消息到达（会话忙）
  → enqueueMessage → feishu_inbound_queue INSERT
  → 发飞书排队卡片（附本地排队条数，M=0 不显示）
  → onChanged → GET session.userId → listQueuedBySession
  → WS inbound_queue_updated → web 面板出现「飞书排队」项

飞书执行收尾 / 认领
  → claimNext（QUEUED→RUNNING）→ onChanged → 面板项消失
  → saveUserMessage + user_message_saved → 消息流出现该消息

web 端取消排队
  → DELETE /sessions/:id/inbound-queue/:queueId
  → 校验 owner + 发送者 → cancel()（CAS QUEUED→CANCELLED）
  → PATCH 飞书卡片「已取消」（失败仅 warn）
  → onChanged → inbound_queue_updated → 面板项消失、飞书卡片终态

执行失败
  → session_status FAILED → 前端兜底刷新 → lastRunFailed 为 true + 有排队项 → 面板顶部提示条

web 端打开会话 / 断线重连 / 执行终态
  → GET /sessions/:id/inbound-queue → 面板、位次、lastRunFailed 与库内对齐
```

## 5. 竞态与边界

| 场景 | 行为 |
|---|---|
| 读取接口与认领并发 | 返回的是快照；下一帧 `inbound_queue_updated`（或终态兜底刷新）会纠正，最多一次刷新延迟 |
| 面板显示项被认领（用户刚看到就没了） | 与本地队列一致：项消失 + 消息流出现该消息，属预期 |
| `payload` 解析失败 | VO 返回占位文案，接口不 500；日志 warn 带 `queueId` |
| web 取消与 `claimNext` 并发 | CAS 单赢：取消先赢 → 行删除、不会执行；认领先赢 → 取消返回 `ALREADY_STARTED`，消息照常执行，前端刷新后项消失 |
| 两端同时取消（飞书按钮 + web） | 第二次 CAS/`findById` 失败 → `NOT_FOUND`/`ALREADY_STARTED`，前端 toast + 刷新，天然幂等 |
| 取消成功但卡片 PATCH 失败 | HTTP 仍 200（库内行已删）；飞书旧卡再点 → `findByCardMessageId` 查不到 → toast「消息已失效，请重新发送」 |
| 任一侧执行 `FAILED` 导致队列停滞 | `lastRunFailed` + 面板提示条（4.1.8）；不改「失败不自动接力」的既有门禁（飞书侧 `drainNext` 与本地侧 `phaseBlocked` 都是双向拦截） |
| `lastRunFailed` 抖动 | 后端只在 `phase=FAILED` 时为 true；是否展示由前端叠加「两组中至少一条排队项」判断。用户重试/再发消息后 phase 变 RUNNING，下一帧自动消失 |
| 群聊多人排队 | owner 可见全部飞书项（会话内容本就对 owner 可见）；`cancelable` 按 `maoUserId` 收窄（null 时 owner 可取消），他人项不渲染按钮 |
| 边路任务 / 子会话 | 按 `session_id` 天然隔离，父会话面板不显示子会话队列（现状 `message_queue` 同样口径） |
| 蓝绿切换丢帧 | 终态兜底 + 进入会话拉取；`resubscribe` 已对每个订阅会话调 `refreshQueue`，扩展后自动覆盖重连路径 |
| 卡片「重试」/ admin 失败恢复 / CrashRecovery 续跑 | 都会把 `phase` 从 FAILED 改走，但不触发 `inbound_queue_updated`；提示条不会立刻消失，等下一次终态刷新或进入会话（已列入 §4.1.8） |
| 服务启动窗口 | `hydrate` 在 `crash.run()` 之后执行（`app-lifecycle.ts`），启动瞬间客户端可能读到复位前的队列；依赖前端重连/进入会话收敛，不做额外广播 |
| 频繁连发消息 | 100ms debounce 合并推送；面板只在变化时重渲染 |

## 6. 测试计划

后端（Vitest，`backend-ts/src/**/*.spec.ts`）：

1. `inbound-queue-view.spec.ts`（纯函数，不连库）：
   - 摘要优先用列 `summary`；列为 `null` 时回退解析 `payload`；
   - 回退解析：群聊剥 `【用户消息】\n{label}：` 前缀且**保留全部剩余内容**（多段落不被截成末段）；私聊原样；
   - `ContentPart[]` 文本拼接 + `image_url` 计数；空正文 + 有图片 → `[图片]`；
   - `clipByCodePoints` 截断 60 字（emoji 不被切半）；非法 JSON → 占位文案、不抛错；
   - `cancelable`：`maoUserId === viewer` → true；`maoUserId == null` → true（owner 放行）；其余 false。
2. `inbound-queue.repository.spec.ts`：`listQueuedBySession` 只返回 QUEUED、按 rank 升序；**查询语句不含 `payload`**（断言 SQL 列清单）。
3. `session.routes.spec.ts`：
   - `GET /v1/sessions/:id/inbound-queue`：owner 校验、空数组、VO 结构、`lastRunFailed`；
   - `DELETE`：**全部 HTTP 200 + `result`**（`CANCELLED` / `ALREADY_STARTED` / `NOT_FOUND`），不写 409/404 断言；
   - 非 owner → 403；非本人发送项 → 403；`maoUserId == null` 时 owner 放行；
   - 行不属于该会话 → `NOT_FOUND`（不泄露存在性）。
4. `inbound-queue.service.spec.ts`：
   - `onChanged` 在 enqueue / claimNext / complete / cancel / jumpToFront 各触发一次，异常不冒泡；未注入钩子不报错；
   - `complete(id, sessionId?)` 透传 sessionId；不传时退化为单查 `findById`；
   - **同步补 mock**：现有 `repo()` 辅助函数是 `Record<keyof FeishuInboundQueueRepository, unknown>`，新增 `listQueuedBySession` 后所有用例会编译失败，必须在 base 里补 mock。
5. 存量行回退：`summary IS NULL` 时 4 个展示字段一起由 payload 计算（带图老行不能显示 0 张图）。
6. `feishu-cards.spec.ts`：`localQueuedCount > 0` 渲染「另有 M 条」；`0` / `undefined` 整句不出现。
7. 取消卡片：`renderCancelledCard()` 与 `handleCancel` 走同一 `buildQueueCardText` 参数（断言文案一致、无「会话详情」按钮）。
8. 通知聚合：100ms 内连续两次变化只推一帧（假定时器）。

前端（Vitest，**不引入 `@vue/test-utils`**，桌面端目前只有纯逻辑测试 + 源码字符串断言）：

9. 抽纯函数到 `desktop/src/utils/queue-view.ts`（`truncateSegments` / `visibleCount` / `nextGroup` / 折叠首行）并单测：
   - `visibleCount = local + inbound`；
   - `nextGroup`：`local=0` → `feishu`；`inbound=0` → `local`；两者都非空时按 `runningChannel`；`runningChannel=null` 时返回 `null`（两组都不打标）；
   - 折叠文案 `本地 2 条 · 飞书 1 条`；折叠首行「本地优先、否则飞书首条」（本地为 0 时不索引 `queueView[0]`）；
   - 提示条条件 `lastRunFailed && visibleCount > 0`。
10. `useStreamWS` 分支：`inbound_queue_updated` 更新 store；`session_status` 终态与 `RUNNING` 触发刷新（mock api）；`refreshQueue` 同时请求两个接口。
11. `fetchSessionQueue`：一个接口失败时另一侧仍生效、失败侧保留旧值。
12. 源码结构断言（沿用 `chat-a11y.test.ts` 风格）：`.queue-title` 保留 `role="status" aria-live="polite"`；`@media (pointer: coarse)` 块内仍有 `.queue-item-actions .action-btn` 与 `32px`。
13. 时序用例（mock）：`claimNext` 通知（项消失）先于/后于 `user_message_saved`（消息出现）都不会导致列表重复或残留；取消成功后不会再收到 `queue_message_consumed`。

手工验收：

- [ ] 飞书连发 2 条（会话忙）→ web 面板出现 2 条飞书项，位次 1/2，摘要与发送者正确；**本地队列为空时面板依然渲染**。
- [ ] 飞书项开始执行 → 面板项消失、消息流出现该消息（时间差 < 1s）。
- [ ] 同一会话 web 发 1 条 + 飞书发 1 条：面板两组同时可见，「下一组」指向与真实接力顺序一致；本地开始执行后徽标切到本地（不等终态）。
- [ ] **web 取消本人飞书排队项** → 面板项消失、飞书卡片变「已取消」（无「会话详情」按钮）、该消息不再执行。
- [ ] **取消他人发送的飞书项** → 无按钮；直接调接口 → 403。
- [ ] **飞书卡片与 web 同时取消** → 一端成功、另一端 toast「该消息已不在队列 / 该消息已失效」，不出现双删异常。
- [ ] **任一侧执行失败** → 面板出现「上一条任务执行失败」提示条；重新发送后提示消失、排队项继续被消费。
- [ ] 断网 10s 后恢复 / 后端重启 → 面板自动收敛，无幽灵项。
- [ ] 本地队列为空时折叠态正常显示（不白屏）。

## 7. 落地清单

后端 `backend-ts/`：

- [ ] `db/migration/V210__feishu_inbound_queue_view_columns.sql`：`summary` / `sender_label` / `image_count` / `file_count`
- [ ] `src/feishu/inbound-queue.repository.ts`：`listQueuedBySession`（显式列，**不含 payload**）+ `insert()` 补 4 个展示列
- [ ] `src/feishu/inbound-queue-view.ts` + `.spec.ts`（新增文件）：摘要（列优先 / payload 回退）、`cancelable`（`maoUserId` 口径）、`lastRunFailed`、`cancel()`
- [ ] `src/feishu/inbound-queue.service.ts` + `.spec.ts`：`onChanged` 钩子（enqueue / claimNext / complete / cancel / jumpToFront）、`complete(id, sessionId?)`
- [ ] `src/feishu/types.ts`：`FeishuInboundQueueListItem`（不含 payload）、`FeishuInboundQueueItemVO`、`RunningChannel`、`FeishuTaskQueuePort.enqueue` 参数扩展
- [ ] `src/feishu/agent-inbound-handler.ts`：`buildQueueViewColumns` 入队写入；`complete(row.id, sessionId)` 透传（唯一调用点在 `:978`）
- [ ] `src/app-feishu-handler.ts`：构造并导出 `feishuInboundQueueView`、通知器（debounce + 晚绑定 resolver）、`patchQueueCard`、`countLocalQueue` 注入
- [ ] `src/feishu/card-action.service.ts`：公开 `renderCancelledCard()`（与 `handleCancel` 同参数）
- [ ] `src/feishu-cards.ts`：`buildFeishuQueueCard(..., localQueuedCount?)` 与「另有 M 条」文案
- [ ] `src/session/session.routes.ts`：`GET` / `DELETE` 两个路由（200 + `result`，403 走 `BusinessException`）
- [ ] `src/app-routes.ts`：`RouteDeps` / `SessionRouteDeps` 增加 `feishuInboundQueueView` 并传入 `registerSessionRoutes`
- [ ] `src/create-app.ts`：`resolveRunningChannel` 构造与三处注入（视图、通知器、`wsHandler.setRunningChannelResolver`）
- [ ] `src/session/ws/streaming-ws-handler.ts`：`sendQueueUpdated` 带 `runningChannel`（走 `setRunningChannelResolver` 晚绑定）
- [ ] `src/session/ws/streaming-ws-registry.ts`：`inbound_queue_updated` 登记 `CRITICAL_EVENT_TYPES`

前端 `desktop/`：

- [ ] `src/types/chat.ts`：`FeishuInboundQueueItem`
- [ ] `src/utils/queue-view.ts` + `.spec.ts`（新增）：`truncateSegments`（从 `QueuePanel.vue` 抽出）/ `visibleCount` / `nextGroup` / 折叠文案与首行
- [ ] `src/stores/session/messages.ts`：`sessionInboundQueue` / `setInboundQueue` / `getInboundQueue` / `lastRunFailed` / `runningChannel` / `activeInboundQueue`
- [ ] `src/composables/chatSessionActions.ts`：`fetchSessionQueue` 并行拉取（各自兜底）
- [ ] `src/composables/useChatQueue.ts`：`fetchQueue` 复用新拉取；`cancelInboundQueueMessage(queueId)`（静默错误 + `result` 分支 toast）
- [ ] `src/composables/useStreamWS.ts`：`inbound_queue_updated` 分支；`refreshQueue` 扩为两个接口；终态与 `RUNNING` 刷新
- [ ] `src/components/chat/QueuePanel.vue`：分组渲染、「取消排队」按钮与确认框、失败提示条、折叠态、样式与 a11y 结构
- [ ] `src/components/chat/ChatPanel.vue` / `SideChatPanel.vue`：`@cancel` 接线

文档：

- [ ] 根 `CHANGELOG.md` 顶部新增版本条目（用户可见改动）
- [ ] `skills/mao-cli/` 若涉及队列说明，同步一句「web 面板可见并可取消飞书排队项」

### 7.1 分期与工作量估算

| 阶段 | 范围 | 预估 |
|---|---|---|
| P0（一期） | 迁移（4 个展示列）+ 查询接口 + VO + WS 事件 + 通知接入；前端分组展示 + 兜底刷新；**取消排队（`maoUserId` 权限 + 卡片 PATCH）**；**失败滞留提示**；卡片「另有 M 条」文案 | 后端 1.5–2 人日，前端 1–1.5 人日，测试 1 人日 |
| P1（可选增强） | 面板「一键继续消费队列」、`lastRunFailed` 独立事件、飞书卡片位次实时化 | 1 人日 |

一期不做一键恢复：现成的「失败卡重试 / 再发一条消息」已能让 phase 离开 `FAILED` 并触发 `autoConsumeQueue`，新增跨通道触发入口需要额外的权限与并发论证。

## 8. 决策记录与剩余风险

### 8.1 已确认决策（2026-11-25）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 「取消排队」是否进一期 | **进一期**；取消成功后必须同步 PATCH 飞书排队卡片为「已取消」终态（§4.1.7） |
| 2 | 发送者未绑定 / 历史行能否被 owner 取消 | **允许**。判定口径：`maoUserId === 当前用户` 放行；`maoUserId == null`（发送者未绑定 mao 账号）由会话 owner 放行；既非本人又非空 → 403 |
| 3 | 飞书卡片文案 | **同步改**为「已进入飞书队列（第 N 位）」；本地无排队（M=0）时不显示「另有 M 条」附加信息 |
| 4 | 失败滞留提示 | **要做**，一期实现（§4.1.8）：`lastRunFailed=true` + 前端判定存在排队项 → 面板顶部提示条（两侧失败都会触发） |

### 8.2 剩余风险

1. **取消的权限边界**：`maoUserId == null`（发送者未绑定 mao 账号）时会话 owner 可取消，群聊中可能出现「owner 取消到他人未绑定消息」。缓解：日志记录 `queueId / sessionId / operatorId` 与 `legacy=true`，VO 的 `cancelable` 控制按钮可见性；后续如需更严，可要求「未绑定用户的消息不可在 web 取消」。
2. **卡片 PATCH 与库内状态可能短暂不一致**：PATCH 失败只记日志，飞书旧卡仍显示「排队中」，用户点击会得到「消息已失效」。属既定降级，不做补偿队列（补偿会增加一套失败重试机制，收益不抵成本）。
3. **位次口径**：飞书卡片位次是「入队瞬间的快照」，面板位次是「实时值」，两者可能不同。文案必须区分（卡片写「已进入飞书队列（第 N 位）」），否则用户会拿两个数字对比并认为有 bug。
4. **推送依赖单实例**：WS registry 在内存，蓝绿切换窗口内丢帧只靠前端兜底收敛；极端情况下最长延迟到下一次进入会话/终态。
5. **存量行的回退解析**：迁移后老行 `summary` 为 `NULL`，读取时按 id 单查 `payload` 回退解析。队列清空后这些行会被删除，成本随使用自然衰减；不做一次性数据回填（无法可靠复原原文）。
6. **失败提示可能滞后**：`lastRunFailed` 在后端仅随「飞书队列变化推送」或「前端终态兜底刷新」更新；若会话长时间无任何事件，提示最晚延迟到下一次页面操作（切会话/刷新）。展示条件里的「是否有排队项」由前端本地状态即时计算，不受此影响。
7. **迁移风险**：`ALTER TABLE ... ADD COLUMN` 对 `feishu_inbound_queue`（小表）无锁表风险；迁移编号取 `V210`（撰写时仓库最大为 `V209__fix_agent_skill_names_comment.sql`），实现时若已被占用顺延。
8. **不解决根因**：本方案补的是可见性与可控性，不改「失败不自动接力」和两套队列并存的底层语义。若后续希望彻底统一排队体验，仍需评估单一排队状态机（不在本期范围）。
