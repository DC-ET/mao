# 每日运营摘要（Daily Digest）技术方案

> 状态：已确认（待实施）
> 日期：2026-10-12
> 上游提案：[docs/proposals/2026-10-12-daily-digest.md](../proposals/2026-10-12-daily-digest.md)
> 覆盖端：后端 backend-ts、桌面端 desktop、共享契约 shared/contracts
> 迁移编号：V150（当前最新 V149）

---

## 0. 决策记录

以下 11 条决策于 2026-10-12 与需求方逐条追问确认（第 11 条需求方未回复，按项目既有模式取默认值，实施时如与预期不符可回改）：

| # | 决策 | 结论 |
|---|---|---|
| 1 | 投递渠道 | **收件箱（新 kind `DAILY_DIGEST`）+ 出站订阅（新事件 `digest.daily`）**。IM（飞书 / 钉钉 / 微信）推送**不做**，写入非目标 |
| 2 | 内容板块 | 六板块全做：任务成败 / 定时任务执行 / 信号哨兵触发 / 审批待办挂起 / 成本 Top3 / 开放接口调用。**当天无数据的板块整块不渲染**；失败任务列 Top 3 |
| 3 | 时间窗口 | **昨天自然日** `[昨日 00:00:00, 今日 00:00:00)`，Asia/Shanghai，半开区间（对齐用量统计口径，沿用 0.0.276 修正后的区间写法） |
| 4 | 推送时间 | 每用户可配，**默认 09:30**，落在 `user_digest_preference.push_time` |
| 5 | 接收人范围 | **仅昨天有数据的用户**（六板块任一非空即发，审批挂起算"有数据"）；完全安静的用户静默。设置页摘要卡片展示「上一份摘要：已发送 / 无事件未发送」状态，兼顾"可区分没跑" |
| 6 | 桌面呈现 | 收件箱**浓缩条目**（标题 + 一行统计）+ 点击弹出**摘要详情对话框**完整渲染六板块；出站订阅方在 payload 里收到同一份完整内容 |
| 7 | 失败原因 | **原文截断**（各截约 80 字），零模型成本、零幻觉。LLM 起草**不做** |
| 8 | 推送频率 | **仅日报**。周报 / 月报**不做** |
| 9 | 偏好存储 | **新建 `user_digest_preference` 表（V150）**，对齐项目"一功能一表"模式（`user_inbox_preference` / `user_task_notification_preference` 先例） |
| 10 | 手动试发 | 设置页提供「立即发送昨日摘要」按钮，走与调度器同一条生成与投递链路，**不写 `last_digest_date`**（试发不占当日正式发送） |
| 11 | 默认开关 | 新用户与升级后的存量用户**默认开**（决策 1 的延伸：安静日静默 + 一天最多一封，不构成打扰；对齐收件箱多数 kind 默认开的模式） |

---

## 1. 需求背景

项目自动化设施已铺全（定时任务含重试与停机补偿、信号哨兵、入站 Webhook、开放 API、出站事件订阅），但事件是**点状**的：昨天的 3 条任务完成、1 条审批待办、1 条哨兵停用散落在收件箱里，要弄清"昨天 overall 怎么样"只能逐条点开。实际结果是人根本不看，直到某天发现哨兵停了一周。出站订阅又只有事件粒度，想接自己 BI / 群机器人的团队得在接收端自己聚合——而接收端聚合最容易烂尾。

本方案落地「每日运营摘要」：后端每天在用户选定时间（默认 09:30）汇总**昨天自然日**的运营事实，经站内收件箱（新 kind）与出站订阅（新事件）各投一封；摘要数据全部来自既有六张表的一次聚合查询，不新建事实表；安静日（六板块全空）静默不发，但设置页可见状态。

### 1.1 现状代码事实（实施前已核对）

