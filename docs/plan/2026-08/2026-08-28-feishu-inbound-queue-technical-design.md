# 飞书入站消息队列（FIFO + 排队卡片）技术方案

## 1. 需求背景

当前飞书通道的行为是「到达即打断」：Agent 正在执行任务时收到用户的新消息，会立即取消正在执行的任务（置位取消标志、关闭会话 shell），然后以新消息为起点重新执行（见 `backend-ts/src/feishu/agent-inbound-handler.ts` 的代际取消机制）。

这套行为有两个问题：

- 用户只想补充信息（例如「顺便加个单测」），旧任务却被整单作废，已产生的中间成果丢弃；
- 打断是无感知的，用户不清楚旧任务是「被打断了」还是「已完成」，也没有选择权。

期望改为显式可控：执行中的任务不被打扰，新消息进入队列排队；用户如果想立刻纠偏，通过卡片按钮主动触发打断。

## 2. 需求描述

### 2.1 要做的

1. Agent 执行任务期间，同一会话再次收到用户消息时，不再取消当前任务；新消息进入该会话的 FIFO 队列尾部等待。
2. 入队的消息立即向用户发出一张飞书交互卡片，内容包括：排队提示（当前任务执行中，该消息将在当前任务完成后自动执行）、消息摘要、两个按钮：
   - **立即发送**：取消当前正在执行的任务，该消息跳到队首立即执行（纠偏语义），其余排队消息保持原有相对顺序；
   - **取消本次任务**：将该消息从队列移除，不影响当前任务和其他排队消息。
3. 当前任务执行完成后，自动按顺序消费队首消息并完整执行；每条排队消息开始执行时，把它的排队卡片就地 PATCH 升级为进度卡片，此后沿用现有进度卡生命周期（执行中 → 完成/失败/取消）。
4. 「立即发送」触发的打断沿用现有取消链路：置位 AgentLoop 取消标志、关闭该会话 shell 子进程、清理不完整的消息尾部；被打断任务的进度卡片显示「已被下一条指令中断」。
5. 私聊和群聊统一生效；群聊中按钮仅允许原消息发送者操作（卡片回调携带点击者身份，与服务端记录的发送者比对），他人点击返回 toast 提示「仅消息发送者可操作」。
6. 队列按会话维度隔离，**不设容量上限、不做排队超时**；每个 Bot 应用独立。
7. 队列持久化到 MySQL，后端进程重启后自动恢复队列继续串行消费，排队消息不丢失；重启时正在执行的任务仍由现有 CrashRecoveryRunner 续跑，续跑完成后自动接力消费队列。

### 2.2 明确不做的

| 不做项 | 说明 |
|--------|------|
| 微信通道同类改造 | 微信通道维持现状（到达即打断），本期不动 |
| 桌面/Web 端消息队列 | desktop 已有独立的 WS 通道队列（`message_queue` 表 + QueuePanel），语义与本需求不同，互不影响、不复用代码 |
| 队列容量上限 / 满员拒绝 | 用户明确选择无限 FIFO |
| 排队超时自动取消 | 排队消息永久有效直到被执行、取消或队列清空 |
| Bot 级「打断模式」开关 | 彻底移除自动打断，不保留双模 |
| 卡片按钮的管理端统计 | 不做埋点和报表 |
| 队列可视化管理界面 | admin 不新增页面 |

## 3. 已确认的决策记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 多条消息排队策略 | **无限 FIFO**：A 执行中收到 B、C，A 完成后依次执行 B、C，每条都有独立卡片和按钮 |
| 2 | 「立即发送」作用于非队首消息 | **跳到队首**：被点击的消息 rank 调整为当前最小 rank − 1，打断当前任务后立即执行它，其他消息保持原序 |
| 3 | 生效范围 | **私聊 + 群聊统一**（同一入站链路） |
| 4 | 按钮权限 | **仅原发送者可点**（open_id 比对） |
| 5 | 卡片形态 | **一卡到底**：排队卡 → PATCH 为进度卡 → 终态，全生命周期一张卡 |
| 6 | 队列存储 | **MySQL 新表持久化 + 启动恢复**；CrashRecoveryRunner 续跑被打断任务后接力消费 |
| 7 | 自动打断行为 | **彻底移除**，「取消旧任务」只能通过「立即发送」按钮触发 |

