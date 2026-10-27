# 提案：记忆在对话里看得见、改得动 —— 长期记忆的就地回执与「记住这个」

> 长期记忆（0.0.2xx 实施）能力完整：自动收集、语义去重、注入提示词、上下文透视里能看到注入了哪几条。但用户在**对话现场**完全感知不到它：Agent 记住了什么不告诉你，你想让它记住一句话得切到设置页手抄，记错了要去列表里翻。记忆是「后台功能」，而它真正发生作用的地方是对话。

- 状态：已否决（2026-10-27），存档勿再评审
- 日期：2026-10-27
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（P1 约 2 人日、P2 约 1.5 人日、P3 约 1 人日；零迁移）
- 关联：`backend-ts/src/memory/`、`desktop/src/views/settings/MemoryView.vue`、`desktop/src/components/chat/MessageBubble.vue`、`desktop/src/composables/useStreamWS.ts`

## 1. 背景与现状

### 1.1 能力都在，对话里零露出（代码可查）

| 环节 | 现状 | 证据 |
|---|---|---|
| 自动收集 | 任务终态 fire-and-forget 抽取，最多 3 条，可新增或语义合并已有条目 | `memory-extraction.service.ts:103`、`MEMORY_EXTRACT_MAX_ITEMS = 3` |
| 收集结果通知 | **无**：抽取完成后不发 WS 事件、不写收件箱、不改会话 | `doExtract` 结尾 `persistCandidates` 后直接返回 |
| 来源追溯 | 表里有 `origin_session_id`，VO 也返回 `originSessionId` | `memory/types.ts` `MemoryItemVO` |
| 来源展示 | **MemoryView 不展示来源会话**，无法跳回「当时为什么记了这条」 | `MemoryView.vue` 无 originSession 引用 |
| 手动新增 | 只能在设置页「新增记忆」弹窗手打 | `MemoryView.vue:15` |
| 对话内入口 | 消息操作栏有编辑 / 添加到我的指令 / 复制 / 点踩 / Fork / 分享，**没有「记住」** | `MessageBubble.vue:168-243` |
| 默认开关 | 自动收集默认关闭，需用户主动去设置页打开 | `types.ts` 注释「无行视为关闭」 |

### 1.2 后果

- **信任问题**：用户不知道 Agent 记住了什么，就不敢开自动收集（默认关、入口深，开启率可想而知）；开了也会因为某次「它怎么知道这个」而关掉。
- **纠错成本高**：抽取记错了（比如把一次性的临时要求当成长期偏好），用户只有在后续某次回答变怪时才会察觉，再去设置页大海捞针。
- **主动表达成本高**：「以后汇报都用表格」这种话，用户说在对话里，模型这次照做了，但下次新会话又忘——除非自动收集恰好开着且恰好抽中。

### 1.3 一个真实场景

用户在会话里纠正 Agent：「我们的出货额一律用 act_pmt_gmv 口径，不要用 pmt_gmv」。Agent 改正了。第二天新会话又用了 pmt_gmv。用户不知道：自动收集是关的；就算开着，这条有没有被记住、被记成了什么样，也没有任何地方告诉他。

## 2. 目标 / 非目标

**目标**

1. **P1 收集回执**：自动收集产生新增 / 合并时，在该轮回复下方出现一行轻量回执「已记住 2 条 · 更新 1 条」，展开可见内容，每条就地「编辑 / 忽略」。忽略复用既有 `DISMISSED` 状态（同时进入抽取的负面约束集，下次不再抽同类）。
2. **P2「记住这个」**：消息操作栏加「记住」按钮；选中回复或自己消息中的一段文字时浮出同款入口。预填内容（截断到 500 字上限）、默认作用域（会话有 projectKey 时默认项目级），确认后带 `originSessionId` 落库。不依赖自动收集开关。
3. **P3 来源闭环与开启引导**：MemoryView 每条显示「来自：会话标题」可点击跳回（用 `originSessionId` + 既有 `locateMessageId` 定位）；自动收集关闭的用户在第一次手动「记住」后，回执里附一句「要让 Agent 自动收集吗？」一键开启（只问一次）。

**非目标**

