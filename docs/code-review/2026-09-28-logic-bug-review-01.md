# 核心功能逻辑 BUG 审查（2026-09-28）

## 审查基线与边界

- **日期**：2026-09-28
- **范围**：`backend-ts` 核心链路（工具调度 / 会话生命周期 / 定时任务 / 消息复制 / 点踩反馈），对照 `desktop/electron` 本地工具执行面。
- **方式**：通读源码与调用链、对照 `docs/code-review/` 既有结论去重。**未跑测试、未改业务代码**。
- **去重原则**：历史文档（尤其 `2026-08-07-code-review-12/14` 的 `SERVER_ONLY_TOOLS`、`2026-09-10/22` 的定时任务 once、`2026-09-27-logic-bug-review-01`、`2026-09-28-side-task-context-mode-review-01`）已覆盖的不重复开条；本篇只报**当前源码仍可复现**的逻辑错误。
- **结论**：确认 **11** 个可复现且值得修复的逻辑 BUG，其中 **6** 个 P1（B01/B02/B06/B07/B08/B11）。
- **复核记录（2026-09-28）**：全部条目已逐条对照当前源码复核。原 B05（feedback 查询缺 `user_id` 谓词）**不构成可复现 BUG**；原 B03（promote 复制丢 `createdAt`）属实，但只让升级后的消息时间戳变成同一时刻，顺序与 LLM 上下文不受影响，**修复价值低**。二者已移除并记入文末「复查后未列入」表。

## 问题总览

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| B01 | P1 | harness/tool + desktop/electron | LOCAL 模式下定时任务工具被误投桌面客户端，创建/改/删/列表全部 `Unknown tool` |
| B02 | P1 | session + schedule | `deleteSession` 不级联清理绑定的定时任务，任务会持续按 cron 触发并永久 FAILED |
| B04 | P2 | schedule | `updateTask` 对已完结任务的任意字段更新会静默复活（Agent 工具路径无任何提示） |
| B06 | P1 | session/ws | `autoConsumingSessionIds` 标记被手动 `send_message` 偷走，自动消费消息二次落库（且手动消息不落库） |
| B07 | P1 | session/ws | `executePersistedUserPrompt` 不消费 `pendingCancels`，定时任务启动窗口内「停止」被静默丢弃 |
| B08 | P1 | desktop/审批 | 审批发送失败恢复的卡片被 `handledIds` 永久禁用，多卡场景无法重试 |
| B09 | P2 | harness/tool | `ask_user_questions` 空问题仍注册并空等 15 分钟 |
| B10 | P2 | desktop/输入 | `clearInputIfUnedited` 的 `\|\|` 短路：等待保存期间用户未切走时新输入被无条件清空 |
| B11 | P1 | harness + session/ws | fork 边路任务首问 id 小于复制历史，有压缩边界时被整体排除出 LLM 上下文 |
| B12 | P2 | harness/delegate | `copyFileChanges` 全量复制子会话 file_change，followup/重试每轮重复写入父会话 |
| B13 | P2 | harness/delegate | `SubAgentResultCollector.onThinkingStart` 清空已积累回答，交错思考时结果被截断 |

---

## B01 [P1] LOCAL 模式下定时任务工具被误投桌面客户端

### 位置

- `backend-ts/src/harness/tool/tool-registry.ts:118-121`（注册 `create/update/list/delete_scheduled_task`，`BaseTool.getDescriptor()` 默认 `executor: 'server'`）
- `backend-ts/src/harness/tool/tool-dispatcher.ts:45-50`（`SERVER_ONLY_TOOLS` 硬编码名单）
- `backend-ts/src/harness/tool/tool-dispatcher.ts:164-186`（路由：名单内强制服务端，否则 `executionMode === 'LOCAL'` 全部走 `localToolExecutor`）
- `desktop/electron/main.cjs:1950-1970`（桌面 `executeToolByName` 仅实现 shell / read / write / edit / glob / grep / mcp，其余 `Unknown tool`）

### 触发路径

1. 桌面 LOCAL 会话中，模型看到并调用 `create_scheduled_task`（或 `update_scheduled_task` / `list_scheduled_tasks` / `delete_scheduled_task`）。
2. `dispatchFull`：`SERVER_ONLY_TOOLS` **不含**这四个工具名 → 落入 `executionMode === 'LOCAL'` 分支 → `localToolExecutor.execute(...)` 经 WS 发给桌面。
3. 桌面 `executeToolByName` 的 `switch` 无对应 `case`，走 default 返回 `{ error: 'Unknown tool: create_scheduled_task' }`。
4. 模型收到错误工具结果；用户在 LOCAL 会话中**无法创建/维护任何定时任务**。

