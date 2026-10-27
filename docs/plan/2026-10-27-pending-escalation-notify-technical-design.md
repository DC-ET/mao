# 待办未响应升级通知技术方案

> 状态：已确认（D1–D7，待实施）
> 日期：2026-10-27
> 上游提案：[docs/proposals/2026-10-27-pending-escalation-notify.md](../proposals/2026-10-27-pending-escalation-notify.md)（P2 会话级通知开关、P3 收尾体验已驳回；本方案只覆盖原 P1）
> 覆盖端：仅后端 backend-ts
> 迁移：无（不占号；当前最新 V174）

人离开座位、桌面端仍连着时，本地工具审批和向用户提问会静静挂到超时。本方案在无人处理满 3 分钟后，经用户已经配好的飞书 / 钉钉 / 邮件渠道推一条「等你处理」，不看 WebSocket 在不在线。

---

## 0. 决策记录

2026-10-27 评审确认：

| # | 决策 | 结论 |
|---|---|---|
| D1 | 原 P2 会话级通知开关 | **驳回**。不做 `session.notify_mode`、会话头部铃铛、必达、静音，不新增迁移 |
| D2 | 原 P3 收尾体验 | **驳回**。升级卡片不写剩余等待时间，不加 `focus=approval` 深链，会话里不留「审批在你离开时超时」标记，不加「重试本轮」 |
| D3 | 升级延迟 | **固定 3 分钟**，代码常量，不可调。评审确认 3 分钟合适；提案里的「用户可调 1～10」依赖偏好表新列，随被驳回的 P2 迁移一并去掉 |
| D4 | 是否单独关闭升级 | **不提供**。任务通知总开关关闭时（`findEnabled` 返回 null）升级行不写。完成 / 失败与升级共用这一开关，不拆成「只关升级」 |
| D5 | 提问与审批 | **同期实施**。两条等待走同一个写入函数 |
| D6 | 提问的在线 / 离线 | **离线仍立即推**（保持今天的行为）；**在线改为 3 分钟后推**；飞书表单已挂上时不推（守卫保留，见 §2） |
| D7 | 审批「已处理」的时刻 | **用户点了执行或拒绝**，不是本地命令跑完。`tool_approval` 帧到达即抑制；`finally` 只兜超时、断连、执行异常。见 §3.3 |

完成 / 失败通知的「桌面端 WS 送达即抑制」不变。本方案只给「还在等人」的审批和提问加一条不受该抑制影响的延迟外推。

---

## 1. 背景与目标

本地工具审批只发生在桌面端已连接时（`local-tool-executor.ts` 未连接直接返回错误）。因此「用户离线才外推」对审批永远不会触发：审批注册点只写站内收件箱，`TaskNotificationPhase` 里没有审批相位。提问虽然有外推，但条件是 `!userOnline`。桌面端常驻（托盘、开机自启）时，人去开会也算在线，这条分支同样不走。审批等待上限 `localToolTimeoutSeconds = 900`，超时后工具返回 `Local tool execution timed out`，Agent 绕路或失败收尾。

目标：

1. 需要审批的本地工具注册后，若 3 分钟内无人批准 / 拒绝 / 超时 / 断连，经该用户已启用的任务通知渠道发一条审批提醒。
2. `ask_user_questions` 在用户在线时同样等 3 分钟再发；用户离线时维持立即发。作答、取消、超时后，还没发出去的那一行改为抑制。
3. 卡片和纯文本只带会话标题和固定说明，不带命令、参数、危险原因。

不做：

- 飞书 / 钉钉卡片上远程批准本地命令。
- 新通知渠道、新收件箱 kind、新偏好字段、新系统设置。
- 改审批超时时长、审批语义、完成 / 失败通知的 WS 抑制。
- 安卓系统推送。
- 桌面端、管理后台、契约包、mao-cli 命令面的改动（用户可见文案见 §7，实施时改文档，不改 CLI 行为）。

