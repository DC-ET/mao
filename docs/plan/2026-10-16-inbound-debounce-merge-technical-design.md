# 飞书/钉钉/微信入站消息防抖合并技术方案

## 1. 需求背景

### 1.1 场景

用户在 IM 通道里「转发一条消息给机器人，同时附上自己的指令」，或快速连发多条消息（"看看这个" + 截图、分两条打完一句长指令）。飞书、钉钉会把这些内容作为**多条独立消息**投递，微信长轮询也会拉到**多条**。它们几乎同一时间发出，用户心智里是同一个请求，但当前三端都会拆成多次任务执行。

### 1.2 三端现状与问题

| 通道 | 投递形态 | 当前行为 | 用户感知 |
|---|---|---|---|
| 飞书 | WS 长连接，转发（`merge_forward`）与附言（`text`）是两条 `im.message.receive_v1` 事件 | 两条消息各自走完整链路：先到的一条立即开跑，后到的一条发现会话忙 → 入 FIFO 队列 → 任务结束后作为**第二个任务**执行 | 两张进度卡、两轮回复；指令与转发内容被拆开处理 |
| 钉钉 | `dingtalk-stream` 长连接回调，同样是两条事件 | 与飞书同构：busy 检查 + 队列逐条执行 | 同上 |
| 微信 | `getUpdates` 长轮询拉到两条消息 | **取代语义**：后到的消息 bump generation、取消前一条执行，并把前一条已落库的 USER 消息**回滚删除**，只执行后一条 | 更糟——先到的内容（如转发原文）直接丢失，机器人只看到后一条 |

微信的取代语义是刻意设计（monitor.service.ts:137-139 注释："后一条消息可在前一条 Agent 执行期间重入 handler，触发纠偏取代逻辑"），用于用户发文纠正前一条，**间隔较远的连发必须保留该语义**；本方案只合并 1 秒内到达的连续消息。

### 1.3 诉求

对三条通道做统一的**固定 1 秒合并窗口**：同一发送者在同一会话（群聊含话题）1 秒内到达的连续触发消息，合并为**一个任务**处理，而不是拆分/互相取代。

## 2. 需求描述

### 2.1 要做的

1. 三端各自实现按「账号 + 会话（+ 话题）+ 发送者」为键的固定时长合并窗口（默认 1000ms，可配置，配 0 即关闭）。
2. 窗口内的文本类触发消息合并为**一次** `handler.onMessage` 触发：一次进度卡、一次执行、一次回复。
3. 合并顺序 = 到达顺序；首条消息进窗启动定时器，批内后续到达**不延长**窗口（固定窗口，延迟可预期）。
4. 完整保留现有机制：事件级去重（claim）、群消息日志与水位线、合并转发展开、纯文件 ingest（不触发）、`---` 新建会话与 p2p 引用切换指令、FIFO 队列与接力消费、微信超过 1 秒的纠偏取代语义。
5. 窗口为纯内存态，**零数据库迁移**（不动 claim 表、队列表、群日志表结构）。
6. 崩溃语义不劣于现状（详见 §6.6 与 §10）。

### 2.2 明确不做的

| 不做项 | 说明 |
|---|---|
| 滑动窗口 / 批内到达延长窗口 | 固定窗口，延迟上限可预期 |
| 跨发送者、跨会话合并 | 窗口键含发送者与会话；群里两个不同用户 @ 机器人仍是两个任务 |
| 图片/文件媒体体跨消息合并（飞书/钉钉） | 飞书图片下载按「图片所在消息的 messageId + imageKey」调接口（create-app.ts:2214-2226），跨消息合并需要改 `downloadMedia` 签名。v1 图片/文件/语音/视频消息到达即冲刷窗口，随后单独走现有路径；微信 context 天然是多媒体的（item_list），随批合并，无此限制 |
| 桌面 / Web / OpenAPI / Embed 等入口 | 同步请求响应模型，不存在拆包问题 |
| 窗口期的"正在合并"中间态提示 | 1 秒可感知但可接受，不增加卡片闪烁 |
| 改队列表 / claim 表 / 群日志表结构 | 零迁移 |

## 3. 已确认的决策记录