## 4. 技术选型

| 选型点 | 选择 | 依据 |
|--------|------|------|
| 卡片按钮回调接收 | SDK 长连接 `EventDispatcher` 注册 `card.action.trigger`（`@larksuiteoapi/node-sdk@^1.73.0`，`EventDispatcher.register<T>` 泛型扩展支持） | 与现有 `im.message.receive_v1` 共用同一 WSClient，不需要暴露公网 HTTP 回调端点，不引入新部署面 |
| 回调解析 | SDK 类型 `RawCardActionEvent`（`context.open_message_id` / `operator.open_id` / `action.value`） | 官方类型定义齐备 |
| 队列存储 | MySQL 新表 `feishu_inbound_queue`（Flyway `V088__feishu_inbound_queue.sql`） | 桌面端的 `message_queue` 表面向 WS 协议的 UI 自助队列（排序/编辑/折叠），生命周期与字段模型均不同；独立建表做领域隔离，互不牵连 |
| 双实例安全 | 行级 CAS 认领（`UPDATE ... SET status='RUNNING' WHERE id=? AND status='QUEUED'`，affectedRows=1 才消费） | 与 `claimInboundMessage` 同款模式，蓝绿部署窗口期防重复消费 |
| 执行编排 | 复用 `agent-inbound-handler` 的会话锁 + `agentLoop.registerCancelFlag`，新增队列消费钩子 | 改动收敛在 feishu 域 |

## 5. 现状分析（相关代码索引）

| 模块 | 位置 | 与本需求的关联 |
|------|------|----------------|
| 长连接事件入口 | `backend-ts/src/feishu/monitor.service.ts` `createFeishuBotHandle` | 需增加 `card.action.trigger` 注册 |
| 入站处理 | `backend-ts/src/feishu/inbound-processor.ts` | 上层已完成 claim 去重/授权/上下文拼装，onMessage 返回后发文本回复；排队场景返回 null 即可不产生文本回复 |
| 执行编排（待改造核心） | `backend-ts/src/feishu/agent-inbound-handler.ts` | 现有 locks/cancelFlags/generations 三件套实现「到达即打断」；保留 locks 与 cancelFlag 注册，删除代际打断 |
| 进度卡片 | `backend-ts/src/create-app.ts` `buildFeishuProgressCard` / `createFeishuProgressCard`（支持 `existingMessageId` PATCH 分支）、`backend-ts/src/feishu/card-progress-listener.ts` | 排队卡→进度卡的升级复用 `existingMessageId` PATCH 路径；终态文案需区分「打断」与「自然取消」 |
| 崩溃恢复 | `backend-ts/src/harness/core/crash-recovery-runner.ts` | 已有 `onExecutionFinished` 收尾钩子（`recoverSession` 的 finally 中调用），用于崩溃路径的消费接力 |
| Shell 管理 | `backend-ts/src/create-app.ts` `onGenerationCancelled` → `shellManager.closeByConversation` | 打断回调从「代际取消」迁到「立即发送」路径复用 |
| 入站去重 | `feishu/message.service.ts` `claimInboundMessage` | 事件级去重已在队列上游完成，队列表的 `(bot_id, message_id)` 唯一键做二次保险 |

## 6. 总体设计

### 6.1 会话级状态机