---

## 2. 现状代码事实（实施前已核对）

| 事项 | 现状 | 位置 |
|---|---|---|
| 完成 / 失败外推 | 写 `WAITING_WS`，`nextRetryAt = now + 10s`；WS 送达则 `SUPPRESSED_WS`，否则改 `PENDING` 立刻可发。子代理、微信会话、队列仍有待发消息时直接不写 | `notification/task/delivery.service.ts` `prepare`（约 47–95 行） |
| 提问外推 | 仅 `prepareAskUser`：直接 `PENDING`、`nextRetryAt = now`、`eventKey = ask-user:{sid}:{rid}`、`terminalPhase = ASK_USER`。不看子代理 / 微信（调用点本身很少走到这两类会话） | `delivery.service.ts` 约 97–128 行 |
| 抑制 | `suppressPending` 先 CAS `PENDING → SUPPRESSED_WS`，失败再 CAS `SENDING`；已是 `SUCCEEDED` / `FAILED` 则打日志离开 | 同文件约 137–166 行 |
| 调度 | 只扫 `PENDING` 或 `WAITING_WS` 且 `next_retry_at <= now`。默认轮询 `notify.workerDelayMs = 30000`。发送前重查，已是 `SUPPRESSED_WS` 则不发 | `delivery.scheduler.ts` `listDue` 约 35–41 行，`deliver` 约 216–226 行；默认值 `settings.service.ts` `DEFAULT_NOTIFY_WORKER_DELAY_MS` |
| 相位渲染陷阱 | `phaseOfDelivery` 只认 `ASK_USER` 和 `COMPLETED`，**其余一律按失败渲染**。漏改则审批通知会变成「❌ 执行失败」 | `delivery.scheduler.ts` 约 328–332 行 |
| 卡片相位 | `TaskNotificationPhase = 'COMPLETED' \| 'FAILED' \| 'ASK_USER'`，未下沉 `@mao/contracts`。邮件主题取纯文本首行，不读卡片 | `feishu-notification-card.ts` 约 4–35、144–148 行；`email-sender.ts` `renderEmail` |
| 偏好门 | `findEnabled`：`enabled === 1` 且渠道、密文都在才返回行，否则 null | `preference.service.ts` 约 164–166 行 |
| 幂等 | `event_key VARCHAR(160)` 唯一键 `uk_task_notification_event`。`terminal_phase VARCHAR(16)`，`APPROVAL`（8 字符）放得下，无 CHECK | `db/migration/V054__task_completion_webhook_notification.sql` |
| 审批挂点 | 未连接直接返回。`needApproval` 时 `register` → 树信号 → 收件箱 `recordApprovalPending`（fire-and-forget）。`finally` 统一 `unregister` + `resolveApprovalPending`（批准 / 拒绝 / 超时 / 断连 / 执行异常） | `harness/local/local-tool-executor.ts` 约 32–86 行 |
| 审批表态 ≠ 工具结束 | 点「执行 / 拒绝」只走 `handleToolApproval`：`unregister` + 树信号，**不** `completeToolRequest`。`pending.future` 要等桌面回 `tool_result` / `tool_error` 才 resolve。批准后命令仍在跑时，`finally` 还没执行 | `streaming-ws-handler.ts` `handleToolApproval` 约 1016–1036 行；`handleToolResult` 约 1007–1013 行 |
| 审批 UI 先于等待 | `sendToolRequest` 已把 `tool_execute` 推到桌面，之后才 `register`。插入投递行发生在 UI 已显示之后 | `local-tool-session-registry.ts` `sendToolRequest` 约 98–108 行；executor 约 40–62 行 |
| 提问挂点 | 飞书通道会话在函数开头直接返回错误，走不到挂表单。其后 `userOnline = hasConnection`；`!userOnline && !formMounted` 才 `prepareAskUser`，等 `waitForAnswer` 结束后 `suppressPending` | `tool-dispatcher.ts` `dispatchAskUserQuestions` 约 409–483 行 |
| 提问工具裁剪 | 微信 / 飞书 / 钉钉通道以及子代理工具列表去掉 `ask_user_questions`。飞书进度卡挂表单的代码还在，但被开头的直接返回挡住，`formMounted` 在现行飞书会话上恒为 false | `harness-service.ts` 约 662–673 行；dispatcher 约 409–414 行与 456–463 行 |
| 装配顺序 | `LocalToolExecutor` 先构造，`deliveryService` 在 `assembleNotificationServices` 之后才有。提问通知把 `deliveryService` 原样传进 `ToolDispatcher`（它已经实现 `prepareAskUser` + `suppressPending`） | `create-app.ts` 约 708–753 行；`app-harness-engine.ts` 约 298–311 行 |
| 管理后台投递流水 | **没有这页**。邮件渠道方案已明确投递记录只在表内可查。提案里「admin 相位筛选加 APPROVAL」没有落点 | `docs/plan/2026-10-19-email-notification-technical-design.md` 决策 1 |
| 用户文档口径 | 「提问且你不在线时才会收到提问通知」；未写审批外推 | `skills/mao-cli/reference/desktop.md`「消息通知」节 |

