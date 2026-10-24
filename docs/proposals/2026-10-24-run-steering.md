# 提案：执行中引导（Run Steering）—— 长任务不必取消重来，在下一次工具边界插话纠偏

> 把控制粒度从「一次任务」降到「一步工具」：跑偏时不再只能等它跑完或全部作废，而是一句话把方向掰回来。

- 状态：已否决（2026-10-24），存档勿再评审
- 日期：2026-10-24
- 提案总览：见 [docs/proposals/README.md](README.md)
- 规模：中（后端为主，前端一个输入模式 + 一个消息标记）
- 关联：`message_queue` 既有设施、`StreamingWsHandler`、`AgentLoop`

## 1. 背景与现状

### 1.1 今天用户能做的只有两个极端

桌面端在会话运行中（`RUNNING` / `RESUMING` / `WAITING_APPROVAL` / `CANCELLING`）允许继续输入，但只有两种结果：

1. **排队**：发送后进入 `message_queue`，显示在 `QueuePanel`。输入框提示就是「正在运行，消息将进入队列...」（`desktop/src/components/chat/ChatInput.vue`）。队列只在本轮执行结束后由 `autoConsumeQueue` 依次消费（`backend-ts/src/session/ws/streaming-ws-handler.ts`）。
2. **插队（立即发送）**：`insert_message` 帧 → `handleInsertMessage` 先调 `abortRunningExecution` 终止当前执行，再以 `replaceExecution: true` 重新起一轮（`streaming-ws-handler.ts`）。效果是**杀掉当前工作、丢掉已跑的工具轮、从头重来**。

也就是说：用户看到 Agent 跑偏时，只能「等它跑完」或「全部作废」。中间那档——**保留已完成的工作，只调整后续方向**——不存在。

### 1.2 这不是「消息队列没做好」，而是控制粒度问题

`message_queue` 本身是健全的：FIFO、排序、插队、撤回编辑、来源绑定（定时任务 / Webhook / 开放接口）都有。缺的是消费时机只有「一轮结束后」一个点。

而 harness 侧其实已经有**每个工具轮边界**的钩子：`AgentLoop.execute()` 在工具执行完、下一次 `promptEngine.buildRequest()` 之前，会做 mid-loop 压缩检查（`consumeManualCompaction` + `CompactionConfig.shouldTrigger`），`no-progress-guard` 也在同一位置按轮推进。把「插入的用户消息」放在同一个边界消费，不需要改模型协议，也不需要新开执行体。

### 1.3 为什么现在做

- **长任务变多了**：定时任务、信号哨兵、子代理、开放接口让一次执行从「几轮问答」变成「几十轮工具」。执行越长，跑偏概率越高，取消重来的代价越大。
- **续跑成本在涨**：上下文压缩、图片、工具结果都在变重，一次重来可能烧掉几分钟和一笔真实成本。
- **差异化的最后一段**：会调工具的 Agent 不稀缺，**能被人随时抓住方向盘**的工作台稀缺。这是「Chat 套壳」与「真正的执行环境」之间最直观的体验差。

## 2. 目标 / 非目标

**目标**

1. 会话运行中，用户可以把一条消息以「引导」方式投递，**在下一个工具轮边界注入当前执行**，不中断、不重跑。
2. 三种语义清晰共存：**排队（默认）/ 引导（本轮生效）/ 插队（作废旧执行）**，用户可预期。
3. 引导消息与普通用户消息同源落库（`role=USER` + `metadata.steer=true`），刷新、分享、导出、检索全部自然兼容。
4. 引导在桌面端可见、可撤回（未生效前）、可在聊天流里看到「执行中插入」标记。

**非目标**

- 不做「打断模型流式输出」：流式过程中的引导一律落到流结束后的工具边界。
- 不做「中途替换模型 / 修改系统提示词 / 修改工具集」：引导只追加一条用户消息。
- 不做「强行终止在途工具」：P1 等当前工具返回；P2 再评估对 shell 等可中断工具的定向 kill。
- 不做子代理的 steer：子代理已有 `delegate_followup`；P1 只覆盖主会话与边路任务（两者共用同一队列实现）。
- 不做多用户协同编辑式会话（那是另一条产品线）。

