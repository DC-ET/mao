# 任务收件箱（站内通知中心）技术方案

- 日期：2026-10-02
- 状态：**已实施**（P1 + P2 于 0.0.235 落地；P3 Web Push 不做）。实施偏差两处：① 技术方案原写「P2 的 `system_notify_enabled` 由 P2 迁移 ADD COLUMN，P1 不建死列」，因 P1/P2 同批落地，直接在建表的 V131 中建出该列，避免一次无意义发版持有死列；② 系统通知的「新增条目 diff」最初与「打开抽屉播种」共用 `fetchList()` 写路径，被常驻的 `InboxDrawer` items watcher 抢先播种导致 diff 恒为空、通知零触发（审查 BUG-6），改为 store 侧只读 peek（`peekInboxFirstPage()`，不写 `items`），diff 数据源与播种器解耦。
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

1. 站内收件箱：聚合以下五类事件，一处查看、一键跳转会话，操作仍在会话面板完成：
   - `TASK_COMPLETED`：会话相位收敛到 COMPLETED（主会话）。
   - `TASK_FAILED`：会话相位收敛到 FAILED（主会话）。
   - `QUESTION_PENDING`：`ask_user_questions` 产生待答提问。
   - `APPROVAL_PENDING`：LOCAL 审批请求创建。
   - `SUBAGENT_DONE`：子代理结果回传父会话完成（覆盖 COMPLETED / FAILED / CANCELLED 三种子代理终态，见决策记录 #11）。
2. 实时性：服务端写库后经 WS 向该用户全部在线连接广播 `inbox_updated { unreadCount }`（该事件已列 `CRITICAL_EVENT_TYPES`）；断线重连后前端主动拉取兜底，且每次打开抽屉也会强制重拉。
3. Electron 桌面端系统通知（仅窗口未聚焦时弹出，点击聚焦并跳转）。
4. 按 kind 的偏好开关，与现有 IM/webhook 渠道并存、开关独立、互不门控。

### 2.2 核心交互

- 顶栏铃铛显示权威未读数（服务端为唯一权威，前端不做本地累加）；点击展开收件箱抽屉。
- 条目按 kind 显示图标、标题、摘要、相对时间；未读条目有标识。
- 点击条目：标记已读并跳转关联会话（QUESTION / APPROVAL 跳转后会话内对应面板自然呈现；提问超过 900 秒超时或审批已处理时，条目已在此前被自动置为已读，payload 摘要仍可读）。关联会话已被删除（session 为软删除、列表不再展示）时，前端跳转降级为提示并保留条目，不报错白屏。
- 会话「列表未读」与收件箱未读是**两套独立概念**：前者是 `session.unread`（DB 列，终态由 `session.service.ts:1021-1025` 写 1，微信/飞书排除），体现为会话列表圆点；后者只由 `notification.is_read` 决定，体现为顶栏铃铛徽标。二者不得互相推导或换算（红线 #2）。
- 定时任务产生的条目 payload 带 `source: 'SCHEDULED'`，前端显示「定时任务」徽标（来源透传机制见 4.2）。
- 子代理产生的条目（`SUBAGENT_DONE`）payload 带 `status`（COMPLETED / FAILED / CANCELLED），标题/摘要据此区分「已完成 / 执行失败 / 已取消」，避免失败被表述成完成（决策记录 #11）。
- 偏好页新增「站内收件箱」分区：四个 kind 开关（独立保存，不并入 webhook 偏好页的单次保存）+ Electron 系统通知总开关（仅 Electron 显示，P2）。
- 保留 90 天自动清理。

## 3 明确不做（不做清单）

| # | 不做的事 | 理由 |
|---|---|---|
| 1 | Web Push（VAPID + Service Worker），含安卓可行性探索（P3） | 安卓壳远程加载 Web，Android WebView 的 Push 依赖 Google Play services，国内 ROM 普遍不可用；安卓继续以 IM 通道为兜底，不做原生推送 |
| 2 | 收件箱内直接回复 / 审批 | 只读 + 跳转会话，操作仍在会话面板完成，避免两套操作语义 |
| 3 | 替代或改动现有 IM/webhook 通知 | 收件箱是站内补充；`TaskNotificationDeliveryService` 的 prepare/suppress/投递链路行为不变 |
| 4 | 管理后台收件箱 | 个人数据，admin 不聚合展示 |
| 5 | CANCELLED 终态写入收件箱 | 取消多由用户自己发起，无通知价值，保持收件箱低噪 |
| 6 | 子代理（`sessionType='SUBAGENT'`）与侧任务（`sessionType='SIDE_TASK'`）会话的 TASK_COMPLETED 记录 | 子代理完成由 SUBAGENT_DONE 单独承载（避免同一完成产生两条通知）；侧任务已有侧任务面板未读徽标承载。**排除条件按 `session.sessionType` 判定，不得用 `parentSessionId` 近似**——SIDE_TASK 可被 `promoteSideTaskToMainSession`（`session.service.ts:590`）升级为 `parentSessionId=null, sessionType='NORMAL'` 的主会话，用 parentSessionId 会漏判 |
| 7 | 收件箱归档、收件箱内搜索、按 kind 的列表过滤 | 超出本期范围，列表仅支持 `unreadOnly` 过滤 |
| 8 | ask_user 离线 IM 提醒（`prepareAskUser`）与收件箱开关联动 | 两渠道并存、开关独立（决策记录 #4） |
| 9 | 通知偏好配置化（如保留天数进 system_setting） | 90 天为代码常量，KISS |
| 10 | QUESTION / APPROVAL 条目携带 executionId 关联执行 | `tool-dispatcher` / `local-tool-executor` 两处均无 executionId 上下文（WS 帧上的 executionId 由 `streaming-ws-handler.ts` 的 `runningExecutionIds` 附加，工具层拿不到）；条目只关联 session，payload 不塞 executionId |
| 11 | 同步 delegate（invocationType 非 BACKGROUND/FOLLOWUP）的子代理结果写收件箱 | 只挂 `deliverBackground()`；同步 delegate 已有即时工具结果返回主代理，再入收件箱会构成双重通知（决策记录 #8 同源） |
| 12 | `inbox_updated` 事件携带条目内容 | 帧只带权威 `unreadCount`；条目内容由渲染端拉列表后 diff 得出，避免给事件通道加重（见 5.4 P2） |