| 事项 | 现状 | 本方案的用法 |
|---|---|---|
| 收件箱条目表 | `notification`（V131）：`user_id / kind / title / content / is_read / session_id / payload_json(JSON) / dedup_key(唯一) / created_at`；`InboxItem`（`shared/contracts/src/inbox.ts:26-34`）已含 `payload` 字段，列表接口原样返回 | 摘要条目落 `notification`；`payload_json = { coveredDate, digest }` 携带完整结构化摘要，**详情对话框直接从列表项 payload 渲染，零新查询端点** |
| 收件箱写入范式 | `inbox.service.ts` 的 `recordXxx(input)` 系列（`recordWatcherDisabled:166` 等）：拼 title/content/payload → 私有 `record()` 统一落库 + 广播未读数 | 新增 `recordDailyDigest(input)` 同款；试发需覆盖同日条目，仓储层加 `insertOrUpdateByDedupKey`（现有 `markReadByDedupKey` 已证明 dedup_key 等值匹配可行） |
| 出站订阅 | `openapi/types.ts:62` `OUTBOUND_EVENTS = ['task.completed','task.failed','question.pending']`；`OutboundSubscriptionService.dispatchTaskTerminal(input)`（`outbound-subscription.service.ts:126`）按订阅插 `task_notification_delivery` 行，`OutboundDeliveryScheduler` 负责 HMAC 签名发送 + 指数退避重试 | 事件集合加 `'digest.daily'`；新增 `dispatchDigest(input)` 照抄 `dispatchTaskTerminal` 结构；签名 / 重试 / 退避原样复用，不特殊调参 |
| 调度器范式 | `InboxCleanupScheduler`（`inbox/inbox.cleanup.ts`，54 行）：`setInterval` + `start/stop` + `stopped` 标志 + try/catch 记日志；`OutboundDeliveryScheduler` 另带 `dispatching` 防重入与 CAS claim | `DigestScheduler` 照 `InboxCleanupScheduler` 结构（每分钟 tick，单线程循环内逐用户串行处理，天然单飞无需 CAS） |
| 时区口径 | `common/json.ts`：`formatDateTime` / `shanghaiYmd` 均 Asia/Shanghai（`json.spec.ts` 有专项用例）；用量窗口 `llm-call.service.ts:128` 半开区间 `[startAt, endAtExclusive)` | 窗口计算复用 `shanghaiYmd` 推算昨日日期；HH:MM 比较新增 `shanghaiHm` 小工具（或从 `formatDateTime` 截取，见 §5.4） |
| 偏好表范式 | 一功能一表：`user_inbox_preference`（V131，按 kind 开关）、`user_task_notification_preference`（V054，渠道 + Webhook 密文）、`user_weixin_preference`（V064）；懒建行（读时无行回落默认值） | 新建 `user_digest_preference`（V150），同款懒建行 + 读时回落默认 |
| 成本口径 | `llm_call.cost_micros`（V138 快照列，×10⁶ 整数，价格未配为 NULL）；`cost-micros.ts` 计价四价相加 | 摘要成本 = 窗口内 `SUM(cost_micros)`；NULL 行单独计数并在板块内附注"另有 N 次调用未配价未计入" |
| 审批待办数据源 | `ApprovalRegistry`（`harness/approval/approval-registry.ts`）挂起态是**进程内 Map，不可跨进程查询**；DB 侧权威在 `notification` 表：`recordApprovalPending` 写行、批准/拒绝/超时/断连统一 `resolvePending` → `markReadByDedupKey` 置已读 | 摘要"审批挂起数" = `notification` 中 `kind='APPROVAL_PENDING' AND is_read=0 AND user_id=?` 的计数（**不限昨天窗口**——挂起是状态量不是事件量；90 天清理会带走超龄未读行，属可接受损耗） |
| 定时任务归属 | `scheduled_task.user_id`（V061:4）；`scheduled_task_run`（V143）`task_id + fire_time` 唯一、`status` ∈ RUNNING/QUEUED/COMPLETED/FAILED/CANCELLED/MISSED、`error_summary` 列 | 板块数据 = `scheduled_task_run r JOIN scheduled_task t` 按 `t.user_id` + `r.created_at` 窗口聚合；自动暂停事件取 `notification` 的 `SCHEDULED_TASK_PAUSED` 行 |
| 哨兵数据源 | `signal_watcher_check`（V148）`watcher_id / checked_at / changed`；停用通知走 `notification` 的 `WATCHER_DISABLED` | 触发数 = `check JOIN watcher` 按属主 + 窗口 + `changed=1` 计数；停用告警取 notification 行 |
| 开放接口流水 | `open_api_call_log`（V145）`user_id`（Token/触发器属主，查无归属为 NULL）、`outcome` ∈ pending/queued/rejected/completed/failed/cancelled、`idx_oacl_user_created` 索引 | 板块 = 按属主 + 窗口计数总数与 `rejected`；user_id 为 NULL 的调用不计入任何人（不可归因） |
| 任务成败数据源 | `notification` 的 `TASK_COMPLETED` / `TASK_FAILED` 行（`content` 即失败原因，写入时已 clip）；**注意：用户在「消息通知」里关掉这两个 kind 后不再产生行** | 任务板块以 `notification` 为源（§1.2 记录此取舍）；失败 Top3 取 title + content 截 80 字 + session_id 跳转 |
| 设置页结构 | 桌面「设置 → 消息通知」= `desktop/src/views/settings/NotificationSettingsView.vue`；信号哨兵 / 开放接口均为 `settings/` 下独立页 + 设置页卡片入口 | 摘要偏好卡片并入 `NotificationSettingsView.vue`（不新建设置页）；详情对话框为新组件 |
| 跳转目标现状 | 会话跳转：收件箱抽屉现有逻辑按 `session_id` 打开会话；「我的用量」：顶栏抽屉；信号哨兵：`settings/SignalWatchersView.vue`；定时任务：`components/ScheduledTaskPanel.vue` | 详情对话框行内跳转：失败任务 / 审批 → 打开会话；成本板块 → 我的用量；哨兵板块 → 设置页哨兵列表；定时任务板块 → 打开定时任务面板 |

