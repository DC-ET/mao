# 任务收件箱（站内通知中心）技术方案

- 日期：2026-10-02
- 状态：已与需求方达成共识，待实施（已吸收 2026-10-02 技术评审补充）
- 来源提案：`docs/proposals/2026-10-02-task-inbox.md`
- 实施范围：P1（收件箱全链路）+ P2（Electron 系统通知）；P3（Web Push）不做

## 1 需求背景

Mao 的异步事件缺乏统一的"结果回来了"入口：

- 任务完成/失败：`session/task-terminal.service.ts` 在相位收敛到终态后走 `TaskNotificationDeliveryService.prepare()`，由 webhook 调度器投递任务 webhook 与 IM 卡片；用户 WS 在线时投递被抑制——**在线用户反而没有任何站内提醒**，只能去会话列表翻。
- 提问待答（`ask_user_questions`）与 LOCAL 审批待办只在会话运行时的面板里可见；用户切走或离线后没有聚合入口。
- 后台子代理结果经 `harness/delegate/` 回传主会话，完成提醒只走 IM 渠道。
- 收件箱的地基被提案误判为"遗留空表可直接 ALTER 启用"：`notification` 表实际已在 `V058__drop_notification.sql` 中被 DROP，本方案改为**新建表**（见 4.1 与决策记录 #2）。

## 2 需求描述

### 2.1 目标

1. 站内收件箱：聚合以下四类事件，一处查看、一键跳转会话，操作仍在会话面板完成：
   - `TASK_COMPLETED` / `TASK_FAILED`：会话相位收敛到 COMPLETED / FAILED（主会话）。
   - `QUESTION_PENDING`：`ask_user_questions` 产生待答提问。
   - `APPROVAL_PENDING`：LOCAL 审批请求创建。
   - `SUBAGENT_DONE`：子代理结果回传父会话完成。
2. 实时性：服务端写库后经 WS 向该用户全部在线连接广播 `inbox_updated { unreadCount }`；断线重连后前端主动拉取兜底。
3. Electron 桌面端系统通知（仅窗口未聚焦时弹出，点击聚焦并跳转）。
4. 按 kind 的偏好开关，与现有 IM/webhook 渠道并存、开关独立、互不门控。

### 2.2 核心交互

- 顶栏铃铛显示权威未读数（服务端为唯一权威，前端不做本地累加）；点击展开收件箱抽屉。
- 条目按 kind 显示图标、标题、摘要、相对时间；未读条目有标识。
- 点击条目：标记已读并跳转关联会话（QUESTION / APPROVAL 跳转后会话内对应面板自然呈现；提问超过 900 秒超时或审批已处理时，条目已在此前被自动置为已读，payload 摘要仍可读）。关联会话已被删除（session 为软删除、列表不再展示）时，前端跳转降级为提示并保留条目，不报错白屏。
- 偏好页新增「站内收件箱」分区：四个 kind 开关 + Electron 系统通知总开关（仅 Electron 显示）。
- 保留 90 天自动清理。

## 3 明确不做（不做清单）

| # | 不做的事 | 理由 |
|---|---|---|
| 1 | Web Push（VAPID + Service Worker），含安卓可行性探索（P3） | 安卓壳远程加载 Web，Android WebView 的 Push 依赖 Google Play services，国内 ROM 普遍不可用；安卓继续以 IM 通道为兜底，不做原生推送 |
| 2 | 收件箱内直接回复 / 审批 | 只读 + 跳转会话，操作仍在会话面板完成，避免两套操作语义 |
| 3 | 替代或改动现有 IM/webhook 通知 | 收件箱是站内补充；`TaskNotificationDeliveryService` 的 prepare/suppress/投递链路行为不变 |
| 4 | 管理后台收件箱 | 个人数据，admin 不聚合展示 |
| 5 | CANCELLED 终态写入收件箱 | 取消多由用户自己发起，无通知价值，保持收件箱低噪 |
| 6 | 子代理（`sessionType='SUBAGENT'`）与侧任务（`sessionType='SIDE_TASK'`）会话的 TASK_COMPLETED 记录 | 子代理完成由 SUBAGENT_DONE 单独承载（避免同一完成产生两条通知）；侧任务已有侧任务面板未读徽标承载 |
| 7 | 收件箱归档、收件箱内搜索、按 kind 的列表过滤 | 超出本期范围，列表仅支持 `unreadOnly` 过滤 |
| 8 | ask_user 离线 IM 提醒（`prepareAskUser`）与收件箱开关联动 | 两渠道并存、开关独立（决策记录 #4） |
| 9 | 通知偏好配置化（如保留天数进 system_setting） | 90 天为代码常量，KISS |