```
                    ┌────────────────────────────────────────────┐
                    │            SESSION EXECUTION SLOT          │
   消息到达          │                                            │
      │             │   IDLE ──claim队首──► RUNNING ──终结──┐     │
      ├─ 会话IDLE ──┤   ▲                                  │     │
      │             │   └────── drainNext() ◄──────────────┘     │
      │             └────────────────────────────────────────────┘
      │                          ▲
      └─ 会话BUSY ─► 入队(QUEUE) ─┘
                       │  「立即发送」→ 调整rank + 打断RUNNING → 本条抢下一次drain
                       │  「取消本次任务」→ status=CANCELLED → 出局
                       └─ 轮到自己 → status=RUNNING（CAS）→ PATCH卡片为进度卡 → 执行
```

每条队列行的状态流转：`QUEUED → RUNNING → (行删除)`；`QUEUED → CANCELLED → (行删除)`。

### 6.2 主流程时序（忙时入队）

```
用户消息 D 到达
 → InboundProcessor.process（授权/群上下文/引用解析，不变）
 → AgentFeishuInboundHandler.onMessage
    ├─ 会话空闲？──是──► 原直发路径：buildMessage → saveUserMessage → execute → 回复
    └─ 会话繁忙
         ├─ buildMessage(context)（媒体下载此刻完成，产物固化）
         ├─ INSERT INTO feishu_inbound_queue(status='QUEUED', rank=max+1, payload=...)
         ├─ 发送排队交互卡片，回填 card_message_id
         └─ return null（无文本回复）

A 任务结束（COMPLETED/FAILED/CANCELLED）
 → handler 执行收尾 finally / CrashRecoveryRunner.onExecutionFinished
 → FeishuTaskQueue.drainNext(sessionId)
    ├─ CAS 认领队首：status QUEUED→RUNNING
    ├─ PATCH 排队卡 → 进度卡（'任务已接收，正在准备执行。'）
    ├─ 重置 phase=RUNNING → saveUserMessage(payload) → prepareMessage → execute
    └─ 循环直至队列为空
```

### 6.3 按钮回调时序（card.action.trigger）

```
按钮点击 → EventDispatcher('card.action.trigger')
 → 解析 action.value = { kind:'feishu_queue', queueId, act:'run'|'cancel' }
 → 按 queueId 查队列行（行不存在 → toast「消息已失效，请重新发送」）
 → operator.open_id !== sender_open_id → toast「仅消息发送者可操作」
 → act='cancel'
    ├─ CAS QUEUED→CANCELLED（失败＝已开始执行 → toast「该消息已开始执行」）
    └─ PATCH 卡片为「已取消本次任务」终态 + 移除按钮 → DELETE 行
 → act='run'
    ├─ 行已 RUNNING/终态 → toast「该消息已在执行」
    ├─ rank_no = 本会话当前最小 rank − 1（跳队首）
    ├─ PATCH 卡片为「已插队，正在切换执行…」
    └─ 打断当前执行：cancelFlag.set(true) + shellManager.closeByConversation(sessionId)
       （当前任务收尾钩子 drainNext 会自动认领本条开始执行）
```

## 7. 数据库设计

新增 `backend-ts/db/migration/V088__feishu_inbound_queue.sql`：

```sql
CREATE TABLE feishu_inbound_queue (
    id              BIGINT       NOT NULL AUTO_INCREMENT,
    bot_id          BIGINT       NOT NULL COMMENT '飞书Bot应用ID(feishu_bot.id)',
    session_id      BIGINT       NOT NULL COMMENT '所属会话ID',
    message_id      VARCHAR(64)  NOT NULL COMMENT '飞书原始消息messageId',
    card_message_id VARCHAR(64)  NULL     COMMENT '排队交互卡片messageId(按钮定位键)',
    sender_open_id  VARCHAR(64)  NOT NULL COMMENT '原消息发送者open_id(按钮鉴权)',
    mao_user_id     BIGINT       NULL     COMMENT '绑定的mao用户ID(executionUserId)',
    rank_no         BIGINT       NOT NULL COMMENT '消费排序号(会话内越小越先)',
    status          VARCHAR(16)  NOT NULL DEFAULT 'QUEUED' COMMENT 'QUEUED/RUNNING/CANCELLED',
    payload         MEDIUMTEXT   NOT NULL COMMENT 'buildMessage产物+入站上下文快照(JSON)',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_bot_message (bot_id, message_id),
    KEY idx_session_status_rank (session_id, status, rank_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='飞书入站任务队列';
```