收件箱 `APPROVAL_PENDING` / `QUESTION_PENDING` 仍在注册时立即写入、在终态置已读。外推是额外的一条延迟渠道，不替代收件箱，也不改收件箱开关。

---

## 3. 技术方案

### 3.1 延迟由 `nextRetryAt` 承担

新增常量（放在 `delivery.service.ts`，提问与审批共用）：

```ts
/** 桌面端仍连接、人未处理时，过这么久再外推。固定值，不进偏好表、不进系统设置。 */
export const PENDING_ESCALATION_DELAY_MS = 3 * 60 * 1000;
```

升级行直接写 `status = PENDING`，`nextRetryAt = now + delayMs`。调度器本来就只扫到期行，不新增定时器，不改 `listDue` / `claim` / 重试退避。

实际发出时刻是「3 分钟 + 不到一轮轮询」。默认轮询 30 秒，所以大约在第 3 分 0 秒到第 3 分 30 秒之间发出。这是既有调度粒度，不为此把轮询改密。

`delayMs = 0` 时 `nextRetryAt = now`，与今天的离线提问一致，下一轮轮询即发。

完成 / 失败仍走 `prepare` 的 `WAITING_WS`，本方案不碰。

### 3.2 `prepareEscalation`

在 `TaskNotificationDeliveryService` 增加一个写入函数，提问与审批共用。`prepareAskUser` 的插入逻辑收进这里，避免两套幂等键和两套跳过规则。

```ts
prepareEscalation(input: {
  session: Session | null;
  phase: 'ASK_USER' | 'APPROVAL';
  requestId: string;
  delayMs: number;
}): Promise<TaskNotificationDelivery | null>
```

按顺序返回 null（不插入）：

1. `session` 或 `session.id` / `session.userId` 为空。
2. 相位是 `ASK_USER` 且 `session.sessionType === 'SUBAGENT'`。提问工具本来就不进子代理，这里只是兜底。**审批不跳过子代理**：子会话继承父会话的 LOCAL，`delegate-tool` 会 `setUserForSession(childId, parentUserId)`，本地命令审批一样挂在桌面端。子会话 `userId` 就是父用户，外推发给同一个人，标题用子会话标题。
3. `session.projectKey === WEIXIN_PROJECT_KEY`。微信会话两种相位都跳过，与完成 / 失败通知一致。
4. `findEnabled(session.userId)` 为 null（总开关关、或渠道 / 密文不齐）。

通过则插入：