### 实际 vs 预期

- **预期**：`executor: 'server'` 的工具（定时任务 CRUD 依赖 `ScheduledTaskService` / DB）应在服务端执行，与 `task_*`、`web_search`、`generate_image` 同类。
- **实际**：路由不读 `ToolDescriptor.executor`，只认硬编码 `SERVER_ONLY_TOOLS`；定时任务四工具漏列，LOCAL 下 100% 失败。

### 根因

`resolveDescriptor()` 已能返回 `executor: 'server'`，但 `dispatchFull` 的路由分支完全没用它，而是维护了一份与注册表脱节的字符串集合。历史上 `delegate_followup` 曾因同一模式漏列（见 `2026-08-07-code-review-12.md`），本次是同一类缺陷在定时任务工具上的复发。

### 影响

- LOCAL（桌面）会话的定时任务能力整体不可用；CLOUD 会话正常，问题被环境差异掩盖。
- 模型可能反复重试或向用户谎称「已创建定时任务」（工具返回 error 但模型可能误读）。

### 修复方向

1. 将 `create_scheduled_task` / `update_scheduled_task` / `list_scheduled_tasks` / `delete_scheduled_task` 加入 `SERVER_ONLY_TOOLS`（与 `task_*` 并列）；
2. 更稳妥：`dispatchFull` 优先按 `descriptor.executor === 'server'` 路由，`SERVER_ONLY_TOOLS` 仅作 fallback，避免再漏。

### 去重说明

`2026-08-07-code-review-12/14` 修的是 `delegate_followup` 漏列（该工具现已随 `DelegateTool` 退出注册表）；`2026-08-29-code-review-02.md` 只确认过 `dispatchFull` 结构，未审计名单完备性。当前源码 `SERVER_ONLY_TOOLS` 仍无定时任务四工具，属未修问题。

---

## B02 [P1] `deleteSession` 不级联清理绑定的定时任务

### 位置

- `backend-ts/src/session/session.service.ts:481-509`（`deleteSession` 只清 compaction / compaction_event / message / session + runtime 目录）
- `backend-ts/src/schedule/scheduled-task.service.ts:252-264`（`createTask` 将任务绑定到 `sessionId`）
- `backend-ts/src/schedule/scheduled-task.store.ts:68-72`（`listDue` 不校验 session 是否仍存在）
- `backend-ts/src/schedule/scheduled-task.service.ts:389-394`（执行时 `getSession` **抛** `SESSION_NOT_FOUND`，并非返回 `null`）

### 触发路径

1. 用户为会话 S 创建定时任务 T（`session_id = S`，`status = ACTIVE`，`next_fire_time` 已排期）。
2. 用户删除会话 S：`deleteSession` 软删 session/message/compaction，**不碰** `scheduled_task`。
3. 到点后 `listDue` 照常捞出 T → `executeTask` → `getSession(S)` 因 `deleted = 1` 抛 `SESSION_NOT_FOUND`（`session.service.ts:473-478`）。
4. 异常被 `executeTask` 内层 catch 捕获 → `markTaskResult(task, 'FAILED')`；`finally` 仍推进 `nextFireTime`（非 once 时）。
5. 下一个 cron 周期再次触发、再次 FAILED……**永久循环**。一次性任务也会先吃掉一次 FAILED 才 `finished`。

### 实际 vs 预期

- **预期**：会话删除后，绑定该会话的定时任务应被删除或至少置 `PAUSED`/`finished`，不再调度。
- **实际**：任务行长期残留且 `status = ACTIVE`，按计划反复触发、每次 FAILED，污染任务列表与 `lastExecutionStatus`。

### 根因

`deleteSession` 的清理清单只覆盖会话自身子资源（compaction / message / runtime），未把 `scheduled_task.session_id` 纳入级联；同时 `executeTask` 对 `getSession` 的异常路径只落 FAILED 不检查「会话已删」，没有停用/完结任务。

### 影响

- 已删会话的定时任务变成「幽灵任务」，每天/每小时失败一次，用户在「已完结 / 进行中」列表里看到莫名 FAILED。
- 运维侧 `last_execution_status` 被噪声淹没；若用户误以为任务已随会话消失，可能错过真正的停用操作。

### 修复方向

1. `deleteSession` 事务内增加：`UPDATE scheduled_task SET deleted = 1 WHERE session_id = ?`（或 `status = 'PAUSED', finished = 1`）；
2. `executeTask` 捕获 `SESSION_NOT_FOUND` 时直接 `finished = 1` + `nextFireTime = null`，不再排下一次；
3. 补回归测试：创建绑定任务 → 删会话 → `listDue` 不得再返回该任务。