## 4 技术选型

### 4.1 数据模型（迁移 V131）

新迁移 `backend-ts/db/migration/V131__inbox_notification.sql`，一次包含两张表。迁移号避让：长期记忆方案占 V129/V130、Agent 资产包方案占 V132（2026-10-02 评审统一定号），本方案由原 V129 顺延为 V131：

```sql
CREATE TABLE notification (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    user_id       BIGINT       NOT NULL,
    kind          VARCHAR(48)  NOT NULL COMMENT 'TASK_COMPLETED/TASK_FAILED/QUESTION_PENDING/APPROVAL_PENDING/SUBAGENT_DONE',
    title         VARCHAR(256) NOT NULL,
    content       TEXT         NULL,
    is_read       TINYINT      NOT NULL DEFAULT 0,
    read_at       DATETIME     NULL,
    related_type  VARCHAR(32)  NULL,
    related_id    BIGINT       NULL,
    session_id    BIGINT       NULL,
    payload_json  JSON         NULL,
    dedup_key     VARCHAR(128) NOT NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_notification_dedup (dedup_key),
    KEY idx_notification_user_created (user_id, created_at),
    KEY idx_notification_user_read (user_id, is_read)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE user_inbox_preference (
    id                        BIGINT  NOT NULL AUTO_INCREMENT,
    user_id                   BIGINT  NOT NULL,
    task_completed_enabled    TINYINT NOT NULL DEFAULT 1,
    question_pending_enabled  TINYINT NOT NULL DEFAULT 1,
    approval_pending_enabled  TINYINT NOT NULL DEFAULT 1,
    subagent_done_enabled     TINYINT NOT NULL DEFAULT 0,
    system_notify_enabled     TINYINT NOT NULL DEFAULT 1,
    created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_inbox_pref_user (user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```

- **不保留提案中的 `type` 列**（SYSTEM/TASK/AGENT）：全新建表且无任何读写方，保留即永久 NULL 死列，kind 一列足够（决策记录 #2）。
- `user_inbox_preference` 而非"偏好 KV"：preference 域不存在通用 KV，惯例是每类偏好独立表 + repository（如 `user_weixin_preference` / `user_task_panel_preference`），本表沿用该模式，免 version 乐观锁（开关写入采用 last-write-wins，同 `user_weixin_preference`）。
- `system_notify_enabled` 列在 V131 一并建出（P2 只加 UI 与渲染端行为，不再加迁移）；P1 期间无读写方但默认值即最终语义。
- 默认值即决策记录 #5 的打扰度设计：前三类开、`subagent_done` 关。

### 4.2 写入路径与幂等

新增域 `backend-ts/src/inbox/`（`inbox.routes.ts` / `inbox.service.ts` / `inbox.repository.ts` / spec 同目录）。`InboxService` 为统一入口：

