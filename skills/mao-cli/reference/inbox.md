# 任务收件箱（inbox）

## 模块职责

站内通知中心（Task Inbox）：聚合「任务完成 / 任务失败、提问待答、审批待办、子代理结果回传、触发器停用、预算提醒、每日运营摘要」多类事件，顶栏消息图标显示服务端权威未读数，点击条目跳回关联会话（每日摘要打开详情对话框）。

## 使用问答

**收件箱未读和会话列表圆点是一回事吗？**
不是，两套独立概念。收件箱未读数只由 `notification.is_read` 决定（顶栏徽标）；会话列表圆点是 `session.unread`（终态时置 1，微信 / 飞书通道不置）。二者不互相推导。

**哪些事件会进收件箱？**

| kind | 触发 |
|------|------|
| `TASK_COMPLETED` | 主会话相位收敛到 COMPLETED |
| `TASK_FAILED` | 主会话相位收敛到 FAILED |
| `QUESTION_PENDING` | `ask_user_questions` 产生待答提问 |
| `APPROVAL_PENDING` | LOCAL 审批请求创建 |
| `SUBAGENT_DONE` | 后台子代理结果回传父会话（完成 / 失败 / 取消三种终态） |
| `TRIGGER_DISABLED` | 入站 Webhook 触发器连续执行失败 5 次后被自动停用（开放接口，见 [open-api.md](open-api.md)） |
| `WATCHER_DISABLED` | 信号哨兵连续探测失败 5 次后被自动停用（信号哨兵，见 [signal-watcher.md](signal-watcher.md)） |
| `BUDGET_WARN` | 用量预算当期已越上限：WARN 行在任务终态结算时发现越线，或排队消息被 BLOCK 拦下时给属主的一次性告知（预算，见 [budget.md](budget.md)） |
| `DAILY_DIGEST` | 每日运营摘要：按用户设定时间（默认 09:30）汇总昨天的任务 / 定时任务 / 哨兵 / 审批 / 成本 / 开放接口六类数据，安静日（全无数据）不写；同一天重复试发覆盖同一条目 |

不写入：取消态（CANCELLED）、子代理会话与边路任务自身的 TASK_* 终态、微信 / 飞书通道会话、结果已被抑制的子代理回传。

**每日摘要和别的条目有什么不同？**
三点：无关联会话（`sessionId` 为 null，点它打开详情对话框而非跳会话）；结构化数据在 `payload.digest`（六板块，空板块为 null，前端按板块分区渲染）；按天去重（`dedup_key` 尾段是日期），「立即发送昨日摘要」试发会覆盖同日条目并把已读重置为未读。摘要总开关、推送时间在「设置 → 消息通知 → 每日运营摘要」维护，不受站内收件箱的分类型开关门控（关摘要请用总开关）。

**提问超时或审批处理完后，条目会消失吗？**
不会消失，只是自动置为已读（保留可查、不计未读徽标）。提问被回答 / 取消 / 超时、审批被批准 / 拒绝 / 超时 / 断连都会自动置已读。

**定时任务产生的条目有区别吗？**
有。payload 带 `source: 'SCHEDULED'`，前端显示「定时任务」徽标；开放接口触发时 `source` 为 `API` 或 `WEBHOOK`，徽标同理。

**能关掉某类通知吗？**
能。设置页「消息通知 → 站内收件箱」里五类开关独立保存，与上方 IM / Webhook 配置互不门控。默认前四类开（含预算提醒）、子代理完成关。

**系统通知什么时候弹？**
仅 Electron 桌面端，且窗口未聚焦 / 最小化时；点击通知即聚焦并跳转关联会话。未授予权限时静默降级为站内徽标，Web / 安卓不弹。

**会重复推送吗？**
不会。写入按 `dedup_key`（`userId:kind:sessionId:executionId|requestId`）幂等；重试、取消后重发、排队消费、崩溃恢复（新 executionId）不会刷出重复条目。预算提醒另按「预算 id + 自然月」去重：同一预算同一月只提醒一次（WARN 越线提示与 BLOCK 留队提示共用同一条目，不会出两条）。