- **D1 固定窗口 1s（非滑动）**：飞书"转发 + 附言"两条事件通常 200ms 内到齐，1s 有余量；固定窗口让"最坏延迟 = 1s"可预期。
- **D2 窗口键 = 账号 + 会话 +（群的）话题 + 发送者**：只合同一发送者的连续消息；机器人自身消息不进窗。
- **D3 准入策略**：仅「文本类且会触发」的消息入窗。飞书：`text`/`merge_forward`/`post`/`interactive`（群聊还需 @ 命中或话题会话免 @）；钉钉：`text`/`richText`（群聊需 @）；微信：全部（含图片/文件）。豁免（到达即冲刷窗口后单独处理）：图片/文件/语音/视频等媒体消息（飞书/钉钉）、`---` 新建会话指令、p2p 引用切换消息（parentId 非空，飞书）。
- **D4 飞书/钉钉采用「到达即准备、flush 即触发」**：claim、群日志、富化、合并转发展开等重活仍在消息到达时完成（与现状一致），窗口只挂起 `handler.onMessage` 这一个触发点；批内各条消息的 claim 完成/释放时机随合并触发后移（状态机不变）。
- **D5 微信采用「合成消息记录」**：窗口挂在 `enqueueInboundMessage`（claim 落库）之后、`processInboundMessage` 之前；flush 时把批内多条 message 合成**一条** message record（拼接 `item_list`），以批内首条的 messageKey 走既有处理路径，其余 key 标记 DONE。`processInboundMessage`/`processClaimed` 零改动。
- **D6 共享窗口组件落 `backend-ts/src/common/`**：generic 实现（按键缓冲、messageId 去重、固定定时器、幂等 flush、flushAll），三端各自注入 `keyOf`/`canJoin`/`onFlush` 适配。
- **D7 开关即配置**：`windowMs=0` 时 `submit` 直接单条触发，行为与今天完全一致——回滚只需改配置重启。
- **D8 崩溃语义**：飞书/钉钉窗口内崩溃 = 该批消息不执行（claim 停留 CLAIMED，与现状"claim 后、执行前崩溃"同损，不劣化）；微信窗口内崩溃由既有重放器回收（claim 已落库），重放不走窗口、按条执行。

## 4. 现状分析（相关代码索引）

### 4.1 飞书

| 环节 | 位置 |
|---|---|
| 事件入口（WS 长连接，fire-and-forget，ack 先行） | `feishu/monitor.service.ts:40-45, 47` |
| 入站处理主流程 | `feishu/inbound-processor.ts:72`（p2p 分支 :84-97；群分支 :98-175，:117 落日志、:135 合并转发同步展开、:153 flushPendingEnrichments、:154 buildGroupContext） |
| claim 去重（10 分钟窗口） | `feishu/message.repository.ts:143` |
| 任务触发与忙判 | `feishu/agent-inbound-handler.ts:470`（:484 isBusyOrRecovering → :699 enqueueMessage；:565 drainNext 接力） |

### 4.2 钉钉

| 环节 | 位置 |
|---|---|
| 事件入口（stream 回调，fire-and-forget） | `dingtalk/monitor.service.ts:64-69` |
| 入站处理主流程 | `dingtalk/inbound-processor.ts:22`（:24 claim、:33 群未 @ 忽略、:39 recordGroupInbound、:57 buildGroupContext） |
| 任务触发与忙判（与飞书同构） | `dingtalk/agent-inbound-handler.ts:216`（:223 busy → :364 enqueueMessage；:388 drainNext） |
| `---` 新建会话（取消活跃会话 + 丢弃旧队列） | `dingtalk/agent-inbound-handler.ts:191` |

### 4.3 微信

| 环节 | 位置 |
|---|---|
| 长轮询循环（先全部入队保证游标安全，再 fire-and-forget 处理） | `weixin/monitor.service.ts:126-142, 186` |
| 入队 / 处理 / claim 表（心跳 + 重放器） | `weixin/inbound-processor.ts:39, 60, 148` |
| 取代语义（generation + 取消 + 回滚删除前一条 USER 消息） | `weixin/agent-inbound-handler.ts:103`（:118-119、:143、:150-152、:166-171、:248、:331） |

## 5. 总体设计