### 去重说明

`2026-08-24-logic-bug-review-02.md` BUG-07 是「任务被删后仍执行一次」（任务侧删除竞态）；本条是**会话删除不清理任务**的反向缺口，入口与表都不同。`2026-08-30-logic-bug-review-01.md` 讨论的是前端 Map 残留，与后端级联无关。

---

## B04 [P2] `updateTask` 对已完结任务任意字段更新会静默复活

### 位置

- `backend-ts/src/schedule/scheduled-task.service.ts:267-312`（`updateTask`）
- 尤其 `:291-298`：`if (task.status === 'ACTIVE' && task.nextFireTime == null)` 无条件重算 `nextFireTime` 并 `finished = 0`
- 一次性任务收尾：`:487-490` / 入队路径 `:412-418` 置 `finished = 1` 且 `nextFireTime = null`，但 **`status` 仍为 `ACTIVE`**
- Agent 工具入口：`backend-ts/src/harness/tool/impl/scheduled-task-tools.ts:126-150`（`update_scheduled_task` 可只传 `name`）

### 触发路径

1. 一次性任务跑完：`finished = 1`、`nextFireTime = null`、`status` 仍为 `ACTIVE`。
2. Agent 调用 `update_scheduled_task`，仅改 `name`（或用户只改名称/prompt 的 REST 部分更新）。
3. `updateTask`：`cronExpression == null` 跳过第一段；随后命中 `:291` 分支——`status === 'ACTIVE' && nextFireTime == null` 成立。
4. `calculateNextFireTime` 算出下一次（每日任务=明天，固定月日任务=明年同日）→ `finished = 0`、`nextFireTime` 写回。
5. 任务在用户不知情下重新排期并再次触发。

### 实际 vs 预期

- **预期**：已完结任务除非用户显式改 cron/once/状态或选择「重新激活」，否则保持完结；仅改名不应改变调度状态。
- **实际**：任意 `updateTask` 只要碰上 `nextFireTime == null` 就复活。管理后台表单用弹窗文案「保存后若 Cron 能算出下次触发时间，任务会自动重新激活」把该行为标成「预期」，但 **Agent 工具 / REST 部分更新路径完全没有提示**，且改名语义上不应副作用复活。

### 根因

`finished` 与 `nextFireTime == null` 被当成「可被任意更新拉起」的开放状态；缺少「仅在显式要求重新激活或修改了 cron/once 时才重排」的门闩。`listDue` 也不过滤 `finished = 0`，一旦 `nextFireTime` 被写回就会立刻进入调度。

### 影响

- 已完结的一次性提醒被重命名后明年/明天再次打扰用户。
- Agent 在维护任务名称时误触发生产调度，属于静默数据副作用。

### 修复方向

1. `updateTask` 仅在以下情况重算 `nextFireTime` / 清 `finished`：显式传入 `cronExpression`、显式 `once` 变更、或显式 `status` 置回 `ACTIVE`（且可加 `reactivate: true`）；
2. 仅 `name`/`prompt` 更新时保留 `finished`/`nextFireTime`；
3. `listDue` 增加 `finished = 0` 防御；Agent 工具描述补充「更新已完结任务不会自动复活」。

### 去重说明

`2026-09-22-logic-bug-review-01.md` B05「改 cron 不会重判一次性」、`2026-09-22-logic-bug-review-02.md` B04「用过期 cron/once 快照」都处理执行期快照；`2026-09-10-logic-bug-review-01.md` BUG-2 是 once 入队不落 `finished`。均未讨论「updateTask 在 `nextFireTime == null` 时复活已完结任务」。

---

## B06 [P1] `autoConsumingSessionIds` 标记被手动 `send_message` 偷走，自动消费消息二次落库

### 位置

- `backend-ts/src/session/ws/streaming-ws-handler.ts:354`（无条件 `this.autoConsumingSessionIds.delete(sessionId)`）
- `backend-ts/src/session/ws/streaming-ws-handler.ts:418-441`（`!isAutoConsume` 才跳过 `saveMessage`）
- `backend-ts/src/session/ws/streaming-ws-handler.ts:1274-1359`（`autoConsumeQueue`：`:1330` 先 `saveMessage` 落库，`:1336` `autoConsumingSessionIds.add`，`:1337-1347` 延迟 500ms 调 `handleSendMessage`）

### 触发路径