- 不改抽取算法、注入条数、去重逻辑。
- 不做记忆命中统计 / 有效性打分（与已否决的「经验资产化」划清边界）。
- 不做团队共享记忆（已否决的「团队知识层」）。
- 不在回执里显示「本轮注入了哪些记忆」——那是上下文透视已覆盖的「向未来看」，本提案只管「向过去看：刚记了什么」。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 团队知识层（2026-10-19 否决） | 只动个人 USER / PROJECT 记忆，不新增 TEAM 作用域、不新增审核流。 |
| 经验资产化（2026-10-24 否决） | 不给记忆加命中、成败、过时标记；纯展示与编辑入口。 |
| 逐条点踩转经验（0.0.299 下线） | 不碰 `agent_experiences`、不从反馈生成任何东西；「记住」是用户显式写记忆。 |
| 业务词典（2026-10-24 否决） | 不做结构化术语；用户自己写的一句话就是一条普通记忆。 |

## 4. 方案

### 4.1 P1 收集回执

- 后端：`persistCandidates` 返回 `{ created: number[], updated: number[] }`；`doExtract` 末尾若非空，经 `streamingWsRegistry.send(userId, wsEvent('memory_captured', sessionId, { messageId, createdIds, updatedIds }))` 推送。`messageId` 取本轮最后一条 ASSISTANT 消息（抽取输入本来就是它）。
- 持久化回执：不新增表。回执来源是 `memory_item.origin_session_id = 会话 AND created_at/updated_at 落在该轮之后`——桌面端打开历史会话时按需查 `GET /v1/memory?originSessionId=&status=`（list 查询加一个可选过滤参数），把条目挂到对应轮次。WS 事件只负责实时出现，刷新后靠查询还原。
- 前端：`MessageBubble` 底部（引用来源区下方）加 `MemoryReceipt` 组件；折叠态一行，展开列条目 + 编辑 / 忽略。
- WS 事件类型按规范加入 `shared/contracts/src/ws.ts`。

### 4.2 P2「记住这个」

- 操作栏按钮 + 选区浮动按钮共用一个预填弹窗（复用 MemoryView 的创建弹窗组件，抽出为 `MemoryEditDialog`）。
- `POST /v1/memory` 增加可选 `originSessionId`（服务端校验该会话属于本人）。`source` 用既有 `MANUAL`。
- 成功后同样在该轮出现回执（与 P1 共用组件），形成「我说记住 → 我看到记住了」的闭环。

### 4.3 P3 来源闭环与开启引导

- MemoryView 行内「来自：{会话标题}」，会话已删除则显示「来源会话已删除」不可点。
- 开启引导：首次手动记住且自动收集关闭时展示一次，状态存既有偏好（`user_preference` 通用 KV 或 localStorage，评审定）。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | memory-extraction 返回值与 WS 推送；memory.routes list 加 `originSessionId` 过滤、create 收 `originSessionId` |
| desktop | `MemoryReceipt`、`MemoryEditDialog` 抽取、操作栏与选区入口、MemoryView 来源列、useStreamWS 事件分支 |
| contracts | WS 事件类型 `memory_captured` |
| mao-cli | `memory list --origin-session`、`memory create --origin-session` |
| admin / android | 无（安卓走 desktop Web 自然获得） |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 回执打扰阅读 | 默认折叠为一行灰字；仅在确有新增 / 更新时出现 |
| 抽取在任务结束后数秒才完成，回执「迟到」 | 预期行为：回执出现时轻微淡入，不触发滚动 |
| 合并更新改了用户手写的条目，回执里看不出改了什么 | 「更新」条目展开时显示更新后的内容；不做 diff（YAGNI），用户可直接编辑 |
| 选区记住时内容超 500 字 | 预填时截断并提示「记忆宜短，建议精简」 |
| 时间窗口推断回执归属不准（同一会话连续多轮） | 优先用 WS 事件里的 messageId；历史还原按「该轮 ASSISTANT 消息时间 ~ 下一轮 USER 消息时间」区间归属，边界误差可接受 |

## 7. 测试要点

1. 抽取产生 0 条时不发事件；产生新增 / 合并时事件 payload 正确区分。
2. 「忽略」后条目状态为 DISMISSED，且下一次抽取的负面约束集包含它。
3. `POST /v1/memory` 传他人会话的 `originSessionId` 被拒。
4. 历史会话重新打开时回执按轮次正确还原。
5. 自动收集关闭时「记住这个」仍可用。

## 8. 待确认决策

1. 回执的历史还原用「时间区间归属」是否可接受，还是值得给 `memory_item` 加 `origin_message_id` 列（一个迁移，归属精确）？
2. 「记住」默认作用域：有 projectKey 时默认项目级，还是一律用户级？
3. 开启引导的「只问一次」状态存服务端还是本地？