约定：

- `payload` 存 `buildMessage()` 的完整产物（`string | ContentPart[]`）及消费所需的上下文字段（chatType、senderLabel、chatId 等）。媒体在入队时一次性下载落盘，消费时不重复下载。data URI 图片随 payload 一起入库——与现状一致（现路径同样会把含 data URI 的用户消息写入 `session_messages`），不引入新的量级。
- `rank_no`：入队取 `max(rank_no)+1`；插队取 `min(rank_no)-1`。用 BIGINT 保证可反复减一。重启恢复时按原 rank 保序（含已发生的插队结果）。
- `uk_bot_message(bot_id, message_id)`：对 `claimInboundMessage` 的二级保险，事件重投不会重复入队。
- 终态行（消费完成/取消）即时 `DELETE`，不做历史归档；启动恢复只捞 `status IN ('QUEUED','RUNNING')`。

## 8. 后端详细设计

### 8.1 新增 `backend-ts/src/feishu/inbound-queue.service.ts`

```ts
export class FeishuTaskQueueService {
  enqueue(item): Promise<FeishuInboundQueueRow>;      // 追加到队尾
  jumpToFront(queueId): Promise<boolean>;             // rank=min-1，仅 QUEUED 生效
  cancel(queueId): Promise<'CANCELLED'|'ALREADY_STARTED'>; // CAS QUEUED→CANCELLED
  delete(queueId): Promise<void>;                     // 终态清理
  claimNext(sessionId): Promise<Row|null>;            // 最小rank+CAS认领 QUEUED→RUNNING
  complete(queueId): Promise<void>;                   // 执行收尾删行
  hasPending(sessionId): Promise<boolean>;
  hydrate(): Promise<number[]>;                       // 启动恢复：对RUNNING行按「消息是否已落库」分支(已落库→删除行由崩溃恢复重放；未落库→复位QUEUED重新消费)，返回有待消费QUEUED行的会话集合，
                                                      // 返回有待消费行的sessionId集合
  findByCardMessage(cardMessageId): Promise<Row|null>;
}
```

配套 `inbound-queue.repository.ts`，所有状态变更均带 `WHERE status=?` 条件以实现 CAS 语义。

### 8.2 重构 `agent-inbound-handler.ts`

- **删除**：`generations` 代际计数、「新消息先取消上一代」的逻辑、`CancelFlag` 注释中对微信时序的对齐描述。
- **保留**：会话锁 promise 链（执行串行化的底层保障）、`createCancelFlag/releaseCancelFlag`。
- 新增内存 `busy: Set<sessionId>`：`onMessage` 到达时判断空闲/繁忙；空闲走原直发路径并在结束时触发 `drainNext`。
- 繁忙路径：buildMessage → enqueue → 发排队卡 → return null。
- `drainNext(sessionId)`（幂等，可被多处调用）：若会话 busy 则直接返回；否则 `claimNext` 成功者进入执行（busy 置位 → PATCH 排队卡为进度卡 → `updatePhase('RUNNING')` → saveUserMessage → prepareMessage → execute），finally 解除 busy 并递归 `drainNext`。
- 被打断（「立即发送」触发 cancelFlag）的收尾分支：进度卡 `cancel()` 文案改为「已被下一条指令中断。」，之后 `cleanupIncompleteTail` 照旧，最后 `drainNext`。

### 8.3 卡片动作处理：新增 `backend-ts/src/feishu/card-action.service.ts`