| 字段 | 取值 |
|---|---|
| `eventKey` | 提问 `ask-user:{sessionId}:{requestId}`（与今天相同）；审批 `approval:{sessionId}:{requestId}` |
| `executionId` | `requestId.slice(0, 64)`（列长 64；requestId 是 UUID，裁切只是守列宽） |
| `terminalPhase` | `ASK_USER` 或 `APPROVAL` |
| `status` | `PENDING` |
| `nextRetryAt` | `now + delayMs` |
| `channel` / `webhookCiphertext` | 偏好快照，与 `prepare` / `prepareAskUser` 相同 |
| `titleSnapshot` | 既有 `normalizeTitle`（空标题 →「未命名任务」，最长 255） |
| `attemptCount` | 0 |

插入成功后调用 `metrics.created(channel, phase)`，与今天的 `prepare` / `prepareAskUser` 相同。删掉 `prepareAskUser` 时不要把这条指标一起删掉。

唯一键冲突（`Duplicate` / `ER_DUP_ENTRY`）记 info 并返回 null，与 `prepareAskUser` 相同。其它异常抛给调用方；调用方必须接住，通知失败不能让审批或提问本身失败。

不套用 `prepare` 的「队列里还有待发消息则不通知」。那条规则是为了避免一轮还没真正结束就报完成。审批和提问当时就在等人，队列里有没有下一条无关。

`suppressPending` 原样复用。把它日志里的 “ask_user suppression” 改成不绑相位的说法（审批会走同一函数）。状态机不改：`PENDING` CAS、`SENDING` 兜底 CAS、终态不动。

### 3.3 审批挂点

`LocalToolExecutor` 增加可选依赖，未注入时行为与今天相同（只写收件箱）：

```ts
export interface ApprovalEscalationNotifier {
  prepare(sessionId: number, requestId: string): Promise<TaskNotificationDelivery | null>;
  suppress(delivery: TaskNotificationDelivery | null): Promise<void>;
}
```

`setEscalationNotifier` 在 `assembleNotificationServices` 之后调用。构造器不能直接收 `deliveryService`：executor 在 `create-app.ts` 里更早创建。

闭包放在 `create-app.ts`（executor 不自己查会话）：

```ts
localToolExecutor.setEscalationNotifier({
  prepare: async (sessionId, requestId) => {
    const session = await sessionMap.selectById(sessionId);
    return deliveryService.prepareEscalation({
      session,
      phase: 'APPROVAL',
      requestId,
      delayMs: PENDING_ESCALATION_DELAY_MS,
    });
  },
  suppress: (delivery) => deliveryService.suppressPending(delivery),
});
```

用 `selectById`（返回 null），不用会抛错的 `getSession`。会话查不到就跳过外推，审批等待照常。

插入时机：`sendToolRequest` 与 `approvalRegistry.register` 之后、`Promise.race` 之前，**await** 这一次插入。审批卡片此时已经推到桌面，多一次写入不挡弹窗。

`prepare` 用 try/catch 包住，失败只打 warn，`escalation` 留 null，工具继续等审批。

**抑制挂在「用户已经表态」，不挂在「命令跑完」。** `pending.future` 要等桌面回 `tool_result` / `tool_error` 才 resolve。点「执行」只发 `tool_approval`：`handleToolApproval` 摘掉审批登记，然后本机才开始跑命令。批准后如果命令超过 3 分钟（安装、构建、长 shell），`finally` 还没走到，调度器会把「请回来审批」发出去——人已经点过了。拒绝通常马上回 `tool_error`，单靠 `finally` 来得及，但不能用这条快路径代表批准。

两处都抑制。`suppressPending` 可重复调用：第二次看到终态会跳过，不会把已抑制的行改回去。