## 3. 与已否决方向的边界

| 已否决方向 | 本提案为何不是它 |
|---|---|
| 计划模式 / 执行前计划门（2026-10-09 否决） | 不做执行前的审批或计划确认；引导发生在**执行中**，且完全由用户主动发起 |
| 渠道会话人工接管 Human Handoff（2026-10-11 否决） | 不引入 `WAITING_HUMAN` 相位，不换人；仍是原用户在原会话里补充指令 |
| 多 Agent 协作 / 任务 DAG（2026-10-05 否决） | 不新增 Agent 间通信与编排，只是把一条用户消息插进当前循环 |
| 结构化回复卡片（2026-10-19 否决） | 不新增消息块协议；「执行中插入」只是普通用户气泡上的一个元数据标记 |

## 4. 技术方案

### 4.1 语义模型

| 动作 | 触发 | 对当前执行 | 落库时机 | 典型场景 |
|---|---|---|---|---|
| 排队 | 默认发送 | 无影响 | 本轮结束后，`autoConsumeQueue` 落库并起新执行 | 「顺便再查一下…」 |
| **引导** | 输入框切到「引导」 | **在下一工具轮边界注入** | 注入成功时立即落库 | 「方向错了，改成按季度汇总」 |
| 插队 | 队列项「立即发送」 | 终止当前执行，`replaceExecution` | 立即落库并起新一轮 | 「别做了，先处理这个」 |

判定规则：

- 会话空闲 → 「引导」退化为普通发送（避免留下永不消费的 STEER 行）。
- 会话运行中但模型正在流式输出 / 正在执行工具 → 引导入队，等边界。
- 执行已进入收尾（本轮无工具调用，即将产出最终回答）→ 引导不强行插入，留在队列按普通消息消费；UI 提示「本轮结束后处理」。
- 同一执行最多注入 5 条引导（可配），超出部分转普通排队，防止上下文被插话淹没。
- 排序：STEER 行之间按入队顺序注入，不改变 QUEUE 行的相对顺序；执行结束仍未注入的 STEER 行按原 `sort_order` 作为普通消息消费。

### 4.2 数据模型

`message_queue` 增加一列（迁移号按实施时空闲号顺延，当前最新 V168）：

```sql
ALTER TABLE `message_queue`
  ADD COLUMN `mode` VARCHAR(16) NOT NULL DEFAULT 'QUEUE'
  COMMENT 'QUEUE=本轮结束后消费 / STEER=下一工具轮注入' AFTER `status`;

CREATE INDEX `idx_session_mode_status` ON `message_queue` (`session_id`, `mode`, `status`);
```

不新建表。引导消息复用队列行：

- `status` 沿用 `PENDING`；被 AgentLoop 取走后在同一段临界区里**先落 message 再删队列行**，任一步失败都回补为 PENDING（与 `handleInsertMessage` 的补偿口径一致）。
- 引导落库的 `message.metadata` 增加 `{ "steer": true, "executionId": "...", "appliedAtRound": N }`，供前端标记与轨迹关联。
- 不改 `message` 表结构；`metadata` 已是 JSON。

### 4.3 后端链路

**新 WS 帧** `steer_message`（`shared/contracts/src/ws.ts` 增加客户端帧类型）：

```ts
{ type: 'steer_message', sessionId, data: { content, eventId } }
```

服务端 `StreamingWsHandler` 新增 `handleSteerMessage`：

1. 校验会话归属、内容长度（≤ 8KB，与普通消息同口径）、会话相位。
2. 空闲 → 走 `handleSendMessage`；运行中 → `messageQueueService.enqueue(..., mode='STEER')`。
3. 广播 `queue_updated`，队列面板出现「引导 · 下个工具轮生效」条目。