- **幂等**：`dedup_key = "{userId}:{kind}:{sessionId}:{executionId|requestId}"`，落库用 `INSERT ... ON DUPLICATE KEY UPDATE id = id`，命中唯一键即无操作；并发冲突由唯一键兜底。
- **权威未读数**：每次写路径（写入 / 单条已读 / 全部已读 / 删除 / 联动置已读）之后 `SELECT COUNT(*) ... WHERE user_id = ? AND is_read = 0`，并经 `streaming-ws-registry.send(userId, wsEvent('inbox_updated', null, { unreadCount }))` 广播到该用户全部在线连接。
- **WS 事件定位**：`inbox_updated` 不加入 `CRITICAL_EVENT_TYPES`——它不是会话状态类关键事件，丢失由重连后拉取 unread-count 兜底（见 5.4）。
- **偏好门控**：`record()` 前查 `user_inbox_preference`（无行时按列默认值），kind 关闭则不写入。
- **来源与子会话抑制**：`TASK_COMPLETED/FAILED` 写入点在 `session/task-terminal.service.ts` 的 `finishExecution` 内（与 `deliveryService.prepare()` 并列）：
  - `session.sessionType` 为 `SUBAGENT` 或 `SIDE_TASK`（即 `parentSessionId` 非空）时跳过（决策记录 #8）。
  - 来源区分：`finishExecution` 新增可选参数 `notifySource: 'MANUAL' | 'SCHEDULED' = 'MANUAL'`，仅 `schedule/scheduled-task.service.ts` 两处调用传 `SCHEDULED`，写入 payload（前端显示"定时任务"徽标）；子代理来源不会到达此处（已抑制），payload 无需 SUBAGENT 来源。
  - `dingtalk/runtime.ts`、`create-app.ts`、`crash-recovery-runner.ts` 的调用不传参（MANUAL 默认值），调用点零改动。
  - **接口声明副本须同步**：`finishExecution` 的窄接口声明有 6 份（`harness/deps.ts:274`、`schedule/scheduled-task.service.ts:122`、`dingtalk/runtime.ts:83`、`session/ws/streaming-ws-handler.ts:84`、`weixin/agent-inbound-handler.ts:58`、`harness/delegate/subagent-visibility-service.ts:26`）；scheduled-task 需传 `SCHEDULED`，其自有声明（`:122`）必须同步加参，其余副本按结构类型兼容情况逐一确认。

### 4.3 待办类条目的生命周期联动

提问与审批 pending 均为内存态（900 秒超时），收件箱记录是持久的，联动规则：**问题被回答/取消/超时、审批被批准/拒绝/超时/断连后，对应条目自动置为已读**（`is_read=1, read_at=NOW()`，条目保留在列表可查，不再计入未读徽标；决策记录 #3）。置已读时 userId / kind / sessionId / 尾段四要素齐全，**直接拼出完整 `dedup_key` 等值匹配**（命中 `uk_notification_dedup`），不做尾段 LIKE 扫描。

### 4.4 前端技术选型

- Vue3 `<script setup>` + Pinia + Element Plus（桌面现有栈）；抽屉用 `el-drawer`。
- 新 store `desktop/src/stores/inbox/`（`defineStore`），状态：`items / unreadCount / hasMore`。
- WS 接入：`useStreamWS.ts` 新增 `case 'inbox_updated'`（写入 `inboxStore.setUnreadCount`）；`onopen` 重订阅处增加一次 `fetchUnreadCount()` 静默重拉（对齐现有 `fetchFocusSessions(true)` 重连补偿模式）。
- Electron 系统通知：渲染端 Web Notification API（Electron 下 HTML5 Notification 直接走系统通知，无需 IPC），触发条件 = 偏好开启 && kind 开启 &&（`document.hidden || !document.hasFocus()`）；点击 → `window.focus()` + 跳转会话路由。`desktop/electron/main.cjs` 补 `app.setAppUserModelId()`（Windows 系统通知的前提，当前缺失）。仅 Electron 生效（`isElectronClient()`，`desktop/src/utils/platform.ts:5`），Web / 安卓不弹。

## 5 实现步骤（总流程）

### 5.1 后端数据层