### 1.2 对上游提案的修正（本方案对提案的实质变更）

1. **"零事实迁移"修正为"一张偏好表迁移（V150）"**：提案称偏好可落 `preference` 域"既有 JSON 偏好存储"——核对后项目并无通用 JSON 偏好设施，全部是一功能一表。故 V150 新建 `user_digest_preference`；事实表确实零新增。
2. **P1/P2/P3 分期合并为 v1 一次交付**：决策 1 将原 P1（收件箱）与原 P2（出站）合并进 v1，原 P3（IM 投递 + 管理后台送达率统计）**明确不做**，从范围中删除。
3. **"摘要渲染为 Markdown 文本"限定使用范围**：收件箱抽屉只渲染单行纯文本（`InboxDrawer.vue:164` 的 `<p class="inbox-content">`），markdown 仅用于出站 payload 的 `text` 字段与详情对话框的等宽展示；桌面详情用结构化渲染，不走 markdown 管线。
4. **"安静日不生成"精确为"安静日静默但标记已处理"**：`last_digest_date` 记录**被汇总的日期**（昨天）而非发送日期；安静日照写该标记（避免每分钟重复聚合），设置页据此区分「已发送 / 无事件未发送 / 未到推送时间」三态。
5. **任务板块口径限制**：以 `notification` 为源意味着关闭了收件箱偏好的用户摘要里任务数会少算——这是刻意取舍（摘要是通知体系的汇总视图，与通知开关语义自洽），在文档显式记录，不做双数据源。

---

## 2. 需求描述

### 2.1 要做的

**后端（backend-ts，新增 `digest` 域）**

1. **V150 迁移**：`user_digest_preference` 表（§4）。
2. **聚合服务 `digest.service.ts`**：输入 userId + 昨天窗口，六板块并行聚合（§5.2），输出 `DigestData` 结构；空板块置 `null`。
3. **渲染**：`renderDigestLine(data)` 生成收件箱 content 浓缩一行；`renderDigestMarkdown(data)` 生成出站 `text` 字段全文；`digestTitle(coveredDate)` 生成条目标题。
4. **调度器 `digest.scheduler.ts`**：每分钟 tick，逐用户判定（开关 / 推送时间 / 防重），命中则生成→投递→标记；单用户异常不影响其他用户，不写标记下分钟自动重试。
5. **投递**：`inbox.service.ts` 新增 `recordDailyDigest`（kind=`DAILY_DIGEST`，payload 带完整 digest，支持同日覆盖）；`OutboundSubscriptionService` 新增 `dispatchDigest`（事件 `digest.daily`）。
6. **用户级 API `digest.routes.ts`**：`GET /v1/digest/preferences`（含上一份摘要状态）、`PATCH /v1/digest/preferences`、`POST /v1/digest/send-now`（试发，不写防重标记）。
7. **契约与白名单**：`shared/contracts/src/inbox.ts` 的 `InboxKind` 加 `'DAILY_DIGEST'`；`backend-ts/src/inbox/types.ts` 的 `INBOX_KINDS` 同步；`openapi/types.ts` 的 `OUTBOUND_EVENTS` 加 `'digest.daily'`。

