# 队列消费失败熔断技术方案

> 需求：任务异常中断（FAILED）时，不得自动消费队列中的下一条消息。

---

## 1. 需求背景

当前系统提供会话级消息队列：Agent 执行任务期间，用户继续发送的消息进入队列排队；任务结束后，后端自动出队（auto-consume）下一条消息并继续执行。

该机制存在一个缺陷：**无论上一个任务以何种终态结束，队列都会被自动消费**。当上一个任务异常失败（FAILED）时，上一个任务实际上没有执行完成——它的上下文、结论都是残缺的。此时立即消费下一条消息，会导致：

- 下一条消息基于残缺上下文执行，产出错误的回复；
- 用户排队的消息被"悄悄"消耗掉，用户以为消息还在排队，实际上已被执行且结果不可信；
- 连续排队多条消息时，失败像多米诺一样传导，浪费 LLM 调用。

同样的问题存在于崩溃恢复路径：服务重启后 `CrashRecoveryRunner` 对中断任务恢复续跑，续跑仍然失败（FAILED）时，恢复结束的回调依然会触发队列自动消费与飞书队列接力消费。

## 2. 需求描述

### 2.1 要做的

1. **任务终态为 FAILED 时，停止该会话队列的自动消费**，适用全部三类执行路径：
   - 桌面/Web 主队列（`message_queue`）的正常执行；
   - 主队列的重试执行（retry）、Side Task 会话自身的队列；
   - 崩溃恢复续跑（`CrashRecoveryRunner`）结束后仍为 FAILED 的场景（含桌面主队列与飞书队列两条接力链路）。
2. **飞书队列同步修复**：上一条排队任务执行 FAILED 时，`drainNext` 接力停止，队列中剩余消息原样保留。
3. **队列保留**：FAILED 后队列不做任何处置（不清空、不回退、不重排），等用户手动处理。
4. **自然恢复**：后续任意一次执行（用户手动发送新消息、「立即发送」队首、重试）若以 COMPLETED 结束，自动消费照常触发，队列恢复正常流转；若仍 FAILED，继续保持停止。

### 2.2 明确不做的

1. **不做失败自动重试**：FAILED 后不重试当前任务，不引入重试计数。
2. **不做前端提示**：不新增 WS 事件（如 queue_paused），不改任何前端 UI。用户可从任务失败气泡与仍在的队列自行判断。
3. **不做暂停标志持久化**：不新增 DB 字段、不做数据迁移、不维护跨重启的暂停状态。暂停语义完全由「下一次执行的终态」即时推导。
4. **不改用户主动取消（CANCELLED）的行为**：用户点停止、「立即发送」中断旧任务，均属用户主动决策，结束后照常自动消费。
5. **不改崩溃恢复后成功（COMPLETED）的行为**：恢复续跑成功说明任务实际完成，照常自动消费。
6. **不改队列管理功能**：删除、调序、清空、「立即发送」的现有行为保持不变。
7. **不改飞书队列启动恢复（hydrate）逻辑**：RUNNING 行「消息已落库→删除 / 未落库→复位 QUEUED」的语义保持不变；仅恢复续跑终态后的接力消费受新规则约束。
8. **不改桌面端 / Web 前端代码**：本次为纯后端行为变化，前端零改动。

### 2.3 行为矩阵（共识口径）

| 上一任务终态 | 队列自动消费 | 说明 |
|---|---|---|
| COMPLETED | 消费 | 现状保持 |
| CANCELLED | 消费 | 用户主动决策，现状保持 |
| **FAILED（正常执行）** | **不消费** | 本次修复 |
| **FAILED（重试后）** | **不消费** | 本次修复 |
| **FAILED（崩溃恢复续跑后）** | **不消费**（主队列 + 飞书队列） | 本次修复 |

---

## 3. 现状分析：auto-consume 全部触发点

### 3.1 主队列（message_queue，桌面 / Web）