## 4 技术选型

### 4.1 数据模型（迁移 V131）

新迁移 `backend-ts/db/migration/V131__inbox_notification.sql`，一次包含两张表。迁移号避让：长期记忆方案占 V129/V130、Agent 资产包方案占 V132（2026-10-02 评审统一定号），本方案由原 V129 顺延为 V131：

```sql
CREATE TABLE notification (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    user_id       BIGINT       NOT NULL,
    kind          VARCHAR(48)  NOT NULL COMMENT 'TASK_COMPLETED/TASK_FAILED/QUESTION_PENDING/APPROVAL_PENDING/SUBAGENT_DONE',
    title         VARCHAR(256) NOT NULL,
    content       TEXT         NULL COMMENT '摘要正文，对外展示一行',
    is_read       TINYINT      NOT NULL DEFAULT 0,
    read_at       DATETIME     NULL,
    session_id    BIGINT       NULL COMMENT '跳转目标会话；会话被删后降级提示（见 2.2）',
    payload_json  JSON         NULL COMMENT '随事件附带的要素：source、status、requestId、executionId、错误原因等',
    dedup_key     VARCHAR(128) NOT NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_notification_dedup (dedup_key),
    KEY idx_notification_user_created (user_id, created_at),
    KEY idx_notification_user_read (user_id, is_read)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '站内收件箱条目';

CREATE TABLE user_inbox_preference (
    user_id                   BIGINT  NOT NULL COMMENT '用户ID',
    task_completed_enabled    TINYINT NOT NULL DEFAULT 1 COMMENT '任务完成',
    question_pending_enabled  TINYINT NOT NULL DEFAULT 1 COMMENT '提问待答',
    approval_pending_enabled  TINYINT NOT NULL DEFAULT 1 COMMENT '审批待办',
    subagent_done_enabled     TINYINT NOT NULL DEFAULT 0 COMMENT '子代理完成（默认关，防并行子代理刷屏）',
    created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '用户收件箱偏好';
```

- **不保留提案中的 `type` 列**（SYSTEM/TASK/AGENT）：全新建表且无任何读写方，保留即永久 NULL 死列，kind 一列足够（决策记录 #2）。
- `user_inbox_preference` 而非"偏好 KV"：preference 域不存在通用 KV，惯例是每类偏好独立表 + repository（如 `user_weixin_preference` / `user_task_panel_preference`），本表沿用该模式，免 version 乐观锁（开关写入采用 last-write-wins，同 `user_weixin_preference`）。
- `system_notify_enabled` **不在 V131 建出**：P2 届时 `ALTER TABLE user_inbox_preference ADD COLUMN system_notify_enabled TINYINT NOT NULL DEFAULT 1` 即可。P1 建出即犯本方案自己在决策记录 #2 里反对的"永久 NULL 死列"，一次 ADD COLUMN 的 P2 迁移比一个死列更符合 KISS。
- **`related_type` / `related_id` 与 `session_id` 语义重叠，一并去掉**：跳转只依赖 `session_id`（2.2），`requestId` / `executionId` 等执行要素已在 `payload_json` 内，`related_*` 若保留会永久半冗余（无任何读取方按 related_type 过滤的需求）。表形状收敛为 `session_id` + `payload_json`。
- 默认值即决策记录 #5 的打扰度设计：前三类开、`subagent_done` 关。
- `payload_json` 用 `JSON NULL`（NOT NULL 会要求每条都带 payload；`V085__feishu_pending_binding_message.sql` 的 `event_json JSON NOT NULL` 是纯事件表，形态不同）。仓内列注释用中文（`V010__session_activity.sql`），不用英文。

### 4.2 写入路径与幂等

新增域 `backend-ts/src/inbox/`（`inbox.routes.ts` / `inbox.service.ts` / `inbox.repository.ts` / spec 同目录）。`InboxService` 为统一入口：

- **幂等**：`dedup_key = "{userId}:{kind}:{sessionId}:{executionId|requestId}"`，落库用 `INSERT ... ON DUPLICATE KEY UPDATE id = id`，命中唯一键即无操作；并发冲突由唯一键兜底。
  - `ON DUPLICATE KEY UPDATE id = id` 是刻意选择（区别于仓内 8 处 `VALUES(col)` 真覆盖先例，如 `feedback.repository.ts:54`、`feishu/message.repository.ts:125`）；`id = id` 保证「插入即忽略」：retry / 取消后重发 / 排队消费 / 崩溃恢复不得刷新 `created_at` 排序、不得把已读条目打回未读。
  - **key 构造必须单一导出**：`inboxDedupKey(userId, kind, sessionId, tail)` 一个函数，写入侧（task-terminal / tool-dispatcher / local-tool-executor / subagent 四处）与置已读侧（tool-dispatcher / local-tool-executor 两处）**共用同一实现**。禁止两侧各自拼接字符串——这是本方案最典型的漂移点；`inbox.service.spec.ts` 需锁住「写入键 === 置已读读取键」。
  - `executionId` 语义须在测试口径中明确：崩溃恢复（`crash-recovery-runner.ts:377`）、重试（`streaming-ws-handler.ts:1089`）、排队消费均为**新 executionId**，产生新条目是**预期行为**，不属于"幽灵通知"。真正的重复收敛风险是**同一 executionId 二次进入终态**（`handleCancel` 立即落 CANCELLED + 执行体 finally 二次收敛），由 `finishCancelledSession:1807` 的终态早退 + `finishExecution:45-51` 的 already-terminal 早退双保险 + dedup 唯一键三重防护。