1. **`handleToolApproval`（主路径）**。批准和拒绝都走。执行器手里的 delivery 对象出不去，按 eventKey 查行：`approval:{sessionId}:{requestId}`。`DeliveryStore` 今天没有按 eventKey 查询，在 `delivery.service.ts` 的接口和 `stores.ts` 的 `DeliveryDbStore` 加 `findByEventKey`，查到后交给现有 `suppressPending`。查不到就返回（插入还没提交，见下）。`StreamingWsHandler` 不 import 通知实现，只收一个可选回调；`create-app.ts` 在 `assembleWsHandler` 时传入（`deliveryService` 此时已经有了）。回调用 try/catch，失败只打 warn，不影响审批帧本身。
2. **`finally`（兜底）**。超时、断连、执行异常，以及审批帧丢失时，对非 null 的行 `await suppress`。同样 try/catch。不在 `failPending` 再挂一次。收件箱的 `resolveApprovalPending` 仍只留在 `finally`、继续 fire-and-forget：收件箱表示这次本地调用还没结束，升级通知表示人还没对审批表态，两件事不要绑在同一个时刻。

**插入尚未提交时人已经点了批准。** `tool_execute` 先于 insert 到桌面，审批帧可能在 insert 返回前被处理，按 eventKey 查不到行。`ApprovalRegistry.register` 在插入之前已经把 requestId 放进内存集合，`unregister` 在 `handleToolApproval` 开头同步摘掉。插入返回后如果 `approvalRegistry.has(sessionId, requestId)` 为 false，说明表态已经发生，立刻 `suppress` 刚插入的行，不要留到命令结束。`has` 是新方法，按这一条 requestId 查，不能用会话计数（同一会话可以同时挂着另一条审批）。后端单进程，审批帧和执行器在同一进程，这个判断不用跨进程。

3 分钟后已经 `SUCCEEDED` 的行，用户再处理时 `suppressPending` 看到终态会跳过。消息已经发出，不撤回。这是预期：人没在 3 分钟内表态，提醒就该到。

### 3.4 提问挂点

`ToolDispatcher` 上现有的 `AskUserOfflineNotifier` 改成：

```ts
prepareEscalation(input: {
  session: Session | null;
  phase: 'ASK_USER' | 'APPROVAL';
  requestId: string;
  delayMs: number;
}): Promise<TaskNotificationDelivery | null>;
suppressPending(delivery: TaskNotificationDelivery | null): Promise<void>;
```

运行时传入的仍是 `deliveryService`（`app-harness-engine.ts` 那一处实参不用换对象）。`prepareAskUser` 从服务上删除，避免再留下一条不检查子代理 / 微信的写入口。

`dispatchAskUserQuestions` 里，飞书通道开头的直接返回保持不动。后面的条件从「仅离线」改为：

```ts
if (!formMounted && sessionId != null && this.askUserOfflineNotifier) {
  session ??= await this.sessionMapper.selectById(sessionId);
  const delayMs = userOnline ? PENDING_ESCALATION_DELAY_MS : 0;
  pendingDelivery = await this.askUserOfflineNotifier.prepareEscalation({
    session, phase: 'ASK_USER', requestId, delayMs,
  });
}
```

- 离线：`delayMs = 0`，下一轮调度即发。今天的行为。
- 在线：`delayMs = 3 分钟`。这是本方案新增的分支。
- `formMounted`：现行飞书会话到不了这里（开头已返回错误）。守卫保留，和今天的离线条件同一位置，避免以后若重新打开飞书表单时，用户已经能在飞书里作答还再被推到网页。
- 插入失败：沿用今天的 try/catch，提问等待照常。
- `waitForAnswer` 之后：只要 `pendingDelivery` 非 null 就 `suppressPending`，在线延迟行和离线立即行同一段代码。回答、取消、900 秒超时都经过这里。

在线分支要补一次 `selectById`（离线分支今天已经补了标题）。子代理 / 微信的跳过发生在 `prepareEscalation` 内部，dispatcher 不再单独判断。

### 3.5 相位渲染