**AgentLoop 注入点**：

在 `AgentLoop.execute()` 的工具轮收尾段（`executeToolCalls` 之后、mid-loop 压缩之后、`buildRequest` 之前）追加一次 `consumeSteering(context, persistenceCallback)`：

```
工具结果全部落库
  → 压缩检查（现有）
  → 取 STEER 行（FIFO，最多 5 条）
  → 逐条：saveMessage(USER, metadata.steer) → context.addUserMessage()
  → 发 steer_applied 事件 → 删队列行
  → buildRequest 进入下一轮
```

顺序约束（实现时写成注释 + 测试）：

- **必须在所有 tool 结果之后**：OpenAI 协议要求 assistant `tool_calls` 与 tool 消息连续；绝不能在二者之间插 user 消息。
- **必须在压缩之后**：压缩可能重写历史窗口，先压缩再追加，引导不会被摘要吞掉。
- **注入后清空 `context.preparedRequest`**：循环里用的是 `context.preparedRequest ?? buildRequest(context)`，压缩后的预构建请求若不清空，引导不会进入下一轮请求。
- **取消优先**：`cancelFlag` 已置位时不再注入，把 STEER 行回补为 PENDING 队列（与 `requeueIfClaimed` 同口径）。
- **失败回补**：落库成功、广播失败 → 不回补（消息已在，刷新可见）；落库失败 → 行保持 PENDING，下个边界重试。

**给模型的一句上下文提示**：注入时先追加一条**不落库**的 `context.addSystemMessage('用户在执行过程中插入了一条引导，请在保留已完成工作的前提下调整后续步骤，不要重复已完成的部分。')`，再追加真实用户消息。`addSystemMessage` 已是「user role + `<system-notice>` 包裹」的既有做法，不会破坏协议。

**为什么对前缀缓存友好**：引导只追加在消息数组尾部，系统提示词、工具目录、历史前缀都不变；被复用的前缀缓存不受影响。

### 4.4 前端

- `ChatInput` 在运行中显示模式切换：`排队` / `引导`（默认记住上次选择，首次默认「排队」）。占位文案随模式变化：「正在运行，消息将进入队列...」/「正在运行，将在下一个工具轮插入引导」。
- `QueuePanel`：STEER 行单独分组、图标与文案区分，支持撤回与编辑（未生效前）；生效后从队列消失。
- 聊天流：`message.metadata.steer === true` 的用户气泡显示「执行中插入」徽标；点击可跳到对应 run 的轨迹（复用 `useMessageLocate`）。
- 发送引导后 toast：「已加入引导，将在当前工具执行完成后生效」——明确不是立即。

### 4.5 通道与开放接口（P2）

- 飞书 / 钉钉 / 微信：当前运行中入站消息一律入队。P2 增加显式前缀 `/steer `（或卡片按钮「插话」）走 STEER；默认行为不变，避免群聊误触发。
- 开放接口：`POST /v1/open/agents/:id/run` 已有 `ifRunning` 语义；P2 增加 `mode=steer`，让外部系统也能在长任务中纠偏（例如 CI 日志触发）。
- `mao-agent` 终端：P3 再评估 REPL 内引导；`-p` 单次调用不涉及。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | 迁移 + 队列 `mode` + WS 帧 + AgentLoop 注入 + 落库/广播 + 桌面输入模式与徽标 | 后端 2-3 人日，前端 2 人日，含测试 |
| P2 | 队列内引导编辑/撤回、运行中工具定向终止、通道 `/steer`、开放接口 `mode=steer` | 3-4 人日 |
| P3 | 轨迹里按 run 展示「本轮收到 N 条引导」、mao-agent 支持 | 2 人日 |

P1 即可独立上线，不依赖其他提案。