**桌面端（desktop）**

8. **设置卡片**：`NotificationSettingsView.vue` 新增「每日运营摘要」卡片：总开关（默认开）、推送时间选择（默认 09:30）、出站订阅推送勾选（无订阅时禁用并提示）、上一份摘要状态行、「立即发送昨日摘要」按钮（成功 toast 展示浓缩统计）。
9. **详情对话框**：新组件 `components/inbox/DigestDetailDialog.vue`，从收件箱条目的 `payload.digest` 渲染六板块；行内跳转（失败任务 / 审批 → 会话；成本 → 我的用量；哨兵 → 设置页哨兵；定时任务 → 定时任务面板）。
10. **收件箱适配**：`InboxDrawer.vue` kind→图标映射加 `DAILY_DIGEST`；点击分支——该 kind 打开详情对话框（现有 kind 按 `session_id` 跳转的逻辑不变），并照常标记已读。

### 2.2 不做的

1. **IM 渠道投递**（飞书 / 钉钉 / 微信）——不做，v1 只有收件箱与出站订阅两路。
2. **周报 / 月报**——不做，仅日报。
3. **LLM 起草失败原因 / 摘要文案**——不做，原文截断。
4. **管理后台全站日报 / 送达率统计**——不做（提案原 P3 内容）。
5. **自定义看板 / 板块勾选**——不做，板块固定六个。
6. **邮件渠道**——不做（项目无 SMTP 设施）。
7. **补领历史摘要**——不做：老用户首次开启只从"昨天"起算，不追发。
8. **`system_notify` 系统通知联动**——不做：摘要不走 Electron 系统通知（非即时事件，进收件箱列表即可）。

---

## 3. 技术选型

| 维度 | 选型 | 理由 |
|---|---|---|
| 域划分 | 新建 `backend-ts/src/digest/`（types / repository / service / scheduler / routes / spec） | 与 `signal/`、`openapi/` 等同级域一致；聚合逻辑独立可测 |
| 调度 | 进程内 `setInterval` 60s（`InboxCleanupScheduler` 范式） | 单后端部署既有前提（哨兵 / 出站投递同款）；无跨实例共享状态需求 |
| 防重 | DB 列 `user_digest_preference.last_digest_date`（被汇总日期） | 重启后状态不丢；试发不写该列，与正式发送解耦 |
| 偏好存储 | 新表 `user_digest_preference`，懒建行 | 项目一功能一表惯例；读时无行回落默认值 |
| 摘要传输 | `notification.payload_json` 携带完整 `DigestData` | `InboxItem.payload` 已在列表接口返回，详情对话框零新端点 |
| 出站投递 | 复用 `task_notification_delivery` 管道 + 新事件 `digest.daily` | HMAC 签名 / 退避重试 / 清理全部现成 |
| 时区 | `common/json.ts` 的 Shanghai 口径 + 窗口半开区间 | 与用量统计、调度模块同一口径，避免 0.0.276 类边界 bug |
| 前端状态 | 设置卡片 + Pinia 不引入新 store（组件内请求 + 本地态） | 摘要偏好是一次性配置，无需全局态 |

---

## 4. 数据模型

### V150__user_digest_preference.sql

```sql
CREATE TABLE IF NOT EXISTS `user_digest_preference` (
    `user_id`          BIGINT       NOT NULL COMMENT '用户ID',
    `enabled`          TINYINT      NOT NULL DEFAULT 1 COMMENT '每日摘要总开关：0=关，1=开（默认开）',
    `push_time`        VARCHAR(5)   NOT NULL DEFAULT '09:30' COMMENT '每日推送时间 HH:MM（Asia/Shanghai 口径比较）',
    `outbound_enabled` TINYINT      NOT NULL DEFAULT 1 COMMENT '是否经出站订阅推送（仅有订阅时生效）',
    `last_digest_date` DATE         NULL COMMENT '最近一次已处理的被汇总日期（昨天）；NULL=从未处理',
    `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户每日运营摘要偏好';