1. 写迁移 `V131__inbox_notification.sql`（4.1 两张表）。
2. 建 `src/inbox/inbox.repository.ts`：`insertIgnore`（ON DUPLICATE KEY 语义）、分页查询（`unreadOnly` 过滤）、`countUnread`、`markRead(id, userId)`、`markAllRead(userId)`、`deleteById(id, userId)`、`markReadByDedupKey(userId, dedupKey)`（生命周期联动用，完整键等值匹配）、`findByDedupKey`。所有语句带 `user_id` 条件，跨用户访问天然 404。
3. 建 `src/inbox/inbox.service.ts`：`record(...)`（偏好门控 + 幂等写入 + 广播）、`markRead / markAllRead / remove / list / unreadCount`（写后重算并广播）、`resolvePending(userId, kind, sessionId, tail)`（拼完整 dedup_key 联动置已读 + 广播）、`getPreferences / savePreferences`。
4. `create-app.ts` 装配 `InboxService / InboxRepository`，注册路由。

### 5.2 后端写入点（4 类事件 + 2 个联动点）

| # | 位置 | 触发 | dedup 尾段 |
|---|---|---|---|
| 1 | `session/task-terminal.service.ts` `finishExecution` 内（方法 :25 起，`deliveryService.prepare()` 调用在 :62），并列追加 | COMPLETED / FAILED（跳过 SUBAGENT / SIDE_TASK；CANCELLED 不记录）。**排期约束：与长期记忆方案的抽取派发错峰实施，两方案都改本方法** | `executionId` |
| 2 | `harness/tool/tool-dispatcher.ts` ask_user 派发点（`wsEvent('ask_user_questions')` 发出后，约 320 行） | 提问待答（不区分用户在线与否；飞书通道跳过等前置守卫已在既有逻辑中） | `requestId` |
| 3 | `harness/local/local-tool-executor.ts:32-35` 审批注册点（`approvalRegistry.register` 之后） | LOCAL 审批待办 | `requestId` |
| 4 | `harness/delegate/background-subagent-manager.ts` `deliveryStatus → DELIVERED` 状态转移处（约 342/711/843 行，**三处均挂**——幂等键相同，多挂无害、漏挂丢通知）+ `harness/delegate/subagent-result-delivery.service.ts` `deliver()` / `deliverBackground()` 成功回传处（恢复路径） | 子代理结果回传完成 | `executionId` |
| 5 | 联动置已读 A：`tool-dispatcher.ts` `await waiting` 之后（回答 / 取消 / 超时三态统一在此收敛） | QUESTION_PENDING 过期 | `requestId` |
| 6 | 联动置已读 B：`local-tool-executor.ts` `finally` 中 `approvalRegistry.unregister` 之后（批准 / 拒绝 / 超时 / 断连统一收敛） | APPROVAL_PENDING 过期 | `requestId` |

依赖注入方式对齐现有模式：`harness/deps.ts` 增加收件箱记录器接口（参照 `TaskTerminalService` 在 `harness/deps.ts:274` 的声明方式），实现类在 `src/inbox/`，`create-app.ts` 注入；`LocalToolExecutor` 无 userId 上下文，由 `InboxService` 内部经 session 查询补齐（与 `ApprovalRegistry.register → enterWaitingApproval` 同源）。

`SUBAGENT_DONE` 的标题取子会话 `title`（经 `childSessionId` 查 session 表，`SubagentExecution` 行上无标题），查询失败降级用 `taskDescription`；`content` 取 `result` 首行。

### 5.3 REST 面（登录态，`Result<T>` code=0）