1. 上一轮结束 → `autoConsumeQueue`：出队、**已 `saveMessage` 落库为 USER（msg#1）**、`autoConsumingSessionIds.add(sessionId)`，500ms 后才调 `handleSendMessage`。
2. 500ms 占位窗口内用户对同一会话发出 `send_message` → `handleSendMessage` 第 354 行 `delete` **把标记偷走**（返回 true，手动调用被误判为 auto-consume）；随后因 claim 被占在 `:402` 返回 `session_already_running`。
3. 因 `isAutoConsume` 被误判为 true，`:418` 的 `saveMessage` 被跳过——**手动消息没有落库**即被拒绝（前端乐观渲染的消息不会入库）。
4. 延迟调用到达：`delete` 返回 false → `isAutoConsume = false` → `!isAutoConsume` 分支**再次 `saveMessage`**（msg#2，同内容）→ 提交执行。

### 实际 vs 预期

- **实际**：历史出现两条相同 USER 消息，`buildContext` 给模型的上下文里同一句用户输入出现两遍；且窗口内被拒的手动消息不落库。
- **预期**：`isAutoConsume` 只能被「真正代表自动消费的那次调用」消费；跳过落库应按 `autoSavedMessageId` 是否存在判断，而非与调用方身份无关的 `delete`。

### 根因

「消费标记」与「用途判断」耦合在同一行 `delete`；任何进入该方法的调用都会清掉标记。`submitExecution` 拒绝路径、`compensate`、`handleInsertMessage` catch 都做了清理，唯独「手动 send 提前 return」会连带清掉不属于自己的标记。

### 影响

重复消息进入模型上下文与用户历史，干扰推理与阅读；窗口内的手动消息被拒时静默丢失（前端已乐观显示）；无自愈路径。

### 修复方向

1. 用 `autoSavedMessageId != null`（或 `data.autoConsumeStartedAt`）判断是否跳过落库，与 `delete` 解耦；
2. 或 `delete` 仅在 `claimAlreadyHeld && autoSavedMessageId != null` 时执行。

### 去重说明

`2026-08-24-logic-bug-review-03.md` BUG-05 是校验失败早退不回补（已修）；`2026-08-25-code-review-01.md` 只确认了 `isAutoConsume` 跳过落库本身，未覆盖「另一调用方先跑 :349」的交错。

---

## B07 [P1] `executePersistedUserPrompt` 不消费 `pendingCancels`，定时任务启动窗口内「停止」被丢弃

### 位置

- `backend-ts/src/session/ws/streaming-ws-handler.ts:596-629`（`executePersistedUserPrompt`，`:620` `registerCancelFlag` 前无 `pendingCancels` 检查）
- 对照正确实现：`:446-472`（`handleSendMessage` 的 M-2 修复：注册 flag 时消费 `pendingCancels`）
- 覆盖点：`:523`（`runExecution` 的 `updatePhase(RUNNING)` 无条件覆盖）

### 触发路径

1. 定时任务触发且会话空闲 → `scheduled-task.service.ts` 先 `updatePhase(RUNNING)`、`saveMessage`，再走 `liveExecution` → `executePersistedUserPrompt`。
2. 在 `:620` `registerCancelFlag` 之前（LOCAL 检查、`user_message_saved` 广播等窗口）用户点「停止」。
3. `handleCancel`：flag 未注册 → 登记 `pendingCancels`；phase 已是 RUNNING → `finishCancelledSession` 落 **CANCELLED**。
4. `executePersistedUserPrompt` 恢复后**不读 `pendingCancels`**，照常注册 flag → `runExecution` → `:514` 把 CANCELLED **覆盖回 RUNNING** → 完整跑完落 COMPLETED。标记只在 finally 被无条件删除，从未被消费。

### 实际 vs 预期

- **实际**：点停止后界面先显示「已取消」，随后又变回执行中，任务停不下来。
- **预期**：与 `handleSendMessage` M-2 注释一致——注册 cancel flag 时立即消费 `pendingCancels`，命中则置位 flag、落 CANCELLED、不提交执行。

### 根因

M-2 修复只加在 `handleSendMessage` 的 flag 注册点；`executePersistedUserPrompt` 是定时任务专用的另一条执行提交入口，被遗漏。

### 影响

定时任务启动窗口内取消 100% 无效；DB 阶态 CANCELLED→RUNNING→COMPLETED 反复覆盖；用户对「停止」失去信任。

### 修复方向

在 `:620` 注册 flag 处复用 `handleSendMessage` 的 `pendingCancels` 消费逻辑（按 `sendStartedAt` 时间窗判定，命中则不提交执行）。

