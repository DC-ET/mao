# 提案：任务收件箱（站内通知中心）

- 状态：已实施（P1 收件箱全链路 + P2 Electron 系统通知，P3 Web Push 不做）；0.0.235 发版
- 日期：2026-10-02
- 技术方案：`docs/plan/2026-10-02-task-inbox-technical-design.md`
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

异步事件在 Mao 里已经很多，但"结果回来"这件事没有统一入口：

- **任务完成/失败**：`backend-ts/src/session/task-terminal.service.ts:95` 在相位收敛到 `COMPLETED` / `FAILED` 时调用 `TaskNotificationDeliveryService.prepare()`，落 `task_notification_delivery` 行，由 `delivery.scheduler.ts` 轮询投递（任务 webhook、飞书卡片，钉钉走同一监听器）。用户 WS 在线时抑制投递（`suppressedByWebSocket`）——也就是说，**在线的人反而没有任何站内提醒**。
- **提问待答**：`ask_user_questions` 产生 pending question，只在会话运行时 UI（QuestionPanel）里可见。
- **审批待办**：LOCAL 审批卡（ApprovalStack / `harness` 的 approval 基建）同样只在会话内可见。
- **后台子代理**：结果经 `harness/delegate/` 回传主会话，完成通知走 IM 渠道。
- **定时任务**：`src/schedule` 跑在会话队列上，产出只能去会话列表翻。
- **已有但空置的资产**：`notification` 表（早期迁移两次 CREATE TABLE）字段齐全（user_id / type / title / content / is_read / related_type / related_id），**但 `src/` 下没有任何读写方**——遗留空表，正好是收件箱的地基。
- 前端：`useStreamWS.ts` 已处理 `session_status` / `session_list_update` 等服务端事件；session store 已有未读概念；`NotificationSettingsView` 已有通知偏好页。

## 2. 目标 / 非目标

**目标**

1. 站内收件箱：聚合任务完成/失败、提问待答、审批待办、后台子代理完成等事件，一处查看、一键跳转。
2. 实时性：WS 在线推送未读数；离线登录/重连后拉取兜底。
3. Electron 系统通知；安卓/Web 走 Web Push（第三阶段探索）。
4. 每 类事件的偏好开关，与现有 IM/webhook 渠道并存不冲突。

**非目标**

- 不做收件箱内直接回复/审批（只读 + 跳转会话，操作仍在会话面板完成，避免两套操作语义）。
- 不替代 IM 通道通知（飞书/钉钉/微信卡片保留，收件箱是站内补充）。
- 不做管理后台收件箱（个人数据，admin 不聚合展示）。

## 3. 技术方案

### 3.1 数据模型（迁移 V129，启用遗留表）

```sql
ALTER TABLE `notification`
    ADD COLUMN `kind`        VARCHAR(48)  NULL AFTER `type`,
    ADD COLUMN `session_id`  BIGINT       NULL AFTER `related_id`,
    ADD COLUMN `payload_json` JSON        NULL AFTER `session_id`,
    ADD COLUMN `dedup_key`   VARCHAR(128) NULL AFTER `payload_json`,
    ADD COLUMN `read_at`     DATETIME     NULL AFTER `is_read`,
    ADD UNIQUE KEY `uk_notification_dedup` (`dedup_key`),
    ADD INDEX `idx_notification_user_created` (`user_id`, `created_at`);
```

- `type` 列保留（SYSTEM/TASK/AGENT），`kind` 为收件箱细分：

| kind | 触发点 | payload 摘要 |
|---|---|---|
| TASK_COMPLETED / TASK_FAILED | task-terminal 相位收敛（COMPLETED/FAILED） | 任务标题、来源（普通/定时任务/后台子代理） |
| QUESTION_PENDING | `ask_user_questions` 工具落 pending 时 | 问题摘要 |
| APPROVAL_PENDING | 审批请求创建时（`harness` approval 基建） | 命令/工具摘要、权限档位 |
| SUBAGENT_DONE | `harness/delegate/` 结果回传时 | 子代理标题、结论首行 |

定时任务不单设 kind：执行仍走会话相位，payload 里带 `source=SCHEDULED` 徽标（队列行已有来源透传机制）。

### 3.2 写入路径

新增 `backend-ts/src/inbox/`（routes / service / repository），`InboxService.record()` 统一入口：