`TaskNotificationPhase` 增加 `'APPROVAL'`。`phaseOfDelivery` 在落到「按失败渲染」之前识别它。`buildTaskNotificationText` 有同一处陷阱：不是 `ASK_USER` 也不是 `COMPLETED` 就写成「执行失败」。两处都要在失败分支之前认出 `APPROVAL`。漏任一处，钉钉文本、飞书卡片或邮件主题会变成任务失败。

`PHASE_META` 用橙色，与提问区分文案、不新加颜色枚举（现有 `template` 只有 green / red / orange）：

| 相位 | header | template | status |
|---|---|---|---|
| `APPROVAL` | Mao 审批通知 | orange | ⏳ 等待你的审批 |

卡片在状态行之后加一句固定说明：「有一条本地操作待你审批，请回到桌面端处理。」纯文本：

```text
Mao 审批通知
任务：{标题}
有一条本地操作待你审批，请回到桌面端处理
时间：{时间}
```

邮件无单独模板：`renderEmail` 用文本首行当主题，正文用其余行。首行是固定的「Mao 审批通知」，不含会话标题，没有换行注入面。

既有字段照旧渲染，不为本相位删掉：

- 「用户消息」仍是调度器读到的本轮用户原文（用户自己发的那条），不是工具参数。
- 「会话详情」按钮仍用现成的 `sessionDetailUrl`。这是今天完成 / 提问卡片已有的按钮，不是被驳回的 `focus=approval` 深链。邮件继续忽略卡片，不含链接（邮件方案决策 6）。

不写：命令、`argumentsJson`、`dangerReason`、剩余秒数、超时时间、「重试本轮」。

### 3.6 装配与依赖方向

```text
create-app
  LocalToolExecutor 先建
  assembleNotificationServices → deliveryService
  localToolExecutor.setEscalationNotifier(闭包 → prepareEscalation APPROVAL)
  assembleWsHandler → handleToolApproval 回调 suppressByEventKey(approval:{sid}:{rid})
app-harness-engine
  ToolDispatcher(..., deliveryService, ...)  // 提问走 prepareEscalation ASK_USER
```

`LocalToolExecutor` 和 `StreamingWsHandler` 都只依赖窄回调，不 import `notification/task` 的实现类。闭包待在 `create-app.ts`，与收件箱 `userIdOf` 闭包同一层。`assembleWsHandler` 在 `deliveryService` 之后，回调可以直接传入，不必再做一个 setter。

---

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `backend-ts/src/notification/task/delivery.service.ts` | `PENDING_ESCALATION_DELAY_MS`；`prepareEscalation`（含 `metrics.created`）；`prepareAskUser` 删除并入；`suppressPending` 日志去掉 ask_user 专名；`DeliveryStore.findByEventKey`；`suppressByEventKey` |
| `backend-ts/src/notification/task/stores.ts` | `DeliveryDbStore.findByEventKey` |
| `backend-ts/src/notification/task/delivery.service.spec.ts` | 见 §5 |
| `backend-ts/src/notification/task/feishu-notification-card.ts` | 相位、`PHASE_META`、卡片一句、纯文本一段 |
| `backend-ts/src/notification/task/feishu-notification-card.spec.ts` | 审批卡片与文本断言；断言正文不含调用方没传入的命令字段（本函数本来就不收命令，断言文案固定句在、失败句不在） |
| `backend-ts/src/notification/task/delivery.scheduler.ts` | `phaseOfDelivery` 识别 `APPROVAL` |
| `backend-ts/src/notification/task/delivery.scheduler.spec.ts` | 一条：`terminalPhase: 'APPROVAL'` 的行渲染出「Mao 审批通知」，而不是「执行失败」 |
| `backend-ts/src/harness/approval/approval-registry.ts` | `has(sessionId, requestId)` |
| `backend-ts/src/harness/local/local-tool-executor.ts` | 可选 notifier、注册后 await prepare、插入返回后若审批已摘掉则立刻 suppress、`finally` 再 suppress 一次 |
| `backend-ts/src/session/ws/streaming-ws-handler.ts` | `handleToolApproval` 在批准和拒绝时调用可选的 `suppressByEventKey` 回调 |
| `backend-ts/src/app-ws-handler.ts` | 把该回调放进 handler 依赖 |
| `backend-ts/src/harness/local/local-tool-executor.spec.ts` | 见 §5 |
| `backend-ts/src/harness/tool/tool-dispatcher.ts` | notifier 接口改 `prepareEscalation`；在线延迟 / 离线立即 / `formMounted` 不推 |
| `backend-ts/src/harness/tool/tool-dispatcher.spec.ts` | 现有 `prepareAskUser` 断言改签名；补在线延迟一例 |
| `backend-ts/src/create-app.ts` | `setEscalationNotifier` 闭包；`assembleWsHandler` 传入审批抑制回调 |
| `backend-ts/src/notification/task/email-sender.ts` | 只改注释：`renderEmail` 上「三类头」补上审批头。主题仍取文本首行，渲染逻辑不动 |