- 在 `monitor.service.ts` 的 `eventDispatcher.register({})` 中追加 `'card.action.trigger'` 处理器（泛型扩展，`as never` 规避内置类型缺项），校验 `header.appId` 与 Bot 一致（与消息事件同规则）。
- 按 §6.3 时序分派：查行 → 鉴权 → CAS → PATCH 卡片 → 打断/通知。
- 结果反馈一律通过 PATCH 卡片呈现；toast 仅用于无效操作的轻提示（利用卡片回调响应体回传 toast JSON，失败静默不影响主流程）。
- 按钮定义：`action.value = JSON.stringify({ kind: 'feishu_queue', queueId, act })`，卡片 schema 2.0，`config.update_multi=true` 与进度卡一致。

### 8.4 排队卡片构建（并入 `create-app.ts` 卡片构建区）

```
[markdown] ⏳ **任务排队中**
           你有一条新消息进入队列，当前任务执行完成后将自动开始处理：
           [quote] {senderLabel}：{消息摘要≤60字}
           [markdown] 队列位置：第 {n} 位
[action]   [primary「立即发送」value={act:'run'}] [default「取消本次任务」value={act:'cancel'}]
```

- 插队成功后 PATCH 为：`🚀 已插队，正在中断当前任务并执行这条消息…`
- 取消成功后 PATCH 为：`✖️ 这条消息已取消，未进入执行。`（按钮随整体卡片重写移除）
- 排队卡发送失败时降级发送纯文本「当前任务执行中，你的消息已排队等待处理。」，保证用户知情（此分支无按钮，仅提示）。

### 8.5 启动恢复与消费接力

- 新增启动逻辑（create-app.ts 组装处，仿 `pendingBindingMessages.listRecoverable` 现有模式）：
  1. `hydrate()`：对崩溃时在途执行的 `status='RUNNING'` 行按「消息是否已写入会话历史」分支——已落库则删除该行（消息由 CrashRecovery 从历史重放、不重插用户消息，删除避免重复消费）；未落库则复位为 `QUEUED`（消息从未持久化、无法恢复，由队列重新消费，保证不丢）。仅保留 `QUEUED` 行待消费；
  2. 返回的每个 `sessionId` 挂一个延迟探测 `drainNext(sessionId)`。
- 接线 `CrashRecoveryRunner` 的 `onExecutionFinished(sessionId, userId)` 钩子（构造函数既有参数）：钩子内调用 `FeishuTaskQueue.drainNextIfFeishuSession(sessionId)`（内部先查队列是否有 pending 行，非飞书会话零开销返回）。
- 链路闭环验证点：重启 → CrashRecovery 续跑被中断的旧任务 A → A 收尾触发钩子 → 队列中的 B、C 依次被消费。

### 8.6 竞态规则（定案）

| 场景 | 行为 |
|------|------|
| 点击时该消息已被 drain 认领开始执行 | CAS 失败，toast「该消息已开始执行」 |
| 「立即发送」与当前任务自然终结几乎同时 | 当前任务先终结则无可打断对象，drain 正常消费队首（若被点击者是队首，等于正常开跑）；打断先生效则走插队打断路径。两种先后结果均符合语义，无需额外协调 |
| 多次快速连点同一按钮 | 第一次 CAS/PATCH 生效，后续命中「已在执行/已失效」分支，天然幂等 |
| 双实例同时 drain 同一会话 | 行级 CAS 保证单行单实例消费；实例内 busy Set 保证会话串行 |
| 排队期间会话被管理员删除 | 执行时 session 不存在报错，按现有 catch 链路记 FAILED、PATCH 卡片错误提示、删队列行 |

## 9. 测试计划

单元测试（Vitest，遵循 `backend-ts/src/**/*.spec.ts` 约定）：