- **权威未读数**：每次写路径（写入 / 单条已读 / 全部已读 / 删除 / 联动置已读）之后 `SELECT COUNT(*) ... WHERE user_id = ? AND is_read = 0`，并经 `streaming-ws-registry.send(userId, wsEvent('inbox_updated', null, { unreadCount }))` 广播到该用户全部在线连接。
- **WS 事件定位**：`inbox_updated` **加入** `CRITICAL_EVENT_TYPES`（`streaming-ws-registry.ts:54`）。它不是会话状态类关键事件，但普通帧队列满时是**直接丢弃**（`streaming-ws-registry.ts:411`，`dropSlow`），弱网/高频会话下未读数会静默停留在旧值且无主动重拉入口。收件箱事件日均为个位数到数十条，不会挤占关键通道。仍保留"重连后拉取 unread-count 兜底"（见 5.4），双保险。
- **偏好门控**：`record()` 前查 `user_inbox_preference`（无行时按列默认值），kind 关闭则不写入。
- **来源与子会话抑制**：`TASK_COMPLETED/FAILED` 写入点在 `session/task-terminal.service.ts:74`（`this.prepareDelivery(session, phase, executionId, failureReason ?? null)` 调用处，即 `finishExecution` 内 `prepare()` 并列位置；原文档"方法 :25 起、prepare 在 :62"是旧行号，实际方法起于 `:35`、私有封装调用在 `:74`、`deliveryService.prepare()` 本体在 `:139`）。追加条件：
  - `session.sessionType === 'SUBAGENT' || session.sessionType === 'SIDE_TASK'` 时跳过（决策记录 #8）。
    - **必须读 `session.sessionType`，不得用 `parentSessionId != null` 近似**：SIDE_TASK 可被 `promoteSideTaskToMainSession`（`session.service.ts:590`）升级为 `parentSessionId=null, sessionType='NORMAL'` 的独立主会话，用 parentSessionId 判定会漏判。仓内自身一律双条件判（`task-terminal.service.ts:89`）。
    - 本排除范围写成"两者"，与 `dispatchMemoryExtraction`（`task-terminal.service.ts:107`，排除 SUBAGENT + SIDE_TASK）一致；**注意与 `delivery.service.ts:51`（只排除 SUBAGENT）不同**，实施者易照抄后者而漏掉边路任务。
    - 实测边界：`sessionType='NORMAL'` + `parentSessionId=3`（被提升过的边路任务）→ 记 1 条收件箱，`prepare()` 记 2 条——符合预期（两者职责不同）。
  - **只记 `COMPLETED` / `FAILED`**：`phase !== 'COMPLETED' && phase !== 'FAILED'` 直接 return（同 `delivery.service.ts:48` 的写法）。
    - CANCELLED **会真实到达 `:74`**：`finishCancelledSession`（`streaming-ws-handler.ts:1803-1809`）有 13 个调用方，全部汇聚到同一条 `finishExecution(sessionId, userId, 'CANCELLED', executionId)` 路径。因此 CANCELLED 不能靠调用点天然过滤，**必须显式写死**。
  - 微信/飞书通道会话（`weixin-bot` projectKey / feishu workspace）跳过：`task-terminal.service.ts:66` 对这两类会话连 `session.unread` 都不置 1，它们由机器人触发、无"用户等着看站内"的语义。
  - **不写入未知用户**：`ownerId = session.userId ?? userId`，`notification.user_id NOT NULL`，为 null 时跳过（对照 `task-terminal.service.ts:75` 的 `ownerId == null` 分支）。
- **来源透传（timing 决策 #1：方案 A）**：`finishExecution` 新增可选第 6 参 `notifySource: 'MANUAL' | 'SCHEDULED' = 'MANUAL'`，写入 `payload_json.source`，前端据此前置「定时任务」徽标。
  - 现状：生产环境定时任务走 `create-app.ts:1147` 无条件注入的 `liveExecution`（`wsHandler.executePersistedUserPrompt`），**不会执行** `scheduled-task.service.ts:472`（impl 分支）；`liveExecution` 抛异常时才落 `:489`（catch 里的 FAILED，本级 finish 只调 1 次 `markTaskResult`）。
  - 实现：`StreamingWsHandler` 侧维护 `scheduledTaskIds: Map<number, number>`（镜像 `queueScheduledTaskIds`，`streaming-ws-handler.ts:186` 的模式），由 `executePersistedUserPrompt` 入口写入、`runExecution` finally 按归属清理；`runExecution`（`:531`，**私有方法**）加 `scheduled` flag 形参转发给三个 finisher（`:1788 / :1799 / :1807`），再经 `finishExecution` 第 6 参传出。
  - busy 入队路径（`scheduled-task.service.ts:414`）也经 liveExecution，同一个入口即被覆盖。
  - 由此**窄接口只需扩 2 份**：`streaming-ws-handler.ts:84`（三处调用点需改调用）与 `scheduled-task.service.ts:122`（保 `liveExecution == null` 的遗留/测试路径）。其余 4 份（`harness/deps.ts:274`、`dingtalk/runtime.ts:83`、`weixin/agent-inbound-handler.ts:58`、`harness/delegate/subagent-visibility-service.ts:26`）结构兼容、按默认值 MANUAL 零改动；`create-app.ts:1490`（CANCELLED，不写收件箱）、`create-app.ts:1697`（`onExecutionFinished`，外部触发，无 taskId，算 MANUAL 合理）、`crash-recovery-runner.ts:411`（CANCELLED，同样不写）、`dingtalk/runtime.ts:315/528`、`agent-inbound-handler.ts:211/229/343` 均 MANUAL。
  - **TS 窄接口无告警**：给 6 份窄接口消费方加第 6 参时，缺省调用点既不会报错也不会生效，只会静默取默认值。因此"定时任务路径传 SCHEDULED"必须是 spec 断言项（生产路径 `finishCompletedSession` / `finishFailedSession`，而非 `scheduled-task.service.ts:472`）。
  - **不新增 `ExecutionSource` 联合类型**：本仓 `phase` / `executionMode` / `sessionType` 一律裸 `string`，造独立联合类型会被 4 份窄接口结构削弱成大段落差。

### 4.3 待办类条目的生命周期联动

提问与审批 pending 均为内存态（900 秒超时），收件箱记录是持久的，联动规则：**问题被回答/取消/超时、审批被批准/拒绝/超时/断连后，对应条目自动置为已读**（`is_read=1, read_at=NOW()`，条目保留在列表可查，不再计入未读徽标；决策记录 #3）。置已读时 userId / kind / sessionId / 尾段四要素齐全，**直接拼出完整 `dedup_key` 等值匹配**（命中 `uk_notification_dedup`），不做尾段 LIKE 扫描。`markReadByDedupKey` 幂等（第二次 UPDATE 影响 0 行），因此重复触发安全。

**三态/四态判定必须读结构化标记，禁止解析 `resultJson` 文本**（`ask-user-questions-registry.ts:12-20` 已明确禁止凭内容猜语义）：