| # | 触发点 | 位置 | 现状行为 |
|---|---|---|---|
| 1 | `runExecution` finally | `backend-ts/src/session/ws/streaming-ws-handler.ts:409` | 无条件 `autoConsumeQueue`，不区分 COMPLETED / CANCELLED / FAILED |
| 2 | `runRetryExecution` finally | `streaming-ws-handler.ts:779` | 同上 |
| 3 | Side Task `finally` | `streaming-ws-handler.ts:663` | Side Task 会话自身队列，同上 |
| 4 | 崩溃恢复回调 | `backend-ts/src/create-app.ts:1584` | `CrashRecoveryRunner` 恢复续跑结束后，无论终态都调用 `autoConsumeQueue` |

`autoConsumeQueue` 本身（`streaming-ws-handler.ts:906`）只负责「有空位才出队队头并执行」，**不做任何终态判断**——它无条件信任调用方。

### 3.2 飞书队列（feishu_inbound_queue）

| # | 触发点 | 位置 | 现状行为 |
|---|---|---|---|
| 1 | `onMessage` 空闲路径执行后 | `backend-ts/src/feishu/agent-inbound-handler.ts` `onMessage()` 末尾 | `if (executed) drainNext()`，不区分上一条终态 |
| 2 | `drainNext` 接力循环 | `agent-inbound-handler.ts` `drainNext()` | `executeQueued` 内部 catch 住执行异常后仍返回 claimed=true，接力继续消费下一条 |
| 3 | 崩溃恢复后接力 | `create-app.ts` 回调 → `drainNextIfPending()` | 恢复续跑 FAILED 后仍接力 |

### 3.3 问题根因

终态信息在收尾处（`finishXxxSession` / `finishExecution` / `runExecution` 的 try-catch 分支）是已知的，但**没有被传递给消费决策点**；消费决策点（finally 块、`drainNext`、恢复回调）全部与终态解耦，导致「失败也消费」。

## 4. 技术选型

### 4.1 选型：终态驱动判定（已确认）

在任务收尾处由终态显式计算「是否继续消费」，把决策作为参数传递给消费调用，**不引入任何持久化/内存暂停标志**。

- 优点：
  - 无跨重启残留状态，无「僵尸暂停」清理问题（进程重启后标志丢失或残留都会引入新 bug）；
  - 逻辑集中在收尾与消费衔接的一处判定，易测试、易推理；
  - 「手动任务成功即恢复」语义由同一规则自然满足，无需额外的解除操作或状态机。
- 与另一方案（FAILED 时写暂停标志、消费前检查）对比：标志方案需要定义标志的存储位置（内存/DB）、生效范围、解除时机，复杂度更高且引入新的状态一致性风险，故不采用。

### 4.2 终态来源约定

各执行路径在收尾时已明确终态，改造要求把终态从「finish 动作」中显式传出：

- `finishCompletedSession` / `finishFailedSession` 目前在会话 phase 已是 CANCELLED 时跳过 `finishExecution`（防御重复收尾）。改造后这两个方法**返回实际生效的终态**（跳过时返回 `CANCELLED`），供调用方准确判定，不额外增加 DB 查询。

---

## 5. 实现步骤

### 5.1 主队列：`StreamingWsHandler`

**文件：`backend-ts/src/session/ws/streaming-ws-handler.ts`**

1. **`runExecution`（触发点 3.1-1）**
   - 在 try 顶部引入局部变量 `terminalPhase: 'COMPLETED' | 'CANCELLED' | 'FAILED' = 'FAILED'`（默认失败，保守兜底）。
   - `finishCompletedSession` / `finishCancelledSession` 调用后用返回值更新 `terminalPhase`。
   - catch 分支 `finishFailedSession` 后置为 `FAILED`。
   - finally 中的 `await this.autoConsumeQueue(sessionId, userId)` 改为 `if (terminalPhase !== 'FAILED') await this.autoConsumeQueue(sessionId, userId)`。
   - finally 中其余资源清理逻辑不变。

2. **`runRetryExecution`（触发点 3.1-2）**：同上模式改造 finally。

3. **Side Task 执行 finally（触发点 3.1-3）**：同上模式改造。

