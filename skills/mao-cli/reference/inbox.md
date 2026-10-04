# 任务收件箱（inbox）

## 模块职责

站内通知中心（Task Inbox）：聚合「任务完成 / 任务失败、提问待答、审批待办、子代理结果回传」五类事件，顶栏铃铛显示服务端权威未读数，点击条目跳回关联会话。

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

不写入：取消态（CANCELLED）、子代理会话与边路任务自身的 TASK_* 终态、微信 / 飞书通道会话、结果已被抑制的子代理回传。

**提问超时或审批处理完后，条目会消失吗？**
不会消失，只是自动置为已读（保留可查、不计未读徽标）。提问被回答 / 取消 / 超时、审批被批准 / 拒绝 / 超时 / 断连都会自动置已读。

**定时任务产生的条目有区别吗？**
有。payload 带 `source: 'SCHEDULED'`，前端显示「定时任务」徽标。

**能关掉某类通知吗？**
能。设置页「消息通知 → 站内收件箱」里四类开关独立保存，与上方 IM / Webhook 配置互不门控。默认前三类开、子代理完成关。

**系统通知什么时候弹？**
仅 Electron 桌面端，且窗口未聚焦 / 最小化时；点击通知即聚焦并跳转关联会话。未授予权限时静默降级为站内徽标，Web / 安卓不弹。

**会重复推送吗？**
不会。写入按 `dedup_key`（`userId:kind:sessionId:executionId|requestId`）幂等；重试、取消后重发、排队消费、崩溃恢复（新 executionId）不会刷出重复条目。

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

返回四类 kind 开关 + 系统通知总开关：`{ taskCompletedEnabled, questionPendingEnabled, approvalPendingEnabled, subagentDoneEnabled, systemNotifyEnabled }`。无偏好行时按默认值：前三类开、子代理完成关、系统通知开。

### PUT /api/v1/inbox/preferences

整体保存上述五个布尔字段（缺字段沿用当前值，last-write-wins）。

## 实时通道

每次写入 / 已读 / 删除后服务端重算未读数，经 WebSocket `inbox_updated` 帧（`{ unreadCount }`，只带数字不带条目内容）广播给该用户全部在线连接；前端在重连与打开抽屉时会主动重拉兜底。WS 通道细节见 [reference/desktop.md](desktop.md) 与仓库 `docs/plan/2026-10-02-task-inbox-technical-design.md`。