| 场景 | 判定 |
|---|---|
| 提问被正常回答 | `result.answered === true`（`tool-dispatcher.ts:340` 之后） |
| 提问随会话取消（stop / 取消） | `result.answered === true && result.cancelled === true`（`failAllForSession` 以 `cancelled:true` 标记 resolve） |
| 提问 900s 超时 | `result.answered === false`（registry 内部 `Promise.race` 超时并 delete 登记） |
| 审批被批准/拒绝 | `streaming-ws-handler.ts:773 handleToolApproval` 立即 `unregister`（不等命令跑完） |
| 审批超时/执行异常/断连 | `local-tool-executor.ts:56` finally 的 `unregister` |

**审批置已读只挂 `local-tool-executor.ts:56` 一处**：`handleToolApproval` 的 unregister 不重复挂点，否则「已批准 → 命令仍在跑」窗口内会双触发（幂等兜底没错，但语义上取一个点更清晰）。

### 4.4 前端技术选型

- Vue3 `<script setup>` + Pinia + Element Plus（桌面现有栈）；抽屉用 `el-drawer`。
- 新 store `desktop/src/stores/inbox/`（`defineStore`），状态：`items / unreadCount / hasMore`。
- WS 接入：`useStreamWS.ts` 新增 `case 'inbox_updated'`（写入 `inboxStore.setUnreadCount`）；`onopen` 重订阅处增加一次 `fetchUnreadCount()` 静默重拉（对齐现有 `fetchFocusSessions(true)` 重连补偿模式；**但不得包在 `if (sessionStore.focusLoaded)` 里**，聚焦列表未加载时徽标也要能更新）。
- **Electron 系统通知**：渲染端 Web Notification API（Electron 下 HTML5 Notification 直接走系统通知，无需 IPC），触发条件 = 偏好开启 && kind 开启 &&（`document.hidden || !document.hasFocus()`）；点击 → `window.focus()` + 跳转会话路由。**`main.cjs` 路径是 `desktop/electron/main.cjs`**（原文档写 `desktop/src/electron/main.cjs`，依据 `desktop/package.json:6` `"main": "electron/main.cjs"`）；补 `app.setAppUserModelId('cn.etarch.mao.desktop')`（Windows 系统通知的前提，当前缺失；`main.cjs:14` 仅 `app.setName('Mao')`，appId 见 `desktop/package.json:64`）。仅 Electron 生效（`isElectronClient()`，`desktop/src/utils/platform.ts:5`），Web / 安卓不弹。
  - **降级路径**：`Notification.requestPermission()` 返回 `denied` 时**不弹窗、不报错**，静默回落到站内徽标（红点仍会更新）。仓内 `new Notification(` / `requestPermission` 零先例，属净新能力。
  - **预期台词风险**：仓内无"Electron 28 下 HTML5 Notification 确实走系统通知"的验证样例，仅有 AGENTS.md 结论与 P2 表格。实施期间需在真实 Electron 窗体验证一次（见 7.4 验收标准），这是本方案唯一一处"无本地样例可依"的判断。
  - **`document.hidden || !document.hasFocus()`**：`hidden` 覆盖最小化，`hasFocus` 覆盖"窗口可见但未聚焦"，二者取或即可。文档锁定这个表达式，避免后续实现再引入别的口径。
- **数字徽标**：优先复用 `SkillManager.vue:125-130` 的 `el-badge` + `:deep(.el-badge__content)` 写法（天然支持 `:max="99"`，无需自己写 99+ 逻辑）。顶栏小红点可仿 `TopNav.vue:532-538` 的 `.update-dot`（10px 圆点配 `.has-update`）。
- **相对时间**：复用 `desktop/src/composables/useRelativeTime.ts`（已有两份实现，`SessionSearchPopover.vue:233` 是第二份），**不要再写第三份**。

## 5 实现步骤（总流程）

### 5.1 后端数据层

1. 写迁移 `V131__inbox_notification.sql`（4.1 两张表）。
2. 建 `src/inbox/inbox.repository.ts`：`insertIgnore`（ON DUPLICATE KEY `id = id` 语义）、分页查询（`unreadOnly` 过滤）、`countUnread`、`markRead(id, userId)`、`markAllRead(userId)`、`deleteById(id, userId)`、`markReadByDedupKey(userId, dedupKey)`（生命周期联动用，完整键等值匹配；幂等，影响 0 行不报错）、`findByDedupKey`。所有语句带 `user_id` 条件，跨用户访问天然 404。参照 `feedback/feedback.repository.ts` 的薄封装风格（`Db` 直调 `execute/query/queryOne`，无 ORM）。
3. 建 `src/inbox/inbox.service.ts`：`record(...)`（偏好门控 + 幂等写入 + 广播）、`markRead / markAllRead / remove / list / unreadCount`（写后重算并广播）、`resolvePending(userId, kind, sessionId, tail)`（拼完整 dedup_key 联动置已读 + 广播）、`getPreferences / savePreferences`。
4. `create-app.ts` 装配 `InboxService / InboxRepository`，注册路由。

### 5.2 后端写入点（5 类事件 + 2 个联动点，共 8 处）