4. **`finishCompletedSession` / `finishFailedSession`**：签名从 `Promise<void>` 改为 `Promise<'COMPLETED' | 'CANCELLED'>` / `Promise<'FAILED' | 'CANCELLED'>`——内部 `session?.phase === 'CANCELLED'` 提前返回时返回 `'CANCELLED'`，正常完成返回各自终态。其余调用方（`executePersistedUserPrompt`、`handleEditAndResend` 等）不使用返回值，无需改动。

5. **`autoConsumeQueue` 本体不改**：它继续只做「有空位→出队→执行」，终态门禁由调用方负责。

### 5.2 崩溃恢复：`CrashRecoveryRunner`

**文件：`backend-ts/src/harness/core/crash-recovery-runner.ts`、`backend-ts/src/create-app.ts`**

1. `onExecutionFinished` 回调签名扩展：`(sessionId, userId)` → `(sessionId, userId, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED')`。在 `recoverSession` 的 finally 中以实际终态调用（成功分支 COMPLETED、cancelFlag 分支 CANCELLED、catch 分支 FAILED）。
2. `create-app.ts` 回调内：
   - `phase === 'FAILED'`：**跳过** `wsHandler.autoConsumeQueue` 与 `feishuInboundHandler.drainNextIfPending`；
   - 飞书进度卡片映射清理（`feishuProgressCardRepo.deleteBySessionId`）**在所有终态下照常执行**（卡片收尾不依赖队列消费）。

### 5.3 飞书队列：`AgentFeishuInboundHandler`

**文件：`backend-ts/src/feishu/agent-inbound-handler.ts`**

1. **`onMessage` 空闲路径（触发点 3.2-1）**
   - `executeDirect` 返回值改为 `Promise<'COMPLETED' | 'CANCELLED' | 'FAILED'>`：内部 `runExecution` 的三个收尾分支（cancelFlag→CANCELLED、正常→COMPLETED、catch→FAILED）把终态传出。
   - 末尾接力改为 `if (executed && phase !== 'FAILED') void this.drainNext(sessionId)`。

2. **`drainNext` 接力循环（触发点 3.2-2）**
   - `executeQueued` 返回值改为终态：正常 / cancelFlag 分支返回 COMPLETED / CANCELLED；内部 catch 执行异常分支返回 `FAILED`（finally 中 `queueService.complete(row.id)` 的清理保持不变——队列行删除语义不变，改的只是「是否继续接力」）。
   - `claimed` 判定改为 `claimed && phase !== 'FAILED'` 才继续 `drainNext` 递归接力。

3. **`drainNextIfPending`（触发点 3.2-3）**：本体不改（它只检查 hasPending 后 drainNext）；崩溃恢复 FAILED 场景由 5.2 的调用方门禁拦截。正常路径（如崩溃恢复成功后）行为不变。

4. **取消 / 「立即发送」中断链路**：`interrupt()` 置 cancelFlag → `runExecution` 走 CANCELLED 分支 → 接力照常（消费被 `jumpToFront` 提到队首的那条消息），保持现状。

### 5.4 不改动的部分（防止范围蔓延）

- `MessageQueueService` / `FeishuInboundQueueService` / 两个 repository：零改动（无 DB 迁移）。
- `autoConsumeQueue`、`enqueueHead` 回补逻辑：零改动。
- 飞书 `hydrate()` 启动恢复、排队卡片、取消按钮：零改动。
- 桌面 / Web / 安卓前端：零改动。
- Side Task 父子会话交互、子代理恢复协调（`SubagentRecoveryCoordinator`）：零改动。

---

## 6. 测试与验收

### 6.1 单元测试

**`backend-ts/src/session/ws/streaming-ws-handler.spec.ts`**