```
消息到达（事件 / 轮询）
   │
   ▼
准入判断 canJoin（键 = 账号+会话(+话题)+发送者；文本类且会触发）
   ├─ 否（媒体消息 / `---` / p2p 引用切换）──► 先冲刷同键在途窗口（保序）──► 该消息单独走现有路径
   └─ 是 ─► 进入该键窗口缓冲（messageId 去重）
                │  首条进窗启动 1s 定时器（unref，批内到达不延长）
                ▼
        定时器到点 / 被冲刷 ─► flush（幂等）
                ▼
        合并批内消息为一次触发：
          · 飞书/钉钉：拼接 N 个已准备上下文 → 一个 InboundContext → handler.onMessage ×1
          · 微信：合成一条 message record → processInboundMessage ×1， absorbed keys markDone
                ▼
        既有下游原样不动：busy 检查 → 执行 / 入队 → 进度卡 → 回复
```

三端共享同一个窗口组件；差异只在键的构造、准入策略、合并输出三处。

## 6. 详细设计

### 6.1 共享窗口组件 `common/inbound-merge-window.ts`

```ts
export interface InboundMergeWindowOptions<E> {
  /** 窗口时长（ms）。0 = 禁用：submit 直接单条触发，行为与现状一致。 */
  windowMs: number;
  /** 窗口键：账号 + 会话（+ 话题）+ 发送者。 */
  keyOf: (entry: E) => string;
  /** 批内去重（飞书/钉钉用 messageId；微信用 messageKey）。 */
  dedupeKeyOf: (entry: E) => string | null;
  /** 准入：返回 false 的消息不并入窗口（先冲刷在途批，再单独触发）。 */
  canJoin: (entry: E) => boolean;
  /** 合并触发：批内条目已按到达有序；实现方负责合并与 claim 收尾。 */
  onFlush: (batch: E[]) => Promise<void>;
}

export class InboundMergeWindow<E> {
  submit(entry: E): Promise<void>;
  flushAll(): Promise<void>;   // shutdown 时 best-effort 冲刷全部在途窗口
}
```

职责与约束：

- 每键独立状态 `{ entries, timer, flushing }`；定时器 `unref()`，不阻止进程退出。
- `submit`：`canJoin=false` → 先 `await` 同键在途 flush（幂等，保序），再 `onFlush([entry])`；`canJoin=true` → 入缓冲（按 `dedupeKeyOf` 去重，同 messageId 重复投递直接丢弃），首条启动定时器。
- flush 幂等：定时器到点与"豁免消息冲刷"竞争时只执行一次，后者 await 前者。
- 单条批（`windowMs=0` 或被豁免消息）复用同一条 `onFlush` 路径，合并逻辑对 N=1 为恒等。
- `flushAll` 供 `monitor.shutdown()` 调用；失败仅记日志不抛出。

### 6.2 飞书接入

**process() 拆分**（`feishu/inbound-processor.ts:72`）：

- `prepareOne(event)`（到达时执行，逻辑与现状一致）：claim → normalizeText → p2p：authorizeSender / resolveUserId / expandMergeForwardText / resolveQuoted；group：recordGroupMessage、merge_forward 同步展开（persistExpandedMergeForward）、authorize、resolveUserId、resolveQuoted。产出 `PreparedTrigger`（含归一化事件 + quotedContext + senderLabel + 该条 messageId）。
- `triggerOne(prepared)`（原触发点）：group 侧 flushPendingEnrichments + buildGroupContext（**flush 时统一做一次**）→ 组装 context → `handler.onMessage` → reply。
- 现状 `process()` = prepareOne + triggerOne；窗口路径 = prepareOne 后 `window.submit(prepared)`，flush 回调里合并后 triggerOne 一次。

**合并规则**（批内 N 个 PreparedTrigger → 一个 `FeishuInboundContext`）：

- `text`：各条文本按到达顺序以空行拼接（merge_forward 已展开为摘录）；p2p 直接作为用户消息正文；群聊共用一个 `【用户消息】` 块（同一发送者，senderLabel 取首条）。
- `messageId`/`parentId`/`rootId`/`threadId`/`senderLabel`/`maoUserId`：取首条（同键同发送者，除 messageId 外本一致；p2p 引用切换消息已豁免入窗）。
- `quotedContext`：非空者以空行拼接。
- `groupContext`：flush 时以批内**末条** messageId 调一次 `buildGroupContext`（批内各条 prepare 时已落日志，水位线包含全部）。
- `imageKeys`：v1 不跨消息合并（媒体消息不入窗，见 D3）。