偏好开关管不到的条目：`TRIGGER_DISABLED`（触发器停用）、`WATCHER_DISABLED`（哨兵停用）、`WEIXIN_REPLY_WINDOW_CLOSED`（微信 24 小时窗口已关）始终写入，桌面系统通知也始终允许；`DAILY_DIGEST` 由摘要总开关在写入前判定，写入后同样不受五类 kind 开关门控、桌面系统通知始终允许。预算提醒由 `budgetWarnEnabled` 控制，默认开。

**条目保留多久？**
90 天，超期自动清理（已读未读一并清）。

## 端点说明（REST，登录态）

统一响应 `{ code, message, data }`，`code === 0` 成功。全部按当前登录用户归属隔离，越权一律按不存在处理。

本期 CLI 未封装收件箱命令，需要时直接调 REST（登录态 JWT）。

### GET /api/v1/inbox

分页列表，`created_at` 倒序。

| 参数 | 必填 | 说明 |
|------|------|------|
| `page` | 否 | 默认 1 |
| `size` | 否 | 默认 20，最大 100 |
| `unreadOnly` | 否 | `true` 只看未读 |

返回 `{ records, total, page, size }`，条目含 `id`、`kind`、`title`、`content`、`isRead`、`readAt`、`sessionId`（跳转目标，可能为 null）、`payload`（`source` / `status` / `requestId` 等）、`createdAt`。

### GET /api/v1/inbox/unread-count

徽标数据源：`{ unreadCount }`。服务端 COUNT 为唯一权威。

### POST /api/v1/inbox/{id}/read

单条已读（已是已读状态时返回失败，按不存在处理）。

### POST /api/v1/inbox/read-all

全部已读。

### DELETE /api/v1/inbox/{id}

删除单条。

### GET /api/v1/inbox/preferences

返回五类 kind 开关 + 系统通知总开关：`{ taskCompletedEnabled, questionPendingEnabled, approvalPendingEnabled, subagentDoneEnabled, budgetWarnEnabled, systemNotifyEnabled }`。无偏好行时按默认值：前四类开（含预算提醒）、子代理完成关、系统通知开。`TRIGGER_DISABLED`（触发器停用）与 `WATCHER_DISABLED`（哨兵停用）不受偏好开关控制，始终写入。

### PUT /api/v1/inbox/preferences

整体保存上述六个布尔字段（缺字段沿用当前值，last-write-wins）。

## 每日运营摘要端点（REST，登录态）

偏好懒建行：无行时回落默认值（`enabled=true`、`pushTime='09:30'`、`outboundEnabled=true`）。CLI 未封装，直接调 REST。

### GET /api/v1/digest/preferences

返回 `{ enabled, pushTime, outboundEnabled, lastDigestDate, yesterdayStatus, yesterdayCoveredDate }`。`yesterdayStatus` 三态：`PENDING`（今天还没处理昨天）/ `SENT`（已生成并写入收件箱）/ `QUIET`（昨天已处理但无事件）。

### PATCH /api/v1/digest/preferences

增量保存，body 只传要改的字段：`{ enabled?, pushTime?, outboundEnabled? }`。`pushTime` 必须为 `HH:MM`（`00:00`~`23:59`），非法返回 `PARAM_INVALID`。返回保存后的偏好（不含状态字段）。

### POST /api/v1/digest/send-now

试发昨日摘要：立即生成并写入收件箱（配了出站订阅且开关打开时同步派出），**不推进** `lastDigestDate`（可重复调用，同一天覆盖同一条目）。返回 `{ sent, reason?, line?, coveredDate }`：`sent=false` 时 `reason` 为 `QUIET`（安静日）或 `DISABLED`（总开关关闭，试发不检查开关，正常不会出现）。

## 实时通道

每次写入 / 已读 / 删除后服务端重算未读数，经 WebSocket `inbox_updated` 帧（`{ unreadCount }`，只带数字不带条目内容）广播给该用户全部在线连接；前端在重连与打开抽屉时会主动重拉兜底。WS 通道细节见 [reference/desktop.md](desktop.md) 与仓库 `docs/plan/2026-10-02-task-inbox-technical-design.md`。