1. 保留现有 `autoConsumesQueuedMessageAfterExecutionCompletes`（COMPLETED 后消费，回归保障）。
2. 新增：执行抛异常（FAILED）后，队列 pending 消息**不被** dequeue，仍可通过 `listPending` 查到。
3. 新增：用户取消（cancelFlag）后，队列照常自动消费（回归保障）。
4. 新增：FAILED 后手动 `send_message` 成功（COMPLETED），队列恢复自动消费。
5. 新增：收尾竞争场景——catch 分支触发时会话 phase 已为 CANCELLED 时按 CANCELLED 处理（消费照常），验证返回值传递正确。

**`backend-ts/src/harness/core/runtime-helpers.spec.ts` / `crash-recovery-runner.spec.ts`**

6. 新增：恢复续跑以 FAILED 结束时，`onExecutionFinished` 收到 `phase='FAILED'`。
7. 新增：恢复续跑以 COMPLETED 结束时，`onExecutionFinished` 收到 `phase='COMPLETED'`（回归保障）。

**`backend-ts/src/feishu/agent-inbound-handler.spec.ts`**

8. 新增：`executeQueued` 执行异常（FAILED）后，`drainNext` 不再消费队列中剩余消息（用 mock `queueService` 断言 `claimNext` 未被再次调用）。
9. 新增：正常完成后队列中有多条消息时，接力消费继续（回归保障）。

### 6.2 验收标准（手工 / E2E）

1. 会话中排队 2 条消息 → 当前任务执行失败 → 队列仍显示 2 条，无新执行启动。
2. 此时手动发送一条新消息 → 执行成功 → 队列自动消费恢复，队首消息被执行。
3. 当前任务执行成功 → 队列照常自动消费（现有行为不回归）。
4. 当前任务被用户点停止 → 队列照常自动消费（现有行为不回归）。
5. 飞书机器人：当前任务失败后，排队卡片对应的消息保留在队列中不被执行；恢复续跑失败同理。
6. 服务重启且崩溃恢复续跑失败：主队列与飞书队列均不接力消费。

### 6.3 CI

`cd backend-ts && npm run build && npm test`（新增用例全部通过，存量用例不回归）。

---

## 7. 落地清单

| 项 | 内容 | 状态 |
|---|---|---|
| 代码 | `streaming-ws-handler.ts`：`runExecution` / `runRetryExecution` / Side Task finally 终态门禁；`finishCompletedSession` / `finishFailedSession` 返回终态 | 待实施 |
| 代码 | `crash-recovery-runner.ts`：`onExecutionFinished` 增加 phase 参数并按实际终态回调 | 待实施 |
| 代码 | `create-app.ts`：恢复回调按 phase 门禁 `autoConsumeQueue` 与 `drainNextIfPending`；卡片清理保持全终态执行 | 待实施 |
| 代码 | `agent-inbound-handler.ts`：`executeDirect` / `executeQueued` 返回终态；`onMessage` / `drainNext` 按 FAILED 停止接力 | 待实施 |
| 测试 | streaming-ws-handler.spec / runtime-helpers.spec（或 crash-recovery-runner.spec）/ agent-inbound-handler.spec 新增 9 个用例 | 待实施 |
| 文档 | 根 `CHANGELOG.md` 新增条目（backend-ts 小节：任务失败后停止队列自动消费） | 待实施 |
| 不做 | 自动重试、前端暂停提示、暂停标志持久化、DB 迁移、前端改动、hydrate 改动 | 明确排除 |

## 8. 风险与边界

1. **终态竞争**：执行异常与用户取消同时发生时，以「会话实际 phase」为准（`finishXxxSession` 的 CANCELLED 防御返回值），保证不会把用户已取消的任务误判为 FAILED 而错误停止消费。
2. **默认值保守**：`terminalPhase` 默认 `FAILED`——任何遗漏赋值的路径都倾向「不消费」，宁可暂停也不错误消耗用户消息。
3. **队列行清理语义不变**：飞书 `executeQueued` 失败后仍删除该队列行（现状），停止的是「后续接力」，不回滚已消费的那一条；该消息已落库为会话历史，用户可见失败结果。
4. **多实例 / 蓝绿部署**：判定完全基于单次执行的局部终态，无跨实例共享状态，蓝绿排空与延迟恢复逻辑不受影响。