**claim 收尾**：合并触发返回后，批内逐条 `completeInboundMessage`；触发抛错则逐条 `releaseInboundMessage`（与现状单条 finally 语义一致，只是时机随批次后移）。

**准入策略装配**：`canJoin` 需要的判断（`isNewSessionCommand`、p2p parentId、媒体类型）经 processor options 在 `create-app.ts` 注入，不在窗口组件里写死通道知识。

### 6.3 钉钉接入

与 6.2 同构，差异仅字段名与两处细节：

- 上下文字段：`conversationId`/`senderUserid`/`quotedText`/`downloadCodes`/`msgtype`；窗口键 `accountId + conversationId + senderUserid`。
- `---` 必须豁免（`agent-inbound-handler.ts:191` openNewSession 会取消活跃会话并 dropQueued，混入批次会让指令失效）。
- 钉钉无 p2p 引用切换（P2pSessionControl 无 findSessionByMessageId），豁免项只此一条；quotedText 合并规则同飞书。
- `buildMessage` 的 persisted/forModel 双份模型（群上下文只进模型不进库）不受影响——合并发生在 context 层，buildMessage 仍各跑一次。

### 6.4 微信接入

**窗口位置**：`weixin/monitor.service.ts:139-142` 的 fire-and-forget 处理循环处，`processInboundMessage` 调用改为 `window.submit({ messageKey, message })`。claim（enqueueInboundMessage）保持循环第一步不动——**游标推进前消息必然已在表中**的既有不变量不变（D5）。

**准入**：同账号同 `from_user_id` 的全部消息可入窗（含图片/文件，context 天然多媒体）；空消息（无正文无媒体）也入窗，合并后自然为空、由 `processClaimed` 现有逻辑忽略（inbound-processor.ts:158-162），不为难窗口策略。

**flush 合成**（D5）：

```ts
const synthetic = {
  from_user_id: 首条.from_user_id,
  context_token: 批内最后一条非空 context_token,   // 回复发送目标，同用户同会话一致
  item_list: [
    { type: 1, text_item: { text: 各条 extractMessageBody 结果按序空行拼接 } },  // 语音转文字已含在内
    ...各条的 image / file items（原样保留，下载与存储逻辑复用）
  ],
};
await processInboundMessage(accountId, synthetic, 首条.messageKey);   // 既有路径零改动
for (const absorbed of 其余 keys) await repo.markDone(accountId, absorbed);  // 已被合并处理
```

**重放路径**（`reclaimStuckMessages`）不走窗口，按条执行——窗口只在正常投递路径上。

**语义保持**：间隔 >1s 的两条消息经两次独立 flush，仍是两次 onMessage，第二次 bump generation 取消/回滚第一次——**纠偏取代语义完全保留**；只有 1s 内的连续消息被合并，前一条不再被删除。

### 6.5 配置（`config/app-config.ts`）

| 配置 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `cfg.feishu.bot.mergeWindowMs` | `FEISHU_BOT_MERGE_WINDOW_MS` | 1000 | 0 = 关闭窗口 |
| `cfg.dingtalk.mergeWindowMs` | `DINGTALK_BOT_MERGE_WINDOW_MS` | 1000 | 0 = 关闭窗口 |
| `cfg.weixin.mergeWindowMs` | `WEIXIN_MERGE_WINDOW_MS` | 1000 | 0 = 关闭窗口 |

### 6.6 崩溃与边界语义

- 飞书/钉钉：窗口内崩溃 → 该批不执行，claim 停留 CLAIMED（与现状"claim 后执行前崩溃"同损，不劣化）；shutdown 时 `flushAll` best-effort 冲刷减少丢失。
- 微信：窗口内崩溃 → claim 已落库，心跳停止，10 分钟后重放器回收按条重放（D8）。
- 窗口与忙碌叠加：flush 时会话忙 → 合并消息作为**一条**队列行入队，排队卡晚 1s 发出，可接受。
- 合并后会话历史中是一条合并 USER 消息（非两条），任务列表/历史展示为一次执行——这正是需求目标。