- 幂等：`dedup_key = "{userId}:{kind}:{sessionId}:{executionId|questionId|approvalId}"`，唯一键冲突即忽略（ON DUPLICATE 语义）。
- 四个写入点全部在既有事件位置追加调用，不改原有链路：task-terminal 收敛点（与 `prepare()` 并列）、ask-user-questions 工具实现、审批 pending 创建处、subagent 结果回传处。
- 写库成功后经 `session/ws/streaming-ws-registry.ts` 向该用户所有在线连接广播 `inbox_updated { unreadCount }`；服务端未读数是权威值，前端不做本地累加。
- 与现有 webhook 抑制逻辑对齐：收件箱写入**不受**"WS 在线抑制"影响（它就是在线 UI），webhook 投递行为不变。

### 3.3 REST 面（用户域，登录态，`Result<T>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/inbox` | 分页列表，`unreadOnly` 过滤 |
| GET | `/api/v1/inbox/unread-count` | 徽标数据源 |
| POST | `/api/v1/inbox/:id/read` | 单条已读（写 is_read + read_at） |
| POST | `/api/v1/inbox/read-all` | 全部已读 |
| DELETE | `/api/v1/inbox/:id` | 删除单条 |

偏好：按 kind 的开关入 `src/preference` KV（`inbox_kind_<KIND>_enabled`），关闭后该类事件不再写入。

### 3.4 前端落点（桌面 / Web / 安卓共用 UI）

- 顶栏铃铛组件 + 收件箱抽屉（desktop `components/`）：按 kind 分组图标、相对时间、未读徽标；条目点击跳转会话（session store 定位打开），QUESTION / APPROVAL 类跳转后对应面板自然呈现。
- `useStreamWS.ts` 新增 `inbox_updated` case → 写入 store；断线重连后主动拉一次 unread-count（复用现有重连补偿模式）。
- 偏好：`NotificationSettingsView` 新增"站内收件箱"分区。
- **Electron 系统通知（P2）**：渲染端 Web Notification API + `desktop/electron/main.cjs` 点击聚焦窗口；遵循现有"偏好开关"语义。
- **Web Push（P3，探索）**：VAPID + Service Worker。安卓壳远程加载 Web，理论可行；但 Android WebView 的 Push 依赖 Google Play services，国内 ROM 普遍不可用——若不可行则明确放弃，安卓继续以 IM 通道为兜底（本次不做原生推送的约束不变）。

### 3.5 保留策略

默认保留 90 天，每日清理任务（复用 schedule 域的定时器模式）；不做归档。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 迁移 + InboxService + 四个写入点 + REST + Web/Electron 铃铛与抽屉 | 中 |
| P2 | Electron 系统通知 + 按 kind 偏好开关细化 | 小 |
| P3 | Web Push 探索（含安卓可行性验证，不行即放弃） | 小 |

## 5. 风险与开放问题

- **重复通知风暴**：同一执行的重试、取消、崩溃恢复路径（历史 0.0.229 等修复涉及的场景）可能多次进入相位收敛。dedup_key 按 executionId 幂等是主防线；回归用例必须覆盖"取消后重发""排队消费""恢复执行"三条路径。
- **未读数一致性**：多端同时在线（桌面 + 手机 + 飞书），已读状态以服务端为准，WS 事件只带权威未读数，前端禁止本地推导。
- **打扰度**：默认只开 TASK_COMPLETED / QUESTION_PENDING / APPROVAL_PENDING，SUBAGENT_DONE 默认静音（可在偏好打开），避免并行子代理刷屏。
- **开放问题**：QUESTION_PENDING 是否应额外触发 IM 提醒（现有"提问通知"标题已存在于 webhook 文案中）？收件箱上线后两者关系（合并开关还是独立开关）在实施时定。

## 6. 测试要点

- 幂等：同 dedup_key 二次 record 不产生第二行；并发 record 唯一键兜底。
- 相位收敛：COMPLETED / FAILED 各记一次；重试、取消后重发、排队消费、崩溃恢复不产生幽灵通知。
- WS：`inbox_updated` 广播到该用户全部连接、不串号到其他用户。
- REST：跨用户读写 404；read-all 与单条已读并发收敛。
- 前端：徽标更新、跳转定位、偏好关闭后不再写入（可加入现有 Playwright desktop spec）。