不改：`delivery.scheduler.ts` 的扫描与 claim、`task-terminal.service.ts`、收件箱、偏好表、桌面端、admin、`shared/contracts`、agent-cli。`terminal_phase` 列注释仍写「COMPLETED 或 FAILED」，不为改注释单独发迁移。

---

## 5. 测试要点

1. **审批到期才发**。`prepareEscalation(APPROVAL, delayMs = 3min)` 插入 `PENDING`，`eventKey` 为 `approval:{sid}:{rid}`，`nextRetryAt` 约为 now+3min。3 分钟内 `suppressPending` 后状态为 `SUPPRESSED_WS`，`nextRetryAt` 清空。
2. **提问两支**。在线：`delayMs` 为 3 分钟，且 `prepareEscalation` 被调用。离线：`delayMs` 为 0，`nextRetryAt` 为 now。`formMounted === true`：不调用 prepare。三支在等待结束后，非 null 的行都会 `suppressPending`（回答、取消、超时各能走到现有 suppress 段即可，超时沿用 registry 的现有用例，dispatcher 侧断言「未回答也会 suppress」已有，保持并覆盖在线行）。
3. **跳过**。提问：子代理不插入。审批：子代理仍插入（`userId` 用子会话上的父用户）。微信、`findEnabled` 为 null、session 为 null：两种相位都不插入。完成 / 失败的 `prepare` 仍跳过队列非空与 `CANCELLED`，升级函数不读队列。
4. **相位不会渲染成失败**。`phaseOfDelivery('APPROVAL')` 为 `APPROVAL`；卡片 header 为「Mao 审批通知」，正文含固定说明，不含「执行失败」。钉钉文本首行为「Mao 审批通知」。
5. **executor 时序**。需要审批时：`register` 之后、返回结果之前 `prepare` 被 await。两条抑制路径分开断言，不能把「批准」写成「工具结果已返回」：
   - 审批帧已到、`tool_result` 还没到：`suppressByEventKey('approval:{sid}:{rid}')` 已经把行打成 `SUPPRESSED_WS`。此后命令再跑多久，调度器都看不到这行。
   - 插入返回时 `approvalRegistry.has` 已是 false（表态发生在 insert 提交前）：立刻 `suppress`，不等 `finally`。
   - 超时、断连：没人点过，`finally` 抑制同一行。
   `prepare` 抛错时工具结果仍正常返回，且不调用 `suppress`。未注入 notifier 时与今天一样只动收件箱。不需要审批时不 prepare。收件箱仍只在 `finally` 置已读，不跟着审批帧提前清掉。
6. **SENDING 竞态**。沿用 `suppressPending` 已有口径：行已被 claim 成 `SENDING` 时第二次 CAS 仍能抑制；已 `SUCCEEDED` 时不改状态。升级不新写一套 CAS。给审批调用一次即可，证明走的是同一函数。
7. **幂等**。同一 `eventKey` 第二次插入返回 null，不抛。