### 去重说明

`2026-09-03-logic-bug-review-01.md` BUG-1 是 `handleSendMessage` 窗口漏登记 `pendingCancels`（已修）；本条是另一入口**不消费**已登记标记。`2026-09-21-logic-bug-review-01.md` B07 是无执行时 cancel 误落 CANCELLED（已由 `inFlight` 守卫修复）。

---

## B08 [P1] 审批发送失败恢复的卡片被 `handledIds` 永久禁用

### 位置

- `desktop/src/components/chat/ApprovalStack.vue:88-94`（`handledIds` 只增不减，`confirm()` 对已有 id 直接 return）
- `desktop/src/components/chat/ApprovalStack.vue:43,48`（按钮 `:disabled="handledIds.has(item.requestId)"`）
- `desktop/src/composables/useChat.ts:67-89`（失败后 `splice` 放回 + `incrementPendingApproval`）
- 卸载闸门：`ChatPanel.vue` / `SideChatPanel.vue` / `SubagentChatPanel.vue` 均 `v-if="items.length > 0"`——多卡时组件不卸载

### 触发路径

1. 会话同时存在 ≥2 张待审批卡片（多子代理 LOCAL 审批聚合进主聊天，或失败恢复卡 + 新卡）。
2. 点「执行」→ `handledIds` 置位 → 出队 → `respondToolApproval`（IPC 已放行工具）→ `sendToolApproval`（WS）失败。
3. 失败分支把卡片放回队列，但 `handledIds` 仍持有该 requestId → 按钮 `:disabled` 恒为 true，`confirm()` 二次拦截。

### 实际 vs 预期

- **实际**：恢复卡永久灰显；WS 决议永远发不出去，服务端 `ApprovalRegistry` 直到工具跑完才 unregister，会话停在 `WAITING_APPROVAL`；本地 `pendingApprovalCount` 只增不减。
- **预期**：放回队列的卡片应可再次点击（`handledIds` 应在出队/恢复时移除该 id）。

### 根因

防重状态（组件级、只增不减）与失败回滚（恢复同一 requestId）语义冲突；单卡时靠 `v-if` 卸载重建「碰巧」清掉状态，多卡时泄漏。

### 影响

LOCAL 审批一旦遇到一次 WS 失败且面板还有其他审批，该审批永久失效；桌面工具其实已放行，界面却仍显示待审批。

### 修复方向

`handledIds` 在 `confirmApproval` 失败回滚时 `delete(requestId)`；或按键值挂在卡片项上随项销毁。

### 去重说明

`2026-09-21-frontend-review-01.md` #3 是「卡片先移除再发送、失败后消失」（放回队列已修）；本条是该修复与 `handledIds` 的交互缺陷。`2026-09-22-frontend-review-01.md` 曾以「一次通常只有一张待审批」排除多卡禁用，该假设不成立（ChatPanel 明确聚合多子代理审批；失败恢复本身制造多卡）。

---

## B09 [P2] `ask_user_questions` 空问题仍注册并空等 15 分钟

### 位置

- `backend-ts/src/harness/tool/tool-dispatcher.ts:226-242`（尤其 `:231-233` 只 warn 不拦截，`:242` 无条件 `register`）
- `backend-ts/src/harness/tool/ask-user-questions-registry.ts`（默认超时 900_000ms）

### 触发路径

1. 模型调用 `ask_user_questions`，参数为 `{"questions": []}` 或 questions 元素均非法（归一化后为空）。
2. `:231-233` 仅 `harnessLog('warn', '... normalized to 0 questions ...')`，**不 return**。
3. `:242` `register(sessionId, [], metadata)` → `waitForAnswer` 挂满 15 分钟。
4. 离线时还可能 `prepareAskUser` 发 Webhook，叫用户「回来答 0 个问题」。

### 实际 vs 预期

- **实际**：会话被无意义阻塞 15 分钟；用户可能收到指向空提问的通知。
- **预期**：`questions.length === 0` 应立即返回 `{"error": "..."}`，让模型重新以合法参数调用（与 `:215` 飞书拦截的即时失败风格一致）。

### 根因

归一化函数用空数组表示解析失败，调用方只 log 不判定；注册/等待/离线通知三步都假设「至少有一个问题」。

### 影响

模型输出抖动时单轮工具调用挂 15 分钟，整会话阻塞；离线用户被无意义通知打扰。

### 修复方向

`:231` 分支改为 `return JSON.stringify({ error: 'questions 不能为空，请提供至少 1 个问题' })`。

### 去重说明