**改动面（P1）**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 契约 | `shared/contracts/src/ws.ts` | 新增 `steer_message` 客户端帧、`steer_applied` 事件 |
| 后端 | `session/message-queue.repository.ts` / `message-queue.service.ts` | `mode` 列读写、按 mode 取队头 |
| 后端 | `session/ws/streaming-ws-handler.ts` | `handleSteerMessage`、空闲退化、队列广播 |
| 后端 | `harness/core/agent-loop.ts` / `harness-service.ts` | `consumeSteering` 注入、保存与广播回调、清空 `preparedRequest` |
| 前端 | `components/chat/ChatInput.vue` / `QueuePanel.vue` / 消息气泡 | 模式切换、引导分组、`metadata.steer` 徽标 |
| 迁移 | `V169__message_queue_mode.sql` | `message_queue.mode` + 索引 |
| 文档 | `CHANGELOG.md` / `skills/mao-cli/` / `USER_GUIDE.md` | 三语义说明与用户操作 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| 模型把引导当新任务、丢掉原目标 | 中 | 注入前加系统提示句；提示词里明确「保留已完成工作」；用现有 `no-progress-guard` 兜底空转 |
| 用户在工具执行 3 分钟后才看到生效 | 中 | UI 明确「当前工具结束后生效」；P2 再评估可中断工具的定向 kill |
| 引导过频导致上下文膨胀 | 低 | 单次执行 ≤5 条、单条 ≤8KB；超出转普通排队 |
| 与压缩、取消、重试的时序冲突 | 中 | 固定「压缩 → 引导 → 构建请求」顺序，补 AgentLoop 单测覆盖取消/压缩分支 |
| 落库成功但 WS 广播丢失 | 低 | 刷新走历史；`steer_applied` 只做即时提示，不作为真相来源 |
| 通道用户误触发 | 中 | 通道默认仍排队，P2 才加显式 `/steer` 前缀 |
| 队列行与消息双写不一致 | 中 | 临界区内先落库再删行 + 失败回补 PENDING；对齐 `handleInsertMessage` 的补偿模式 |

**待确认决策**

1. 默认模式选「排队」还是「引导」？建议排队（不改变现有行为）。
2. 单次执行引导上限 5 条是否合适？建议可配，默认 5。
3. 是否允许引导携带图片？建议 P1 仅文本（图片会显著放大请求体，且与图片注入行交互复杂）。
4. 引导是否清除 Todo 清单？不建议——引导是纠偏，不是新任务。

## 7. 测试要点

- `MessageQueueService`：`mode` 入队/取值/排序；STEER 与 QUEUE 混排时 FIFO 正确；`enqueueHead` 保持来源绑定。
- `AgentLoop`：第一轮工具后注入一条引导 → 下一次 `buildRequest` 的 messages 尾部包含该 user 消息；断言未插在 assistant `tool_calls` 与 tool 结果之间。
- `AgentLoop`：压缩与引导同时发生 → 先压缩后注入；取消标志置位 → 不注入且队列行回补。
- `AgentLoop`：超过 5 条 → 第 6 条留在队列，本轮结束后消费。
- `StreamingWsHandler`：空闲 steer 退化为普通发送；运行中 steer 只入队不执行；非属主被拒；超长内容被拒。
- 桌面：模式切换、发送后 toast、队列分组、`metadata.steer` 徽标渲染；刷新后消息仍在。
- 回归：排队 / 立即发送 / 撤回编辑 / 自动消费四条既有路径行为不变。

## 8. 验收标准与观察指标

**验收**

1. 运行中发一条「引导」，在下一个工具轮后模型按新方向继续，已完成工具的输出不丢失、不重复执行。
2. 引导消息刷新后仍在聊天流里，带「执行中插入」标记，导出 JSONL 包含 `metadata.steer`。
3. 现有「排队」「立即发送」路径的测试全绿，无行为变化。

**指标（上线后 4 周）**

- 因「跑偏」导致的取消率下降；
- 「取消后原样重发」的会话占比下降；
- 含引导的任务完成率 / 平均轮数，与不含引导的任务对照；
- 引导注入失败率（应为 0）与平均生效延迟（工具耗时决定，仅观测）。