| # | 位置 | 触发 | dedup 尾段 |
|---|---|---|---|
| 1 | `session/task-terminal.service.ts:74` `finishExecution` 内，与 `this.prepareDelivery(...)` 并列追加 | COMPLETED / FAILED（跳过 SUBAGENT / SIDE_TASK、微信/飞书通道；CANCELLED 显式不记）。**排期约束：与长期记忆方案的抽取派发错峰实施，两方案都改本方法** | `executionId` |
| 2 | `harness/tool/tool-dispatcher.ts:320` ask_user 派发点（`wsEvent('ask_user_questions')` 发出之后） | 提问待答（不区分用户在线与否；飞书通道跳过等前置守卫已在既有逻辑中）。**禁止改挂 `streaming-ws-handler.ts:320` 的 WS 快照/重订阅处**——那处每次重连重发，会重复写入 | `requestId` |
| 3 | `harness/local/local-tool-executor.ts:33` 审批注册点（`approvalRegistry.register` 之后；注册行 `:33`，后续新增 pub 在 `:34-35`） | LOCAL 审批待办 | `requestId` |
| 4a | `harness/delegate/background-subagent-manager.ts:342`（`persistCompletionNotice` + `updateById DELIVERED` 之后） | 用户重试执行收敛后的子代理结果回传完成 | `executionId`（`SubagentExecution.id`；**该实体无 `executionId` 字段**，见 `session/types.ts:147-149`） |
| 4b | `harness/delegate/background-subagent-manager.ts:711`（DELIVERED 前一行的 `persistCompletionNotice` 之后） | 正常 spawn 路径子代理完成（含 CANCELLED 经由 `onCompletedCancelled` 汇入） | 同上 |
| 4c | `harness/delegate/background-subagent-manager.ts:843`（`failExecution` 的 DELIVERED 之后） | 子代理执行失败路径；触发条件 spawn 异常 / 子会话终态 FAILED | 同上 |
| 4d | `harness/delegate/subagent-result-delivery.service.ts:126` `deliverBackground()` 成功回传处 | **只挂 `deliverBackground()`，不要挂 `deliver()`**。`deliver()` 内部按 `invocationType` 分派：BACKGROUND/FOLLOWUP 才走 `deliverBackground`（`:63`），其余同步 delegate 走另一条"消息对重建"路径（`:64-121`），两者性质相同但同步 delegate 不该写（不做清单 #11）。恢复路径唯一调用方是 `subagent-recovery-coordinator.ts:79` 的 `recoverGroup` | 同上 |
| 5 | 联动置已读 A：`tool-dispatcher.ts:340` `await waiting` 之后（回答/取消/超时三态统一在此收敛；判定见 4.3） | QUESTION_PENDING 过期 | `requestId` |
| 6 | 联动置已读 B：`local-tool-executor.ts:56` finally 中 `approvalRegistry.unregister` 之后（批准/拒绝/超时/断连统一收敛） | APPROVAL_PENDING 过期 | `requestId` |

`SUBAGENT_DONE` 覆盖子代理 **COMPLETED / FAILED / CANCELLED** 三种终态（决策记录 #11），标题/摘要依 `status` 区分「已完成 / 执行失败 / 已取消」。`:711` 的 SUPPRESSED 早退分支（`:692-701`，父会话已终态）**故意不写**——结果已被抑制，不进收件箱是正确行为，不属漏挂。`SubagentExecution.deliveryStatus` 的第 4 个取值 `LEGACY` 同样不触发写入。

依赖注入方式对齐现有模式：`harness/deps.ts` 增加收件箱记录器接口（参照 `TaskTerminalService` 在 `harness/deps.ts:274` 的声明方式），实现类在 `src/inbox/`，`create-app.ts` 注入；`LocalToolExecutor` 无 userId 上下文，由 `InboxService` 内部补齐——**复用 `LocalToolSessionRegistry.getUserIdForSession`（`local-tool-session-registry.ts:52`，内存缓存 → session 表 → SUBAGENT 父会话三级回退）**，与 `tool-dispatcher.ts:266` 同一路径；不得新造 session 查询（`ApprovalRegistry.enterWaitingApproval`（`session.service.ts:787`）只用 sessionId 做条件 UPDATE，不查 userId，不能作为对照样板）。

`SUBAGENT_DONE` 的标题取子会话 `title`（经 `childSessionId` 查 session 表，`SubagentExecution` 行上无标题），查询失败降级用 `taskDescription`；`content` 取 `result` 首行。

### 5.3 REST 面（登录态，`Result<T>` code=0）