## 7. 数据库设计

无新表、无迁移。`feishu_inbound_event`（claim）、`feishu_inbound_queue`（队列）、`feishu_group_message_log`（群日志）、微信 claim 表结构均不变。

## 8. 测试计划

**共享组件**（`common/inbound-merge-window.spec.ts`）：

1. 窗口期内多条 → 一次 onFlush，顺序为到达顺序；
2. 单条 / `windowMs=0` → 立即单条 onFlush（恒等）；
3. `canJoin=false` 消息到达 → 先冲刷在途批（onFlush 先行发生）再单独触发；
4. 定时器到点与豁免冲刷竞争 → onFlush 只执行一次；
5. 同 messageId 重复投递 → 去重丢弃；
6. 不同键互不影响；
7. `flushAll` 冲刷全部在途。

**飞书**（`feishu/inbound-processor.spec.ts`、`agent-inbound-handler.spec.ts` 扩充）：

1. 两条文本 1s 内 → 一次 onMessage，正文拼接，两条 messageId 均 complete；
2. 单条 → 约 windowMs 后一次 onMessage；
3. 图片消息到达 → 窗口先冲刷（任务先跑），图片单独触发；
4. `---` 到达 → 窗口先冲刷，指令单独生效；
5. p2p 引用切换消息 → 不入窗；
6. 不同发送者同群 1s 内 → 两次触发；
7. 群聊两条 @ → 两条群日志 + 一次触发，groupContext 含两条；
8. 合并转发 + 附言 → 一次触发，摘录与附言在同一条用户消息内；
9. 窗口期同 messageId 重投 → DB claim 去重（到达即 claim，D4）；
10. `windowMs=0` → 既有全部用例原样通过（回归）。

**钉钉**：镜像飞书用例 1/2/3/4/6/10（无引用切换项）。

**微信**（`weixin/inbound-processor.spec.ts`、`monitor.service.spec.ts` 扩充）：

1. 两条消息 1s 内同用户 → 合成一条 item_list、一次 onMessage、absorbed key markDone、无回滚删除；
2. 文本 + 图片 1s 内 → 合并为一条（含 data URI）；
3. 间隔 >1s → 两次独立处理，第二次取代取消第一次（纠偏语义回归）；
4. 空消息入窗 → 合并后被忽略，不报错；
5. `windowMs=0` → 既有用例原样通过（回归）；
6. 窗口内崩溃场景由重放器按条重放（既有用例覆盖）。

## 9. 落地清单（实现时同任务完成）

1. 后端代码：`common/inbound-merge-window.ts`（含单测）；三端 processor/monitor 接入与 spec 扩充；`create-app.ts` 装配窗口与准入策略、`monitor.shutdown()` 接 `flushAll`；`config/app-config.ts` 三个配置项。
2. `CHANGELOG.md` 顶部「后端」小节写入用户可见行为变化（触发延迟与合并）。
3. `skills/mao-cli/reference/` 下飞书/钉钉/微信通道说明同步（触发时机、合并行为、配置项）。
4. 部署文档如需补充三个环境变量（`DEPLOY.md` 配置表，如有）。

## 10. 已知限制（本期接受，不解决）

1. **所有触发消息统一 +1s 才开跑**：不只是转发场景，单条消息的进度卡也晚 1s 出现。这是固定窗口的固有代价；生产可先以 1000ms 上线观察，再按需调整。
2. **飞书/钉钉「图片/文件 + 文字」连发仍是两个任务**：媒体消息冲刷窗口后单独执行（D3）。需跨消息合并媒体时，后续扩展 `downloadMedia` 支持「按 (messageId, imageKey) 列表下载」即可，窗口合并层已就位。
3. 忙碌时排队卡发出晚 1s（窗口 + 队列叠加）。
4. 飞书/钉钉窗口内进程崩溃，该批消息不执行（与现状同损，见 6.6）；微信有重放器兜底。
5. 合并触发在会话历史中呈现为一条 USER 消息；若后续需要"逐条可见、执行合并"，需改消息持久化模型，本期不做。