```

- 不建任何事实表；六板块数据全部来自 `notification` / `scheduled_task_run` / `signal_watcher_check` / `llm_call` / `open_api_call_log` 既有表。
- `push_time` 用 `VARCHAR(5)` 存 `HH:MM`，服务端钳制 `00:00`~`23:59`；不做秒级。

---

## 5. 实现设计

### 5.1 类型 `digest/types.ts`

```ts
export interface DigestFailedTask { sessionId: number | null; title: string; reason: string }
export interface DigestPausedTask { taskId: number | null; name: string }
export interface DigestDisabledWatcher { watcherId: number | null; name: string }
export interface DigestApprovalItem { sessionId: number | null; title: string }

export interface DigestData {
  coveredDate: string;              // YYYY-MM-DD（Asia/Shanghai 昨天）
  tasks: { completed: number; failed: number; failedTop: DigestFailedTask[] } | null;
  scheduled: { total: number; completed: number; failed: number; paused: DigestPausedTask[] } | null;
  watchers: { triggered: number; disabled: DigestDisabledWatcher[] } | null;
  approvals: { pending: number; items: DigestApprovalItem[] } | null;   // pending 不限窗口
  cost: { totalMicros: number; unpricedCalls: number; top: { agentId: number | null; name: string; micros: number }[] } | null;
  openApi: { total: number; rejected: number } | null;
}

export type YesterdayDigestStatus = 'PENDING' | 'SENT' | 'QUIET';
```

板块为空判定（置 `null` 的条件）：`tasks` completed+failed=0；`scheduled` total=0 且 paused 空；`watchers` triggered=0 且 disabled 空；`approvals` pending=0；`cost` 窗口内调用数 0；`openApi` total=0。**六个全 null → 安静日**。

### 5.2 聚合 `digest/repository.ts`（六条查询，全部走既有索引）

窗口入参 `[start, end)` 为 `formatDateTime` 输出的 `yyyy-MM-dd HH:mm:ss`（由 `shanghaiYmd` 推算昨日日期后拼装）。

| 板块 | 查询要点 |
|---|---|
| tasks | `SELECT kind, COUNT(*) FROM notification WHERE user_id=? AND kind IN ('TASK_COMPLETED','TASK_FAILED') AND created_at>=? AND created_at<? GROUP BY kind`；failedTop = 同条件 `kind='TASK_FAILED' ORDER BY id DESC LIMIT 3`（title、content 截 80 字、session_id） |
| scheduled | `SELECT r.status, COUNT(*) FROM scheduled_task_run r JOIN scheduled_task t ON r.task_id=t.id WHERE t.user_id=? AND r.created_at>=? AND r.created_at<? GROUP BY r.status`；paused = notification `kind='SCHEDULED_TASK_PAUSED'` 窗口内行（payload.taskId、title） |
| watchers | `SELECT COUNT(*) FROM signal_watcher_check ch JOIN signal_watcher w ON ch.watcher_id=w.id WHERE w.user_id=? AND ch.changed=1 AND ch.checked_at>=? AND ch.checked_at<?`；disabled = notification `kind='WATCHER_DISABLED'` 窗口内行 |
| approvals | `SELECT COUNT(*) FROM notification WHERE user_id=? AND kind='APPROVAL_PENDING' AND is_read=0`（**无窗口条件**）；items = 同类取前 5 行（title、session_id）供详情展示 |
| cost | `SELECT agent_id, SUM(cost_micros) micros, COUNT(*) calls, SUM(cost_micros IS NULL) unpriced FROM llm_call WHERE user_id=? AND created_at>=? AND created_at<? GROUP BY agent_id ORDER BY micros DESC`；totalMicros = 各行 micros 之和（NULL 行不计）；top 取前 3；agent 名批量 `SELECT id, name FROM agent WHERE id IN (...)` 回填 |
| openApi | `SELECT outcome, COUNT(*) FROM open_api_call_log WHERE user_id=? AND created_at>=? AND created_at<? GROUP BY outcome`；total = 各组之和，rejected = `outcome='rejected'` 组 |

偏好读写：`findPreference(userId)` / `upsertPreference(row)` / `markProcessed(userId, coveredDate)` / `findNotificationByDedupKey(dedupKey)`（上一份状态判定用，通知仓储加一个按 dedup_key 的存在性查询）。

### 5.3 服务 `digest/service.ts`

- `aggregate(userId, coveredDate): Promise<DigestData>`——六条查询串行执行（单用户量级，无并行必要），组装并置空板块。
- `buildInboxItem(data)`：title = `昨日运营摘要（MM-DD）`；content = `renderDigestLine`（仅有数据的板块，如 `完成 5 · 失败 1 · 定时 3 次 · 哨兵触发 2 · 审批挂起 1 · 成本 ¥3.42 · 开放接口 12 次`）；payload = `{ coveredDate, digest: data }`。成本展示复用 `cost-micros.ts` 的格式化口径（与用量页一致，保留两位小数）。
- `buildOutboundPayload(data)`：`{ event: 'digest.daily', coveredDate, digest: data, text: renderDigestMarkdown(data) }`。
- `processUser(userId, opts: { force?: boolean })`：聚合 → 安静日则只 `markProcessed` 返回 → 否则 `recordDailyDigest` + （`outboundEnabled` 时）`dispatchDigest` → `markProcessed`。`force=true`（试发）时跳过推送时间判定、跳过 `markProcessed`，安静日照常返回"无事件"提示。
- `getPreferencesView(userId)`：偏好 + `yesterdayStatus`——`last_digest_date !== 昨天` → `PENDING`；等于昨天且存在 `DAILY_DIGEST` 通知行 → `SENT`；否则 `QUIET`。

### 5.4 调度器 `digest/scheduler.ts`

```
每分钟 tick（结构对齐 InboxCleanupScheduler：start/stop + stopped 标志 + try/catch）：
  now = new Date(); todayYmd = shanghaiYmd(now); yesterdayYmd = 前一天
  for row of repo.listEnabledUsers():        // user_digest_preference WHERE enabled=1
      if row.lastDigestDate === yesterdayYmd: continue          // 昨天已处理
      if shanghaiHm(now) < row.pushTime: continue               // 未到推送时间
      try { await service.processUser(row.userId) }             // 内部安静日也写标记
      catch (e) { console.error('每日摘要生成异常', userId, e) } // 不写标记，下分钟重试