`src/inbox/inbox.routes.ts`，**沿用 `requireUserId(request)` + `sendOk(reply, data)`**（`common/http-error.ts:17/13`，全仓 132 / 185 处主流写法）；不得 import `common/http/request.ts`（死代码，零引用）或 `common/auth.ts:15` 的 jwt 版（14 处，仅剩例外与 spec 在用）。收件箱为个人数据，不挂权限点（无 admin 侧操作）；`/v1/**` 上的登录态由 `server.ts:51-53` 的全局认证守卫保证。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/inbox` | 分页列表，`page`（默认 1）/ `size`（默认 20，`queryInt` 惯例）/ `unreadOnly` |
| GET | `/api/v1/inbox/unread-count` | 徽标数据源，返回 `{ unreadCount }` |
| POST | `/api/v1/inbox/:id/read` | 单条已读（`is_read=1` + `read_at`） |
| POST | `/api/v1/inbox/read-all` | 全部已读（单条 UPDATE，`idx_notification_user_read` 覆盖） |
| DELETE | `/api/v1/inbox/:id` | 删除单条 |
| GET | `/api/v1/inbox/preferences` | 四个 kind 开关（P2 起含 `systemNotifyEnabled`） |
| PUT | `/api/v1/inbox/preferences` | 保存偏好（`user_inbox_preference` upsert，last-write-wins） |

**分页参数命名统一为 `page` + `size`**，与仓内主流 `session.routes.ts` 一致（原 `page`/`pageSize` 混搭 `schedule.routes.ts` 的 `pageNum`/`pageSize`，需选一种并贯彻）。`queryInt` 在 `common/request.ts:19`（非法值回退默认，不会抛错）。**禁止**给未识别 `kind` 值放行：白名单严格等于表注释里的五个字面量，其余一律 400。

### 5.4 前端（桌面 / Web / 安卓共用 UI）

1. 新增 `desktop/src/stores/inbox/index.ts`：`items / unreadCount / hasMore`；动作 `fetchList / fetchUnreadCount / markRead / markAllRead / remove / loadMore / setUnreadCount`；偏好读写（`fetchInboxPreference / saveInboxPreference`，与 task-notification 偏好接口完全分离）。
2. 新增 `desktop/src/components/inbox/InboxBell.vue`（铃铛 + 未读徽标，`el-badge` 支持 `:max="99"` 免手写 99+）与 `InboxDrawer.vue`（`el-drawer`：kind 图标、标题、摘要、相对时间、未读标识；点击条目 → `markRead` → session store 打开会话；底部"全部已读"）。**抽屉每次打开强制重新拉一次 `unreadCount` + 第一页列表**，作为 `inbox_updated` 极端丢失的兜底（即使它已是 CRITICAL_EVENT_TYPES）。
3. `TopNav.vue` `.nav-right`（`SessionSearchPopover` 之前，即 `TopNav.vue:20` 前）插入 `InboxBell`。
4. `useStreamWS.ts`：新增 `case 'inbox_updated'`（约 617 行 `session_status` case 附近）→ `inboxStore.setUnreadCount(data.unreadCount)`；`onopen` 重订阅处（`:223-225`，`fetchFocusSessions(true)` 补偿所在）追加 `inboxStore.fetchUnreadCount()`。**未读数重拉不得放进 `if (sessionStore.focusLoaded)` 分支**——聚焦列表没加载时徽标也要能更新。
5. `NotificationSettingsView.vue` 新增「站内收件箱」分区：四个 kind 开关（调用 preferences 接口）；「Electron 系统通知」开关仅 `isElectronClient()` 为真时显示（P2）。
   - **必须独立于现有整页保存**：`NotificationSettingsView.vue` 当前只有一个 `handleSave()`，且受 `canSave`（`:121`，依赖 `form.channel && hasUsableWebhook`）门禁——若并入同一次保存，webhook 未配置时保存按钮禁用，kind 开关将无法保存。kind 开关用分区级独立 `handleSaveInboxPreference()`，调 `PUT /inbox/preferences`。
   - 注意该路由已有登录守卫（`router/index.ts:68-72` + `beforeEach` 权限校验），分区渲染无需再考虑游客态。
6. **前端单测补齐**（原方案遗漏）：`desktop/src/stores/inbox/*.test.ts`（store 动作 + 未读数更新）、`useInboxSystemNotify` 单测（降级路径：`requestPermission` 返回 denied 时不弹不报）、`useStreamWS.test.ts` 扩充 `inbox_updated` case（沿用现有 FakeWebSocket 基座 + `onmessage` 注入模式，共 10 个样例 case 的同款写法）。
7. P2 Electron 系统通知：新增 `desktop/src/composables/useInboxSystemNotify.ts`。`inbox_updated` 事件只带 `unreadCount`，**通知的 title/body 由渲染端 diff 得出**：满足弹窗条件（总开关 && kind 开启 && `document.hidden || !document.hasFocus()`）时拉取收件箱第一页，与上次已知未读条目集合 diff 出新增条目，用新增条目的 title/content 逐条 `new Notification(...)`，`onclick` → `window.focus()` + 路由跳转关联会话；macOS 需先 `Notification.requestPermission()` 并确认 `granted` 再弹；`main.cjs`（`desktop/electron/main.cjs`）补 `app.setAppUserModelId('cn.etarch.mao.desktop')`（Windows 系统通知前提）。不采用"事件携带内容"方案，避免给非关键事件通道加重。

### 5.5 保留策略与装配

新增 `src/inbox/inbox.cleanup.ts`：`InboxCleanupScheduler`，**对齐 `WebhookDeliveryScheduler` 的 `start/stop + cleanupTimer` 结构**（`notification/task/delivery.scheduler.ts:140-141/203-210`），`setInterval` 每小时一次执行 `deleteInboxHistory(cutoff)`；保留天数 90 为常量（不做清单 #9）。

**不要对齐 `RuntimeCleanupScheduler`**（`harness/runtime/runtime-cleanup-scheduler.ts`）：它是**文件系统**扫描器（`setInterval` 扫 runtime 目录按 mtime 删文件），不碰 DB、无"每日一次"概念（是可配 `intervalMs`，启动即跑一轮）、更无 `LIMIT` 分批。原方案把它当 DB 清理样板是选错了参照物。

**同样不要照抄 `deleteHistory` 分批**：`notification/task/delivery.scheduler.ts:81-86` 的 DB 清理也是无分批的单条 `DELETE`，且**带 `status` 三元条件**（只清已终态投递行）。收件箱量级远小于 task_notification_delivery，按同一形状写成：
```sql
DELETE FROM notification WHERE created_at < ?
```
单条即可（原方案"DELETE ... LIMIT 1000 循环删除"是净新写法，全仓 `DELETE ... LIMIT` 零先例，属过度设计，按 KISS/不做清单 #9 精神去掉）。已读/未读**都要清**（90 天前的未读也是过期数据，不存在"未读必须永久保留"的需求）。

## 6 关键约束（防逻辑漂移红线）

1. **不改 webhook 链路**：`TaskNotificationDeliveryService.prepare / suppressPending / resolveWebSocket`、`WebhookDeliveryScheduler` 的任何行为不得因收件箱改变；收件箱写入不受"WS 在线抑制"影响（它就是在线 UI）。
2. **服务端权威**：未读数只来自服务端 COUNT；前端禁止本地累加/推导；所有已读/删除以 `user_id` 为边界。`inbox_updated` 已入 `CRITICAL_EVENT_TYPES`（`streaming-ws-registry.ts:54`），弱网下仍按"重连 + 开抽屉"双兜底，不得因此改回普通帧。
3. **写入点零侵入**：六个写入点均为既有事件位置的追加调用；`finishExecution` 仅新增带默认值的可选参数，既有调用点零改动（接口窄声明副本的同步见 4.2）。
4. **幂等是主防线**：同 `dedup_key` 二次 record 不得产生第二行；重试、取消后重发、排队消费、崩溃恢复四条路径不得产生幽灵通知。**口径纠正**：四条路径中真正要防的是同一 `executionId` 二次进入终态；因崩溃恢复/重试/排队消费本身生成的是**新 executionId**，产生新条目属预期行为。
5. **kind 枚举封闭**：`TASK_COMPLETED / TASK_FAILED / QUESTION_PENDING / APPROVAL_PENDING / SUBAGENT_DONE` 之外不新增 kind；CANCELLED、子会话 TASK_COMPLETED 明确不写。收到未知 kind 一律忽略并 warn，不得写入。
6. **未读数是收件箱专属概念**：`session.unread`（会话列表圆点，`session.service.ts:1021-1025` 写 DB）与 inbox 未读数（顶栏徽标，只由 `notification.is_read` 决定）是两套独立机制，任何一侧不得从另一侧推导、换算或合并；前端禁止把 `session_status.unread` 与 `inbox_updated.unreadCount` 互相覆盖。
7. **QUESTION_PENDING 只挂工具派发点**：唯一正确位置是 `tool-dispatcher.ts:320` 的 register 之后；禁止挂 `streaming-ws-handler.ts:320` 的 WS 快照/重订阅处（每次重连重发 pending，会产生重复条目）。
8. **Crossref 列不得复活**：不得以"方便查询"为由把 `related_type` / `related_id` / `type` 加回 4.1 已删集合；跳转只认 `session_id`，执行要素只认 `payload_json`。

## 7 验收标准（完成定义）

1. `cd backend-ts && npm test` 全绿；新增 spec：
   - `inbox.repository.spec.ts`：幂等（同 dedup_key 二次插入仅一行、并发唯一键兜底）、跨用户读写返回空/404、分页与 unreadOnly、联动置已读。**SQL 断言风格，照 `feedback/feedback.repository.spec.ts`**（`vi.fn()` mock `Db` 捕获 SQL/参数 + 内存 fake 模拟 `uk_notification_dedup` 唯一键与 `ON DUPLICATE KEY UPDATE id = id` 的"忽略"语义，见该 spec 的 `makeUniqueKeyDb` 段）。
   - `inbox.service.spec.ts`：偏好关闭不写入、每次写路径后广播 unreadCount、SUBAGENT/SIDE_TASK 抑制（**含 `sessionType='SIDE_TASK'` + `parentSessionId=null` 的提升边界**）、CANCELLED 不写、子会话标题降级、`inboxDedupKey` 写入键 === 置已读读取键。
   - `task-terminal` 相关 spec：COMPLETED/FAILED 各记一次且带正确 notifySource；**定时任务路径在生产路径（`finishCompletedSession` / `finishFailedSession`）传 SCHEDULED**（不测 `scheduled-task.service.ts:472`——生产不走该分支；且必须显式断言，TS 窄接口缺参会静默回落 MANUAL 而不报错）。
   - `tool-dispatcher` / `local-tool-executor` 相关 spec：QUESTION / APPROVAL 写入与三态（回答/取消/超时）自动置已读；**三态判定断言读 `result.answered` / `result.cancelled`，不得靠解析 `resultJson` 文本**。
   - `background-subagent-manager` / `subagent-result-delivery` 相关 spec：SUBAGENT_DONE 覆盖 COMPLETED / FAILED / CANCELLED，SUPPRESSED 分支不写。
2. `cd desktop && vue-tsc` 通过（无 ESLint/Prettier，类型即门禁）；`cd desktop && npm test` 通过（inbox store / useInboxSystemNotify 单测 + useStreamWS 的 `inbox_updated` case）。
3. `tests/desktop.spec.ts` 新增 `Desktop Inbox` describe（沿用 `page.route` mock 后端模式，仿 `mockLoggedInDesktopApi` 的 `**/api/v1/**` 全量 mock + `page.addInitScript` 种 token 写法）：铃铛徽标显示、抽屉条目渲染、点击已读并跳转、全部已读、偏好开关渲染。
4. 手工验收路径：桌面在线收任务完成 → 铃铛即时 +1；手机端已读 → 桌面徽标归零；关闭 SUBAGENT_DONE 偏好 → 子代理完成不产生记录；**定时任务完成后条目带「定时任务」徽标**（验证方案 A 的 `scheduledTaskIds` 映射在 `liveExecution` 主路径上生效）；Electron 失焦收通知 → 点击聚焦并跳转（**macOS 首次验证 `requestPermission` 授权路径，并验证 denied 时静默降级不报错**）；**在真实 Electron 窗口确认 HTML5 Notification 确实走系统通知**（本方案唯一无本地样例的判断）；删除关联会话后点击旧条目 → 降级提示不白屏；Web/安卓不弹系统通知。
5. 按 AGENTS.md 完成发版配套：CHANGELOG.md 顶部新版本小节、README.md 功能说明、`skills/mao-cli/SKILL.md` 同步、提案 `docs/proposals/2026-10-02-task-inbox.md` 状态行更新。

## 8 落地清单

### 8.1 backend-ts

- [ ] `db/migration/V131__inbox_notification.sql`（notification + user_inbox_preference）
- [ ] `session/task-terminal.service.ts`：`finishExecution` 第 6 参 `notifySource` + `:74` 处收件箱写入（SUBAGENT/SIDE_TASK/微信/飞书/CANCELLED 全部显式跳过）
- [ ] `src/inbox/inbox.repository.ts` + `inbox.repository.spec.ts`
- [ ] `src/inbox/inbox.service.ts` + `inbox.service.spec.ts`（含 `inboxDedupKey` 单一导出的键一致性断言）
- [ ] `src/inbox/inbox.routes.ts`（7 个端点，`requireUserId(request)` + `sendOk`，分页 `page`+`size`）
- [ ] `src/inbox/inbox.cleanup.ts`（90 天清理调度器，对齐 `WebhookDeliveryScheduler` 的 cleanupTimer 结构）
- [ ] `src/session/ws/streaming-ws-handler.ts`：窄接口 `:84` 扩参；`scheduledTaskIds` 映射 + `runExecution` `scheduled` flag 转发；三个 finisher 传 SCHEDULED
- [ ] `src/schedule/scheduled-task.service.ts`：窄接口 `:122` 扩参；`:472`（liveExecution == null 的遗留/测试路径）传 SCHEDULED
- [ ] `src/harness/tool/tool-dispatcher.ts`：`:320` QUESTION_PENDING 写入 + `:340` 之后联动置已读
- [ ] `src/harness/local/local-tool-executor.ts`：`:33` APPROVAL_PENDING 写入 + `:56` finally 联动置已读
- [ ] `src/harness/delegate/background-subagent-manager.ts`（`:342` / `:711` / `:843` 三处 DELIVERED 后挂）、`subagent-result-delivery.service.ts`（只挂 `deliverBackground()`，`:126`）：SUBAGENT_DONE 写入
- [ ] `src/create-app.ts`：装配与路由注册（含 `InboxCleanupScheduler.start()`）
- [ ] 其余 4 份窄接口（`harness/deps.ts:274`、`dingtalk/runtime.ts:83`、`weixin/agent-inbound-handler.ts:58`、`harness/delegate/subagent-visibility-service.ts:26`）确认结构兼容零改动；16 处调用点逐一确认取值

### 8.2 desktop（桌面 / Web / 安卓共用）

- [ ] `src/stores/inbox/index.ts`
- [ ] `src/components/inbox/InboxBell.vue`、`InboxDrawer.vue`（`el-badge :max="99"`，相对时间复用 `useRelativeTime`）
- [ ] `src/components/common/TopNav.vue`：`:20`（SessionSearchPopover）前插入铃铛
- [ ] `src/composables/useStreamWS.ts`：`inbox_updated` case（约 :617 附近）+ `onopen`（:223-225）未读数重拉（**不放进 `focusLoaded` 分支**）
- [ ] `src/views/settings/NotificationSettingsView.vue`：「站内收件箱」分区（kind 开关 P1；系统通知开关 P2），**独立保存动作，勿并入受 `canSave` 门禁的整页保存**
- [ ] 前端单测：`src/stores/inbox/*.test.ts`、`useInboxSystemNotify` 降级路径、`useStreamWS.test.ts` 扩充 `inbox_updated`
- [ ] （P2）`src/composables/useInboxSystemNotify.ts` + `electron/main.cjs` 补 `app.setAppUserModelId('cn.etarch.mao.desktop')`（Windows 系统通知前提；appId 见 `desktop/package.json:64`）

### 8.3 测试与文档

- [ ] `tests/desktop.spec.ts`：`Desktop Inbox` describe
- [ ] `CHANGELOG.md` 顶部新版本小节（`frontend 共用 UI` / `backend-ts 后端` 分节）
- [ ] `README.md`、`skills/mao-cli/SKILL.md`、`docs/proposals/2026-10-02-task-inbox.md` 状态同步

## 9 风险与应对

| 风险 | 应对 |
|---|---|
| 相位收敛重复进入（重试 / 取消后重发 / 排队消费 / 崩溃恢复）导致幽灵通知 | `dedup_key` 按 executionId 幂等为主防线；验收标准 1 的四条路径回归用例必须覆盖。**口径**：崩溃恢复/重试/排队消费会生成新 executionId，产生新条目属预期；真正要防的是同一 executionId 二次进入终态（靠 `finishExecution:45-51` 早退 + 唯一键双保险） |
| 窄接口 6 份副本漏扩参导致 notifySource 静默回落 MANUAL | TS 结构类型下缺省调用既不会报错也不会生效。必须靠 spec 断言"定时任务生产路径传 SCHEDULED"，不能依赖编译期 |
| SIDE_TASK 已提升为主会话（`parentSessionId=null`）时排除判定失效 | 一律读 `session.sessionType`（双条件口径同 `task-terminal.service.ts:89`），禁用 `parentSessionId != null` 近似；spec 补该边界用例 |
| 多端同时在线未读数漂移（桌面 + 手机 + IM） | 服务端 COUNT 为权威值；WS 只广播权威数；重连后拉取兜底；前端禁止本地推导。`inbox_updated` 已列 CRITICAL_EVENT_TYPES，另加开抽屉强制重拉双兜底 |
| 提问 / 审批 900 秒超时后条目误导 | 联动自动置已读（4.3）；条目保留，payload 摘要仍可读。三态/四态判定读 `result.answered` / `result.cancelled` 结构化标记，不解析文本 |
| WS 重订阅重发 pending ask_user 导致 QUESTION_PENDING 重复 | 写入点只挂 `tool-dispatcher.ts:320`（register 之后），禁止挂 `streaming-ws-handler.ts:320` 快照/重订阅处（红线 #7） |
| 子代理标题需二次查询（`childSessionId` → session 表） | 查询失败降级 `taskDescription`；dedup 以 `SubagentExecution.id` 不受影响 |
| 子代理 FAILED / CANCELLED 也被写成"完成" | SUBAGENT_DONE 覆盖三种终态，payload 带 `status`，标题/摘要依状态分流（决策记录 #11） |
| 同步 delegate 误挂收件箱导致双重通知 | 只挂 `deliverBackground()`（`subagent-result-delivery.service.ts:126`），不挂 `deliver()` 顶层（不做清单 #11） |
| read-all / 大量未读时 UPDATE 压力 | 单条 UPDATE 命中 `idx_notification_user_read`；清理任务为单条 DELETE 无分批，量级远小于 task_notification_delivery |
| 并行子代理完成刷屏 | SUBAGENT_DONE 默认关 + 子会话 TASK_COMPLETED 抑制（决策记录 #5、#8） |
| 与长期记忆方案并行改 `finishExecution` | 排期错峰（两方案均为追加式改动，参数带默认值、互不依赖） |
| 条目关联会话被删除后点击跳转 | session 为软删除、行保留；前端对"会话不存在/已删除"降级为提示并保留条目 |
| Electron HTML5 Notification 未走系统通知（无本地样例可依） | 实施期在真实 Electron 窗口验证一次（7.4）；若未走系统通知，P2 降级为主进程 `new Notification` + IPC，前端改动收敛在 `useInboxSystemNotify` 内部 |

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
| 9 | 偏好存储（技术拍板） | 新建 `user_inbox_preference` 表——preference 域无通用 KV，遵循"每类偏好独立表"惯例；表形对齐 `user_weixin_preference`（`user_id` 主键，无自增 id）。P2 的 `system_notify_enabled` 由 P2 迁移 ADD COLUMN，P1 不建死列 |
| 10 | WS 事件与来源透传（技术拍板） | `inbox_updated` **加入** `CRITICAL_EVENT_TYPES`（弱网静默丢帧无主动重拉入口，且事件量极小）；另以"开抽屉强制重拉 + 重连重拉"双兜底。`finishExecution` 新增默认值可选参数透传 SCHEDULED 来源，其余调用方零改动 |
| 11 | 子代理终态覆盖（技术拍板） | SUBAGENT_DONE 覆盖子代理 COMPLETED / FAILED / CANCELLED 三种终态，payload 带 `status` 供前端分流文案；`deliveryStatus=SUPPRESSED` 分支不写 |
| 12 | 定时任务来源透传实现路径（技术拍板，对应方案 A） | 在 `StreamingWsHandler` 侧维护 `scheduledTaskIds` 映射 + `runExecution` 加 `scheduled` flag 转发；只挂 `deliverBackground()`，不挂 `deliver()` 顶层 |
| 13 | 表结构精简（技术拍板） | 去掉 `related_type` / `related_id`（与 `session_id` 语义重叠，无读取方）；跳转只认 `session_id`，执行要素只认 `payload_json` |