`npm test` 在 `backend-ts` 跑，先落盘再按 `Test Files|Tests|FAIL` 看摘要。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 人就在屏幕前，只是想了几秒，被推一条 | 固定 3 分钟；处理发生在发出之前则行被抑制。没有更短的档，也没有单独关闭；不想收到任何外推就关掉任务通知总开关 |
| 插入与批准重叠 | 先 await 插入。审批帧若在提交前到达，按 eventKey 查不到行；插入返回后用 `approvalRegistry.has` 发现登记已摘掉，立刻抑制。帧在提交后到达则 `handleToolApproval` 按 eventKey 抑制。两种顺序都不要等命令结束 |
| 批准后命令仍在跑 | 抑制点是 `tool_approval`，不是 `tool_result`。`finally` 再抑制一次只是兜底，第二次看到终态会跳过 |
| 调度器已 claim 成 `SENDING` 时用户刚好处理（主要是离线提问，`delayMs = 0`） | 复用 `suppressPending` 的 `SENDING` CAS；`deliver` 发送前重查 `SUPPRESSED_WS` |
| 3 分钟时提醒已发出，第 10 分钟用户才回来批准 | 行已是 `SUCCEEDED`，抑制跳过。不撤回已发消息 |
| 卡片带上待执行命令 | 渲染函数不接收工具参数；文案是固定句加会话标题和用户原文。代码评审时对着 `buildContentInput` 看一眼，确认没有把 `failureReason` 或参数塞进审批相位 |
| 通知写入拖垮审批等待 | 单次 insert；异常吞掉。不在等待循环里轮询 |
| `phaseOfDelivery` 或 `buildTaskNotificationText` 漏改 | 两处都会把不认识的相位写成执行失败。§5 第 4 条同时断言卡片和钉钉文本都不是失败文案 |

---

## 7. 实施时同步的文档

行为对用户可见，实施时写入根 `CHANGELOG.md` 当前版本的「后端」小节：审批与在线提问在 3 分钟无人处理时，经已开启的飞书 / 钉钉 / 邮件提醒；离线提问仍立即提醒。

`skills/mao-cli/reference/desktop.md`「消息通知」节现在写的是「提问且不在线才推」。改为：离线立即推；桌面端仍连接但 3 分钟没作答也会推；本地工具审批同样在 3 分钟无人处理时推一条，不含待执行命令。飞书会话不提供提问工具、子代理不向用户提问，这两句保持。

不改 README.md、DEPLOY.md、偏好命令（`pref task-notification` 没有新字段）。

---

## 8. 相对提案的修正

| 提案写法 | 本方案 |
|---|---|
| P1 含「用户可调 1～10」，列可能随 P2 迁移加上 | 固定 3 分钟常量。P2 已驳回，不为调节器单开迁移和设置项 |
| 「是否允许关闭升级」未回答 | 不单独提供。总开关关闭则升级不写 |
| P2 会话铃铛 / 必达 / 静音，迁移 `V175__session_notify_mode.sql` | 不做 |
| P3 剩余时间、`focus` 深链、超时标记、重试按钮 | 不做。既有「会话详情」按钮保留 |
| admin 投递记录相位筛选加 `APPROVAL`；mao-cli `session update --notify-mode` | 管理后台没有投递流水页；CLI 无新参数。两端零改动 |
| 桌面通知设置页加「无人处理 N 分钟后提醒」 | 不做。延迟不是用户设置 |
| 审批 `finally` 调 `suppressPending` | `finally` 只兜超时 / 断连 / 执行异常。用户点执行或拒绝时在 `handleToolApproval` 立刻抑制，不等命令跑完。prepare 必须 await |
| 子代理与完成通知一样整段跳过 | 只跳过提问。子代理的本地审批仍写升级行，收件人是父用户 |