`2026-08-21-code-review-02.md` 的空 questions 建议针对前端作答路径；2026-09-17 之后 logic review 未覆盖 `dispatchAskUserQuestions` 的空问题分支。

---

## B10 [P2] `clearInputIfUnedited` 的 `||` 短路：未切走时新输入被无条件清空

### 位置

- `desktop/src/components/chat/ChatPanel.vue:720-725`：

```ts
function clearInputIfUnedited(sentText: string, generation: number) {
  const current = chatInputRef.value?.getPlainText() ?? ''
  if (generation === sendGeneration || current === sentText) {   // ← OR 短路
    chatInputRef.value?.clearInput()
  }
}
```

- `ChatInput.vue:1329-1337`（`clearInput` 同时清草稿槽）

### 触发路径

1. 发送后进入等待保存窗口（新建会话含 git clone 时可达 1–2 分钟）；`waitingForSave` 只锁发送按钮，**编辑器仍可输入**。
2. 用户在输入框补打/修改文本（例如「另外还需要……」）。
3. 保存确认到达 → `generation === sendGeneration` 为 true（用户未切 Tab、未再次发送）→ 直接 `clearInput()` + 清草稿 → **新输入被销毁**。

### 实际 vs 预期

- **实际**：只要本轮代数未被作废，无论文本是否被改过都清空。
- **预期**（与函数名/注释自洽）：仅在「原文未改」时清空；用户改过的内容应保留。正确条件是 `current === sentText`，无需代数兜底。

### 根因

把「代数未变」当成「输入未变」的充分条件；代数只在 `onActivated` / 再次 `handleSend` 时递增，用户原地编辑不会换代。本函数是 `2026-09-22-frontend-review-01.md` #4 的修复，改造时引入了反向回归。

### 影响

慢网络/慢建会话时静默输入丢失且不可恢复（草稿一并清掉）；失败路径有回填草稿，成功路径却反向销毁输入。

### 修复方向

改为 `if (current === sentText) clearInput()`（两侧同一 `getText().trim()` 口径，未改时必然相等）。

### 去重说明

`2026-09-22-frontend-review-01.md` #4 是「切走再切回输入框**不**清空」（代数被 bump 的方向），与本条（代数未 bump 时**误**清空）互为反向。

---

## B11 [P1] fork 边路任务首问 id 小于复制历史，有压缩边界时被整体排除出 LLM 上下文

### 位置

- `backend-ts/src/session/ws/streaming-ws-handler.ts:824`（先落库边路首问 USER → 得到 id=X）
- `backend-ts/src/session/ws/streaming-ws-handler.ts:870`（再 `executeSideFirstMessage`）
- `backend-ts/src/harness/core/harness-service.ts:569-641`（`forkParentMessages` 复制插入，新 id = X+1…X+N；压缩边界经 `messageIdMap` 重映射到复制行 id）
- `backend-ts/src/harness/core/session-history-loader.ts:27-36`（`loadHistoryAfterBoundary`）→ `session.repository.ts:303-308`（`selectMessagesAfterId`，`ORDER BY id ASC`，`id > boundary`）
- `session-history-loader.ts:64-73`（`resolveLatestUserMessage`）→ `session.service.ts:1079-1081`（`getLastUserMessage`，按 id 取最后一条 USER）

### 触发路径

1. 用户选「Fork 主会话」创建边路任务；`handleCreateSideSession` **先** `saveMessage(sideSessionId,'USER',…)` 得 id=X。
2. `executeSideFirstMessage('fork')` → `forkParentMessages` 把主会话全部消息复制进边路会话，**新 id 更大**（X+1…X+N）。
3. `buildContext` → `loadHistoryAfterBoundary` 以 `id ASC`、`id > boundary` 取历史构造 LLM 请求。

### 实际 vs 预期

- **无压缩（boundary=0）**：LLM 历史为 `[边路新问题(id=X), 主会话全史(id=X+1…)]`——**问题排在最前**，对话以主会话旧消息结尾。预期应为「历史在前、新问题在最后」。
- **有压缩（fork 一并复制并重映射边界）**：mappedBoundary 落在复制行 id 区间（>X）。`id > boundary` 过滤后，**边路首问（id=X < boundary）根本进不了 LLM 上下文**；且 `resolveLatestUserMessage` 在增量里无真实用户消息时按 id 取「最后一条 USER」，取到的是复制来的主会话旧 USER 而非本次问题。

### 根因

首问先落库、fork 复制后落库，复制行拿到更大自增 id；历史加载只认 id 序，压缩边界又是 id 水位过滤。三者叠加导致首问被顶到最前、甚至被边界切掉。