`src/inbox/inbox.routes.ts`，`requireUserId(req, deps.jwt)` + `sendJson(reply, 200, ok(...))`，对齐 `notification/task/preference.routes.ts` 惯例。收件箱为个人数据，不挂权限点（无 admin 侧操作）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/inbox` | 分页列表，`page`（默认 1）/ `pageSize`（默认 20，`queryInt` 惯例）/ `unreadOnly` |
| GET | `/api/v1/inbox/unread-count` | 徽标数据源，返回 `{ unreadCount }` |
| POST | `/api/v1/inbox/:id/read` | 单条已读（`is_read=1` + `read_at`） |
| POST | `/api/v1/inbox/read-all` | 全部已读（单条 UPDATE，`idx_notification_user_read` 覆盖） |
| DELETE | `/api/v1/inbox/:id` | 删除单条 |
| GET | `/api/v1/inbox/preferences` | 四个 kind 开关 + `systemNotifyEnabled` |
| PUT | `/api/v1/inbox/preferences` | 保存偏好（`user_inbox_preference` upsert，last-write-wins） |

### 5.4 前端（桌面 / Web / 安卓共用 UI）

1. 新增 `desktop/src/stores/inbox/index.ts`：`items / unreadCount / hasMore`；动作 `fetchList / fetchUnreadCount / markRead / markAllRead / remove / loadMore / setUnreadCount`；偏好读写。
2. 新增 `desktop/src/components/inbox/InboxBell.vue`（铃铛 + 未读徽标，≥100 显示 99+）与 `InboxDrawer.vue`（`el-drawer`：kind 图标、标题、摘要、相对时间、未读标识；点击条目 → `markRead` → session store 打开会话；底部"全部已读"）。
3. `TopNav.vue` `.nav-right`（`SessionSearchPopover` 之前）插入 `InboxBell`。
4. `useStreamWS.ts`：新增 `case 'inbox_updated'`（约 617 行 `session_status` case 附近）；`onopen` 重订阅处（`fetchFocusSessions(true)` 补偿所在，:223-225）追加 `inboxStore.fetchUnreadCount()`。
5. `NotificationSettingsView.vue` 新增「站内收件箱」分区：四个 kind 开关（调用 preferences 接口）；「Electron 系统通知」开关仅 `isElectronClient()` 为真时显示（P2）。
6. P2 Electron 系统通知：新增 `desktop/src/composables/useInboxSystemNotify.ts`。`inbox_updated` 事件只带 `unreadCount`，**通知的 title/body 由渲染端 diff 得出**：满足弹窗条件（总开关 && kind 开启 && `document.hidden || !document.hasFocus()`）时拉取收件箱第一页，与上次已知未读条目集合 diff 出新增条目，用新增条目的 title/content 逐条 `new Notification(...)`，`onclick` → `window.focus()` + 路由跳转关联会话；macOS 需先 `Notification.requestPermission()` 并确认 `granted` 再弹；`main.cjs` 补 `app.setAppUserModelId(...)`（Windows 系统通知前提）。不采用"事件携带内容"方案，避免给非关键事件通道加重。

### 5.5 保留策略与装配

新增 `src/inbox/inbox.cleanup.ts`：`InboxCleanupScheduler`，对齐 `RuntimeCleanupScheduler` 装配模式（`create-app.ts:2254` 一带），每日执行一次 `DELETE ... WHERE created_at < NOW() - INTERVAL 90 DAY LIMIT 1000` 循环删除；保留天数 90 为常量（不做清单 #9）。

## 6 关键约束（防逻辑漂移红线）

1. **不改 webhook 链路**：`TaskNotificationDeliveryService.prepare / suppressPending / resolveWebSocket`、`WebhookDeliveryScheduler` 的任何行为不得因收件箱改变；收件箱写入不受"WS 在线抑制"影响。
2. **服务端权威**：未读数只来自服务端 COUNT；前端禁止本地累加/推导；所有已读/删除以 `user_id` 为边界。
3. **写入点零侵入**：四个写入点均为既有事件位置的追加调用；`finishExecution` 仅新增带默认值的可选参数，既有调用点零改动（接口窄声明副本的同步见 4.2）。
4. **幂等是主防线**：同 `dedup_key` 二次 record 不得产生第二行；重试、取消后重发、排队消费、崩溃恢复四条路径不得产生幽灵通知。
5. **kind 枚举封闭**：`TASK_COMPLETED / TASK_FAILED / QUESTION_PENDING / APPROVAL_PENDING / SUBAGENT_DONE` 之外不新增 kind；CANCELLED、子会话 TASK_COMPLETED 明确不写。

## 7 验收标准（完成定义）

1. `cd backend-ts && npm test` 全绿；新增 spec：
   - `inbox.repository.spec.ts`：幂等（同 dedup_key 二次插入仅一行、并发唯一键兜底）、跨用户读写返回空/404、分页与 unreadOnly、联动置已读。
   - `inbox.service.spec.ts`：偏好关闭不写入、每次写路径后广播 unreadCount、SUBAGENT/SIDE_TASK 抑制、CANCELLED 不写、子会话标题降级。
   - `task-terminal` 相关 spec：COMPLETED/FAILED 各记一次且带正确 notifySource；定时任务路径传 SCHEDULED。
   - `tool-dispatcher` / `local-tool-executor` 相关 spec：QUESTION / APPROVAL 写入与三态（回答/取消/超时）自动置已读。
2. `cd desktop && vue-tsc` 通过（无 ESLint/Prettier，类型即门禁）。
3. `tests/desktop.spec.ts` 新增 `Desktop Inbox` describe（沿用 `page.route` mock 后端模式）：铃铛徽标显示、抽屉条目渲染、点击已读并跳转、全部已读、偏好开关渲染。
4. 手工验收路径：桌面在线收任务完成 → 铃铛即时 +1；手机端已读 → 桌面徽标归零；关闭 SUBAGENT_DONE 偏好 → 子代理完成不产生记录；Electron 失焦收通知 → 点击聚焦并跳转（macOS 首次验证 `requestPermission` 授权路径）；删除关联会话后点击旧条目 → 降级提示不白屏；Web/安卓不弹系统通知。
5. 按 AGENTS.md 完成发版配套：CHANGELOG.md 顶部新版本小节、README.md 功能说明、`skills/mao-cli/SKILL.md` 同步、提案 `docs/proposals/2026-10-02-task-inbox.md` 状态行更新。

## 8 落地清单

### 8.1 backend-ts

- [ ] `db/migration/V131__inbox_notification.sql`（notification + user_inbox_preference）
- [ ] `finishExecution` 窄接口声明同步：`harness/deps.ts:274`、`schedule/scheduled-task.service.ts:122`（传 SCHEDULED 必改）等 6 份副本逐一确认
- [ ] `src/inbox/inbox.repository.ts` + `inbox.repository.spec.ts`
- [ ] `src/inbox/inbox.service.ts` + `inbox.service.spec.ts`
- [ ] `src/inbox/inbox.routes.ts`（7 个端点）
- [ ] `src/inbox/inbox.cleanup.ts`（90 天清理调度器）
- [ ] `src/session/task-terminal.service.ts`：`finishExecution` 加 `notifySource` 可选参数 + 收件箱写入
- [ ] `src/schedule/scheduled-task.service.ts:472,489`：传 `notifySource='SCHEDULED'`
- [ ] `src/harness/deps.ts`：收件箱记录器接口
- [ ] `src/harness/tool/tool-dispatcher.ts`：QUESTION_PENDING 写入 + 解答后联动置已读
- [ ] `src/harness/local/local-tool-executor.ts`：APPROVAL_PENDING 写入 + finally 联动置已读
- [ ] `src/harness/delegate/background-subagent-manager.ts`（:342/:711/:843 三处 DELIVERED 均挂）、`subagent-result-delivery.service.ts`：SUBAGENT_DONE 写入
- [ ] `src/create-app.ts`：装配与路由注册

### 8.2 desktop（桌面 / Web / 安卓共用）

- [ ] `src/stores/inbox/index.ts`
- [ ] `src/components/inbox/InboxBell.vue`、`InboxDrawer.vue`
- [ ] `src/components/common/TopNav.vue`：插入铃铛
- [ ] `src/composables/useStreamWS.ts`：`inbox_updated` case + 重连拉取
- [ ] `src/views/settings/NotificationSettingsView.vue`：「站内收件箱」分区（kind 开关 P1；系统通知开关 P2）
- [ ] （P2）`src/composables/useInboxSystemNotify.ts` + `electron/main.cjs` `setAppUserModelId`

### 8.3 测试与文档

- [ ] `tests/desktop.spec.ts`：`Desktop Inbox` describe
- [ ] `CHANGELOG.md` 顶部新版本小节（`frontend 共用 UI` / `backend-ts 后端` 分节）
- [ ] `README.md`、`skills/mao-cli/SKILL.md`、`docs/proposals/2026-10-02-task-inbox.md` 状态同步

## 9 风险与应对

| 风险 | 应对 |
|---|---|
| 相位收敛重复进入（重试 / 取消后重发 / 排队消费 / 崩溃恢复）导致幽灵通知 | `dedup_key` 按 executionId 幂等为主防线；验收标准 1 的四条路径回归用例必须覆盖 |
| 多端同时在线未读数漂移（桌面 + 手机 + IM） | 服务端 COUNT 为权威值；WS 只广播权威数；重连后拉取兜底；前端禁止本地推导 |
| 提问 / 审批 900 秒超时后条目误导 | 联动自动置已读（4.3）；条目保留，payload 摘要仍可读 |
| 子代理标题需二次查询（`childSessionId` → session 表） | 查询失败降级 `taskDescription`；dedup 以 executionId 不受影响 |
| `inbox_updated` 非关键事件在弱网下丢失 | 重连 `fetchUnreadCount()` 兜底；不加入 `CRITICAL_EVENT_TYPES` 避免关键通道膨胀 |
| read-all / 大量未读时 UPDATE 压力 | 单条 UPDATE 命中 `idx_notification_user_read`；清理任务分批 LIMIT 1000 |
| 并行子代理完成刷屏 | SUBAGENT_DONE 默认关 + 子会话 TASK_COMPLETED 抑制（决策记录 #5、#8） |
| 与长期记忆方案并行改 `finishExecution` | 排期错峰（两方案均为追加式改动，参数带默认值、互不依赖） |
| 条目关联会话被删除后点击跳转 | session 为软删除、行保留；前端对"会话不存在/已删除"降级为提示并保留条目 |

## 10 决策记录（与需求方共识）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 实施范围 | P1 + P2 本期实施；P3 Web Push 不做（写入不做清单），安卓以 IM 通道兜底 |
| 2 | 表结构 | `notification` 表已在 V058 被 DROP，V131 新建；沿用表名，去掉无读写方的 `type` 列，仅用 `kind` |
| 3 | 待办生命周期 | QUESTION / APPROVAL 被回答 / 处理 / 超时后对应条目自动置已读（保留可查，不计未读） |
| 4 | 与 IM 提醒关系 | `prepareAskUser` 离线 IM 卡片保留不变；收件箱 kind 开关独立，两渠道并存不联动 |
| 5 | 默认偏好 | TASK_COMPLETED / QUESTION_PENDING / APPROVAL_PENDING 默认开；SUBAGENT_DONE 默认关 |
| 6 | 取消态 | CANCELLED 不写入收件箱 |
| 7 | Electron 系统通知时机 | 仅窗口未聚焦 / 最小化时弹出；点击聚焦并跳转会话 |
| 8 | 子代理双重通知 | 子代理会话收敛抑制 TASK_COMPLETED，完成统一由 SUBAGENT_DONE 承载；延伸至 SIDE_TASK 会话（侧任务面板未读已承载） |
| 9 | 偏好存储（技术拍板） | 新建 `user_inbox_preference` 表——preference 域无通用 KV，遵循"每类偏好独立表"惯例 |
| 10 | WS 事件与来源透传（技术拍板） | `inbox_updated` 为非关键事件（重连拉取兜底）；`finishExecution` 新增默认值可选参数透传 SCHEDULED 来源，既有调用方零改动 |