```

- `shanghaiHm(now)`：从 `formatDateTime(now)` 截取 `HH:mm` 与 `push_time` 字符串比较（零依赖，不引 TZ 数据库）。
- 逐用户串行 + 单 tick 内无并发，天然单飞；用户量级（百人 × 六条索引查询）单 tick 毫秒级，无批量切分需要。
- **停机跨天**：昨天未处理（`last_digest_date` 停在更早）且已过推送时间 → 重启后首个 tick 补发昨天的摘要（窗口仍是昨天，数据正确）；再往前的日期永久跳过（每天只处理"昨天"一个目标日）。
- `start()` 在 `create-app.ts` 装配处调用（对齐哨兵 / 出站调度器的启动位置）。

### 5.5 收件箱写入 `inbox.service.ts`

- 新增 `recordDailyDigest(input: { userId, coveredDate, digest })`：拼 title/content/payload，`dedup_key = {userId}:DAILY_DIGEST:{coveredDate}`。
- 通知仓储新增 `insertOrUpdateByDedupKey(row)`：`INSERT ... ON DUPLICATE KEY UPDATE title/content/payload_json/is_read=0/read_at=NULL/updated_at=NOW()`——试发覆盖同日条目而不产生重复行（既有 `record*` 全是纯插入，摘要因试发语义需要覆盖能力）。
- 走既有 `broadcastUnreadCount` 未读广播；摘要条目计入未读数（与其它 kind 一致）。

### 5.6 出站订阅 `openapi`

- `types.ts`：`OUTBOUND_EVENTS` 增加 `'digest.daily'`（订阅创建时的白名单与事件选项自动跟随）。
- `outbound-subscription.service.ts`：新增 `dispatchDigest(input: { userId, coveredDate, digest, text })`，结构照抄 `dispatchTaskTerminal`（查订阅 → 逐条插 `task_notification_delivery`，`event='digest.daily'`，payload 为 §5.3 的出站 payload；失败仅 warn 不阻断）。
- `OutboundDeliveryScheduler` / HMAC / 退避 / 清理零改动。

### 5.7 用户级 API `digest/routes.ts`

| 端点 | 说明 |
|---|---|
| `GET /v1/digest/preferences` | 返回 `{ enabled, pushTime, outboundEnabled, yesterdayStatus, yesterdayCoveredDate }`；无偏好行回落默认（enabled=true, pushTime='09:30', outboundEnabled=true, status='PENDING'） |
| `PATCH /v1/digest/preferences` | body `{ enabled?, pushTime?, outboundEnabled? }`；`pushTime` 校验 `HH:MM` 且 `00:00≤t≤23:59`，非法抛 `PARAM_INVALID`；懒建行后增量更新 |
| `POST /v1/digest/send-now` | 试发：`processUser(userId, { force: true })`，返回 `{ sent: boolean, reason?: 'QUIET', line?: string }`；不写 `last_digest_date` |

登录态鉴权（本人数据），无新权限码；不走 `@RequirePermission`（对齐 `signal-watchers` 用户级路由）。

### 5.8 桌面端 `desktop`

- **`views/settings/NotificationSettingsView.vue`**：新增「每日运营摘要」卡片（置于现有通知偏好卡片之后）：
  - 总开关 `el-switch`（默认开，值来自 GET）；
  - 推送时间 `el-time-picker`（或 `input type=time`，格式 `HH:MM`，默认 09:30），变更即 PATCH；
  - 「同时推送到出站订阅」`el-checkbox`：无出站订阅时禁用 +  hint「请先在 设置→开放接口 配置出站事件订阅」（订阅列表复用 OpenApiView 同款数据源）；
  - 状态行：`上一份摘要（MM-DD）：已发送 / 无事件未发送 / 待生成（今日 HH:MM 推送）`；
  - 「立即发送昨日摘要」按钮：调 send-now，成功 toast 展示浓缩统计行，失败 toast 原因。
- **`components/inbox/DigestDetailDialog.vue`**（新）：props = 收件箱条目；从 `item.payload.digest` 渲染六板块（空板块不渲染）；成本按 ¥ 格式化；行内跳转按钮：失败任务 / 审批项 → 打开对应会话（复用抽屉现有跳转能力）；成本板块 → 打开我的用量；哨兵板块 → 路由到设置页哨兵列表；定时任务板块 → 打开定时任务面板。
- **`components/inbox/InboxDrawer.vue`**：kind→图标映射加 `DAILY_DIGEST`（铃铛/文档类图标，与 `WATCHER_DISABLED` 并列）；点击分支：`kind==='DAILY_DIGEST'` 打开详情对话框，其余 kind 维持 `session_id` 跳转；两种分支都先标记已读。
- 契约：`shared/contracts/src/inbox.ts` `InboxKind` 加 `'DAILY_DIGEST'`；抽屉图标映射与类型同步。

### 5.9 装配 `create-app.ts`

- 实例化 `DigestRepository`（Db）、`DigestService`（repo + InboxService + OutboundSubscriptionService）、`DigestScheduler`（service），注册 `/v1/digest/*` 路由，`scheduler.start()`——位置对齐 `SignalWatcherScheduler` / `OutboundDeliveryScheduler` 的装配段。

---

## 6. 实现步骤

| 步骤 | 内容 | 依赖 |
|---|---|---|
| 1 | V150 迁移；`InboxKind` / `INBOX_KINDS` / `OUTBOUND_EVENTS` 三处契约同改 | — |
| 2 | `digest/types.ts` + `digest/repository.ts`（六聚合 + 偏好 CRUD + 通知存在性查询）+ 仓储单测 | 1 |
| 3 | `digest/service.ts`（聚合装配 / 渲染 / processUser / 偏好视图）+ 单测（含安静日、空板块、聚合数值） | 2 |
| 4 | `inbox.service.ts` 的 `recordDailyDigest` + `insertOrUpdateByDedupKey`（含同日覆盖用例） | 1 |
| 5 | `OutboundSubscriptionService.dispatchDigest` + 事件白名单 | 1 |
| 6 | `digest/scheduler.ts`（tick 判定 / 防重 / 异常隔离 / 停机补发）+ 单测（可注入 now 与用户列表） | 3 |
| 7 | `digest/routes.ts` + 装配 `create-app.ts` | 4,5,6 |
| 8 | 桌面：设置卡片 + 详情对话框 + 抽屉图标与点击分支 | 7 |
| 9 | CHANGELOG（后端 + 前端两节）、README 能力表补一行、USER_GUIDE / mao-cli 通知偏好文档同步 | 8 |

---

## 7. 落地清单

### 后端 backend-ts

- `db/migration/V150__user_digest_preference.sql`（新）
- `src/digest/types.ts`、`repository.ts`(+`.spec.ts`)、`service.ts`(+`.spec.ts`)、`scheduler.ts`(+`.spec.ts`)、`routes.ts`(+`.spec.ts`)（新域）
- `src/inbox/types.ts`（`INBOX_KINDS` 加 `DAILY_DIGEST`）
- `src/inbox/inbox.service.ts`（`recordDailyDigest`）、`src/inbox/inbox.repository.ts`（`insertOrUpdateByDedupKey`、按 dedup_key 存在性查询）
- `src/openapi/types.ts`（`OUTBOUND_EVENTS` 加 `digest.daily`）、`src/openapi/outbound-subscription.service.ts`（`dispatchDigest`）
- `src/create-app.ts`（装配与 start）
- `src/common/json.ts` 或 digest 域内 `shanghaiHm` 比较（二选一，倾向 digest 域内私有 helper，不动公共文件）

### 共享契约 shared/contracts

- `src/inbox.ts`（`InboxKind` 加 `'DAILY_DIGEST'`）

### 桌面端 desktop

- `src/views/settings/NotificationSettingsView.vue`（摘要偏好卡片）
- `src/components/inbox/DigestDetailDialog.vue`（新）
- `src/components/inbox/InboxDrawer.vue`（图标映射 + 点击分支）

### 文档

- `CHANGELOG.md`（后端 + 前端两节；偏好表不算内部重构，用户可见）
- `README.md` 核心能力表补一行；`USER_GUIDE.md` 收件箱 / 通知偏好章节；`skills/mao-cli/` 对应 reference 同步

---

## 8. 测试要点

- **聚合**：六板块各自窗口边界（昨日 23:59:59.500 计入、今日 00:00:00.000 不计入）；失败 Top3 排序与 80 字截断；审批挂起不限窗口（3 天前挂起仍计数）；成本 NULL 行计数与合计剔除；开放接口 rejected 单列；agent 名回填与 NULL agent。
- **空板块与安静日**：单板块空置 null、全空 → 安静日只写标记不发消息；安静日后设置页状态为 `QUIET`。
- **调度**：未到推送时间不处理；已处理日期不重复；分钟 tick 逐用户异常隔离（一个用户抛错不影响后续用户且下分钟重试）；推送时间修改后次日生效、当天不补发；停机跨天补发昨天的窗口数据正确。
- **防重与试发**：`last_digest_date` 语义（被汇总日期）；试发不写标记、可重复试发、同日覆盖通知行不产生重复、`is_read` 重置。
- **投递**：收件箱 kind 白名单接受 `DAILY_DIGEST`、未知 kind 仍拒绝；未读广播与已读标记正常；出站 payload 签名可验、HMAC 头正确、无订阅时 `dispatchDigest` 静默跳过；端点失败走既有退避不加重试参数。
- **偏好 API**：默认值回落；`push_time` 非法值拒绝（`25:00` / `9:5` / 空）；PATCH 增量语义（只传一个字段不动其余）。
- **前端**：设置卡片开关 / 时间 / 出站勾选（无订阅禁用态）交互与状态行三态；详情对话框六板块渲染、空板块缺席、行内跳转四类目标；抽屉点击分支（摘要开对话框、其他 kind 原行为）与已读标记。
- **回归**：既有 kind 的收件箱行为零变化；用量统计口径零变化；出站订阅既有事件投递零变化；定时任务 / 哨兵 / 开放接口现有单测全绿。