### 影响

fork 模式首轮 LLM 上下文顺序错误；主会话压缩过时边路任务的提问完全丢失，模型看不到用户要做什么，可能直接续写主会话旧线程。**确定性复现**。

### 修复方向

1. 先 `forkParentMessages` 再落库首问（保证首问 id 最大、排在最后）；
2. 或复制后把首问重插为最后一条；
3. 边界重映射需保证 `mappedBoundary < 首问 id`。

### 去重说明

`2026-09-28-side-task-context-mode-review-01.md` 问题 2 谈的是 fork `createdAt`（当前源码已传入），且结论为「无实际影响、降级」，未分析首问 vs 复制历史的相对 id 与压缩边界排除。promote 丢 `createdAt` 见文末「复查后未列入」，与本条不是同一问题。

---

## B12 [P2] `copyFileChanges` 全量复制子会话 file_change，followup/重试每轮重复写入父会话

### 位置

- `backend-ts/src/harness/delegate/background-subagent-manager.ts:768-784`（`copyFileChanges` 用 `listBySession(childSessionId)` 取**全会话**变更）
- 调用点 `:763-765`（`persistCompletionNotice`）；`persistCompletionNotice` 被 `onCompleted`、`completeRetry`、`failExecution` **每次收尾**调用
- 同模式：`subagent-result-delivery.service.ts:157-191`（恢复投递 `deliverBackground`）
- 佐证：`session.repository.ts:487-491`（`FileChangeRepository.listBySession` 为 `WHERE session_id = ?` 全量）

### 触发路径

1. `spawn_subagent` → 子会话第 1 轮改文件（file_change 落在子会话）→ 完成 → `copyFileChanges` 复制进父会话通知。
2. 对同一子会话 `subagent_followup`（复用 childSessionId）→ 第 2 轮继续改文件 → 子会话 file_change 现含 R1+R2。
3. 第 2 轮完成 → 再次 `copyFileChanges` 全量 → **R1 被第 2 次复制进父会话**。
4. 失败后「重试」同理：`failExecution` 已复制过一轮，`completeRetry` 再全量重拷。

### 实际 vs 预期

- **实际**：父会话 file_change 为「通知1：R1；通知2：R1+R2」，R1 重复；每多一轮 followup/重试，全部历史变更再重复一份。
- **预期**：每条完成通知只携带该 execution **新增**的变更（或按 messageId/executionId 去重）。

### 根因

复制源是「子会话全量」，完成通知却是「每 execution 一次」。恢复路径 `findBackgroundNotice` 只按 `executionId` 幂等，挡不住跨 execution 的全量重拷。

### 影响

父会话文件变更面板/统计重复条目与重复行数；消息多时 MEDIUMTEXT diff 多倍冗余。确定性复现。

### 修复方向

按 execution 范围复制（记录上次复制水位或按 messageId 过滤）；或写入前按 `(parentSessionId, filePath, content hash)` 去重。

### 去重说明

`2026-09-22-logic-bug-review-01.md` B06 是「同一 execution 崩溃恢复二次写通知」（已由 `findBackgroundNotice` 修复）；本条是正常 followup/重试路径下跨 execution 的全量重拷。

---

## B13 [P2] `SubAgentResultCollector.onThinkingStart` 清空已积累回答，交错思考时结果被截断

### 位置

- `backend-ts/src/harness/delegate/subagent-result-collector.ts:13-16`（`onThinkingStart` 同时清 `contentBuilder` 与 `thinkingBuilder`）
- `:48-54`（`getResult` 只取当前缓冲）
- 消费方：`background-subagent-manager.ts:599-612`（结果为空时以 `(子代理未产生文本输出)` 充当结果）
- 发射方：`backend-ts/src/harness/core/agent-loop.ts:221-236`（`onThinkingStart` 在**每个**思考块起点触发，同一响应内可多次）

### 触发路径

1. 子代理最终响应流式增量为 `content → reasoning → content`（Claude interleaved thinking、Gemini thought summary 后置、部分网关 reasoning 滞后），或 `content → reasoning`（尾部思考摘要）。
2. `content1` 进入 `contentBuilder`；随后 reasoning 触发 `onThinkingStart` → **清空** `contentBuilder`，`content1` 丢失。
3. `getResult()` 只剩 `content2`；尾部思考场景下为空串 → 父代理收到 `(子代理未产生文本输出)`，而子会话里其实保存着完整回答。

### 实际 vs 预期