1. `inbound-queue.service.spec.ts`：enqueue 排序、jumpToFront 仅影响本会话、cancel CAS 分支、claimNext 并发竞争（模拟两次认领只成功一次）、hydrate 删除 RUNNING 行并去重返回会话、`(bot_id,message_id)` 唯一键拒绝重复入队。
2. `agent-inbound-handler.spec.ts` 更新：
   - 忙时新消息**不**触发旧任务 cancelFlag（回归锁定：移除自动打断）；
   - 忙时入队、返回 null、卡片创建失败的文本降级；
   - 任务结束后按序 drain 两条排队消息，各自 saveUserMessage 与 execute；
   - 被「立即发送」打断的旧任务走 cleanupIncompleteTail 且卡片文案为新文案；
   - 排队期间第三条消息到达不影响前两条顺序。
3. `card-action.service.spec.ts`：动作分发、open_id 鉴权（非本人 → toast、不改动状态）、cancel/run 各 CAS 失败分支、appId 不匹配忽略。
4. `monitor.service.spec.ts`：注册 `card.action.trigger` 处理器可达。

手工验收清单：

- [ ] 私聊：忙时连发三条，各收一张排队卡；A 完成后 B、C 依次自动执行且卡片逐张升级、终态正确
- [ ] 群聊：多用户交叉排队，各消息按钮仅本人可操作，他人点击收到 toast
- [ ] 对中间一条点「立即发送」：当前任务进度卡显示「已被下一条指令中断」，目标消息跳队首执行，其余保持原序
- [ ] 点「取消本次任务」：卡片变已取消态，当前任务不受影响，后续队列照常推进
- [ ] 手动 restart-backend 后：在途 RUNNING 行被清理（消息由崩溃恢复重放）、队列继续消费、卡片按钮依然可用
- [ ] 重启期间点旧卡片按钮：toast「消息已失效，请重新发送」

Playwright 不涉及（飞书为外部通道，自动化依赖真实租户）。

## 10. 落地清单

代码（均在 `backend-ts/`，不改前端五端其余部分）：

- [ ] `db/migration/V088__feishu_inbound_queue.sql` 新建表
- [ ] `src/feishu/types.ts`：队列行类型、`FeishuCardActionContext`、handler options 调整（移除 onGenerationCancelled → 新增 onCancelRunning/interrupt 注入）
- [ ] `src/feishu/inbound-queue.repository.ts` + `.spec.ts` 新建
- [ ] `src/feishu/inbound-queue.service.ts` + `.spec.ts` 新建
- [ ] `src/feishu/agent-inbound-handler.ts` 重构 + spec 更新
- [ ] `src/feishu/card-action.service.ts` + `.spec.ts` 新建
- [ ] `src/feishu/monitor.service.ts` 注册 `card.action.trigger`
- [ ] `src/feishu/card-progress-listener.ts`：`cancel()` 文案与「打断/自然取消」区分参数
- [ ] `src/create-app.ts`：排队卡构建与发送、Bot ID 补齐、CrashRecoveryRunner onExecutionFinished 接线、启动 hydrate 挂载
- [ ] 全量回归：`cd backend-ts && npm test`；`npm run build`

部署与配置：

- [ ] Flyway 迁移随启动自动执行（FLYWAY_ENABLED 已有开关，无需额外动作）
- [ ] **飞书开放平台人工配置（上线前置条件）**：每个已启用的 Bot 应用，在开发者后台「事件与回调」中将卡片交互回调的接收方式设置为**使用长连接接收**（与现有 `im.message.receive_v1` 同一连接通道），否则按钮点击事件不会下发
- [ ] `/opt/mao` 线上目录拉取代码、`restart-backend.sh` 重启，观察 `hydrate` 日志与首批消息冒烟

发版记录：

- [ ] 完成后在根 `CHANGELOG.md` 顶部新增版本小节，backend-ts 条目说明新交互（排队卡片、双按钮、移除自动打断）

风险备忘：无上限 FIFO 意味着长时间无人值守的会话可能连续消耗较多 token（一条接一条自动执行）；如后续观察到滥用，再评估会话级限量策略，本期不做。