- **实际**：交付给父代理的结论被截断或替换为「无输出」，与子会话持久化内容矛盾。
- **预期**：`onThinkingStart` 是「思考块级」事件，不应清内容缓冲（对照 `onToolCallStart` 才是回合切换语义，`onLlmStreamReset` 是整轮重置）。

### 根因

collector 把 `onThinkingStart` 误当回合起点清缓冲；agent-loop 在同一响应内可多次触发该事件。

### 影响

子代理结论静默丢失或被替换为「无输出」；恢复路径同样受影响。依赖模型是否交错/尾部思考，非必现，但一旦发生即静默丢结论。

### 修复方向

`onThinkingStart` 不再清 `contentBuilder`（或仅在确有新回合语义时清）；保留 `onLlmStreamReset` 的整轮清理。

### 去重说明

`2026-08-24-logic-bug-review-03.md` BUG-06 只报 `onLlmStreamReset` 清 `toolCallCount`（已修）；近期 logic-bug-review 无 `SubAgentResultCollector` / `onThinkingStart` 条目。

---

## 复查后未列入（避免后续重复排查）

| 点 | 结论 |
| --- | --- |
| `listMessageIdsBySession` 不按 `user_id` 过滤（原 B05，复核后移除） | SQL 确实缺 `user_id` 谓词，但点踩入口 `dislike`/`cancelDislike` 均经 `requireOwnedAssistantMessage` 强制「仅会话属主可点踩」，`listDislikedMessageIds` 又先校验 `owner === userId`；单属主模型下查询结果恒正确。属防御性一致性改进，非当前可复现 BUG，不符合本篇收录标准 |
| `promoteSideTaskToMainSession` 复制消息丢失 `createdAt`（原 B03，复核后移除） | 属实：`session.service.ts` 复制体不含 `createdAt`，`MessageRepository.insert` 也不写该列，升级后 `created_at` 全部变成升级时刻。同事务按原序插入，新 id 严格递增，`ORDER BY created_at, id` 在时间相同时仍按 id 保持原序，LLM 上下文不受影响。只是展示层时间戳失真，修复价值低 |
| `SERVER_ONLY_TOOLS` 含 `delegate` / `delegate_followup` | 二者已不在 `createDefaultToolRegistry` 注册，当前不可达，不构成运行时缺陷 |
| `suppressPending` 缺 `SENDING` 兜底 | 当前源码已有 `SENDING → SUPPRESSED_WS` CAS（`delivery.service.ts:156-165`） |
| fork 复制丢 `createdAt` | `harness-service.ts:590` 已显式传入（`2026-09-28-side-task-context-mode-review-01` 问题 2 按当前源码应视为已修或记录有误） |
| `generateContextSummary` 注入 base64 | 已走 `extractVisibleText` |
| 任务面板偏好并发覆盖 | 已有 `version` 乐观锁（`preference.repository.ts:58-66`） |
| `listDue` 不滤 `finished` | 单独不触发；与 B04 联动才危险，故并入 B04 修复项而非独立开条 |

## 修复优先级建议

1. **P1**：B01（LOCAL 定时任务整体不可用）、B02（幽灵定时任务永久 FAILED）、B06（自动消费消息二次落库 + 手动消息丢失）、B07（定时任务停止无效）、B08（审批恢复卡永久禁用）、B11（fork 首问被压缩边界排除）——影响核心功能正确性与用户可见行为。
2. **P2**：B04（已完结任务被静默复活）、B09（空提问挂 15 分钟）、B10（等待期输入被清空）、B12（file_change 跨轮重复）、B13（子代理结果被清空）。

## 验证与边界

- 本报告基于静态阅读与调用链推演，**未执行** `npm test` / Playwright。
- **2026-09-28 复核**：全部条目已逐条对照当前源码验证触发链（含 `SERVER_ONLY_TOOLS` 集合内容、LOCAL 工具列表过滤、`deleteSession` 清理清单、`updateTask` 分支、`pendingCancels` 两处注册点、`autoConsumeQueue` 时序、`handledIds` 生命周期、fork/compaction id 重映射、`onChunk` 交错触发等）；移除原 B05（不可复现）与原 B03（仅时间戳展示、价值低），其余 11 条维持成立。
- 行号以当前工作区源码为准（`backend-ts` / `desktop` / `desktop/electron`），复核时已修正 B06/B07 小节行号。
- 覆盖：工具调度、会话生命周期、定时任务、WS 执行/取消、消息复制与 fork、子代理收尾、点踩反馈、桌面审批/输入/边路任务流式。
- 未覆盖：`agent-cli`、安卓壳、飞书/钉钉/微信通道细粒度时序、MCP 协议层、前端视觉层。
