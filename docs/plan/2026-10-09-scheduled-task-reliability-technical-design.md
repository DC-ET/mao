# 定时任务可靠性（重试 / 错过补偿 / 运行历史 / 失败升级）技术方案

- 日期：2026-10-09
- 状态：**已确认**（2026-10-09 与需求方逐条确认 §3 全部 11 条决策，均可按原建议口径落地），可转入实施。
- 来源提案：`docs/proposals/2026-10-09-scheduled-task-reliability.md`
- 实施范围：P1（运行历史）+ P2（失败重试）+ P3（错过补偿 + 失败升级），一次成文、分批落地

## 1 需求背景

定时任务（`schedule/scheduled-task.service.ts`）当前语义是"到点提交一次，成败听天由命"，四个缺口均经代码核实：

1. **无重试**：一次触发一次执行。终态只写 `last_execution_status`（`markTaskResult`，service.ts:647-652），失败即跳下一档。按天任务失败一次空一天、按周空一周。LLM 适配器内部重试只覆盖单次 API 调用，"整轮跑挂"无人兜底。
2. **无错过补偿**：停机期间蒸发的触发点没有任何记录与补救。重启后 `next_fire_time <= now` 仍会被 60s 扫描捞到补跑一次（`calculateNextFireTime` 用 croner `nextRun()` 从当前时刻算，不会连环补跑），所以现状实际是"复工补一次、中间错点无痕"；`skip`（只记录不补）才是本方案真正引入的行为变更。
3. **无运行历史**：`scheduled_task` 只有 `last_fire_time / last_execution_status / fire_count` 三个"最后一次"字段，成败分布、耗时、成本只能翻会话列表猜。
4. **失败无升级**：与 `webhook_trigger` 的"连续失败自动停用 + 通知"（`openapi/webhook-trigger.service.ts`）成熟先例相比，定时任务失败后任务继续每周期空跑，用户不在电脑前时无从知晓。

调研同时纠正了提案的三处事实假设（直接影响设计）：

- **桌面端没有任务编辑弹窗**：任务的创建/修改一直靠对话里 Agent 调工具（`harness/tool/impl/scheduled-task-tools.ts`），编辑弹窗只存在于管理后台（`admin/src/views/scheduled-tasks/ScheduledTaskFormDialog.vue`）。提案 §3.4"桌面编辑弹窗加配置项"不成立，配置面 = Agent 工具入参 + admin 弹窗两侧。
- **单次失败今天已经进收件箱**：live 执行失败经 `task-terminal.service.ts` 的 `finishExecution(FAILED, SCHEDULED)` → `inbox.recordTaskTerminal` 产生 `TASK_FAILED` 条目（payload 带 `source: 'SCHEDULED'` 徽标）。提案规划的 `SCHEDULED_TASK_FAILED` 新类型会造成同一失败两条通知，本方案不新增（决策 #6）。
- **成本归因无需改 `llm_call`**：`RunTraceService`（`session/run-trace.service.ts`）已有成熟的"USER 消息锚定时间窗"聚合算法，定时任务每次触发都落一条带信封前缀的 USER 消息，天然是一个 run 窗口，聚合逻辑可抽取共享（决策 #8）。

## 2 需求描述

### 2.1 目标

1. **运行历史**：新增 `scheduled_task_run` 表，一行一个触发点（`task_id + fire_time` 唯一索引作幂等底座），记录状态、attempt、起止、耗时、成本、错误摘要、跳转会话；桌面任务卡片可展开"最近运行"，admin 详情同步可见。
2. **失败重试**：任务可配重试策略（次数 + 间隔），仅对"已开跑后收敛为 FAILED"的可转移类故障自动重提；配置类错误（预算 BLOCK、会话已删）不重试。重试不推进档期、不累加 `fire_count`，同一 `fire_time` 只一个 attempt 在飞。
3. **错过补偿**：启动时扫描停机期间错过的触发点，按任务策略 `RUN_ONCE`（补最近一次）/ `SKIP`（只记 missed）处理，错过的周期全部落 `MISSED` 历史行。
4. **失败升级**：连续失败达阈值（默认 3）自动暂停任务（映射现有 `status=PAUSED`）并进收件箱；手动恢复即清零计数。规则照抄 Webhook 触发器先例。
5. **不双跑**：重试、补跑、正常触发共享 `inFlight` 守卫 + `withSessionLock` + `fire_time` 唯一索引；补偿扫描幂等（`INSERT IGNORE` + CAS 写档期），与 `crash-recovery-runner.ts`（管"已提交但执行中断的会话"）经"是否已推进 `next_fire_time`"天然分层。

### 2.2 核心交互

- **桌面 `ScheduledTaskPanel.vue`**：任务卡片新增"最近运行"展开区——每行 = 触发时间（月-日 时:分）+ 状态徽标（成功/失败/取消/错过/重试中）+ attempt>1 时标注"第 N 次尝试" + 耗时 + 成本（`cost_micros/1e6` 格式化，对齐 `RunTracePanel`）+ 点击跳转创建会话（复用 `InboxDrawer.vue:88-95` 的 `setActiveSession` + `router.push('/tasks/${sessionId}')` 模式）。卡片 meta 行展示重试/补偿策略小字；自动暂停后展示"连续失败 N 次"。
- **收件箱**：新增一种条目"定时任务已自动暂停：{任务名}"（连续失败 N 次，已自动暂停；请检查后手动启用），无偏好开关、始终通知（对齐 `TRIGGER_DISABLED` 运维级事件口径）。单次失败沿用现有 `TASK_FAILED` 条目（source=SCHEDULED 徽标），不新增类型。
- **Agent 对话**：创建/更新任务时可带 `retry_max / retry_interval_minutes / missed_policy`；任务失败重试、错过补偿对用户透明，仅在运行历史与通知中可见。

### 2.3 明确不做

| # | 不做的事 | 理由 |
|---|---|---|
| 1 | `run_recent(N)` 补最近 N 次（N>1） | N>1 即批量补跑，对齐提案非目标"防复工当天被作业淹没"；只做 RUN_ONCE/SKIP 两档 |
| 2 | 桌面端新建任务编辑弹窗 | 桌面创建/修改一直靠对话 Agent，自造编辑弹窗是第二配置入口，与现状割裂；配置走 Agent 工具 + admin 弹窗 |
| 3 | 新增 `SCHEDULED_TASK_FAILED` 收件箱类型 | 单次失败今天已有 `TASK_FAILED`（source=SCHEDULED），新增类型会双重通知（决策 #6） |
| 4 | 给 `llm_call` 加 `scheduled_task_id` 列 | 改高频写路径 + 历史回填，成本高；窗口聚合归因已够用（决策 #8） |
| 5 | 手动"立即运行一次"入口 | 超出提案范围；错过补偿的 SKIP 损失由 MISSED 历史行兜底可见，后续可按需补 |
| 6 | 多实例调度选主 / 跨实例互斥 | 当前单实例部署；补偿扫描幂等 + CAS，蓝绿双跑与既有 `listDue` 双扫同边界，不新增互斥（风险 §10） |
| 7 | 改 `task-terminal.service.ts` 收敛逻辑 | 风险提示明令；本方案只读终态、在 schedule 域侧收敛（决策 #2） |
| 8 | 子代理会话成本计入 run 成本 | run 窗口只聚合主会话 `llm_call`，与 run trace 主窗口口径一致；子代理成本在其自身会话可见 |
| 9 | 运行记录超过 90 天的归档/导出 | 只存摘要不存内容，到期硬删（对齐 inbox 90 天清理先例，决策 #10） |

## 3 决策记录

> 以下 11 条对应提案的决策树分支，按依赖排序，**2026-10-09 已逐条与需求方确认**。每条附理由与被否定的备选，作为实施与复查的依据。

**#1 范围：P1+P2+P3 三阶段一次成文，实施仍分批。**
理由：三者共享 `scheduled_task_run` 表与终态收敛点，分开设计必然二次返工；文档内按阶段标注，每阶段独立可测可回滚。备选"只做 P1"被否：重试的 attempt 列、补偿的 MISSED 行都是表结构的一部分，P1 单独落地会持有死列或二次迁移。

**#2 可重试边界：只重试"已开跑后收敛为 FAILED"的可转移类故障。**
判定表见 §6.3。可重试 = live 回读 FAILED / 执行期异常 / 排队消费 FAILED（模型侧、暂时性）；不可重试 = 预算 BLOCK（限额语义非故障，重试无意义且每周期空跑比暂停伤害小）、会话已删（`SESSION_NOT_FOUND`，重试必然再失败）、用户取消（`CANCELLED`，主动行为）、线程池满（已有 `nextFireTime` 回滚 + 下轮扫描重试，不双重重试）。备选"白名单只重试明确错误码"被否：终态处只有错误消息文本，模式匹配漏重试风险高于误重试；备选"预算 BLOCK 也重试"被否：持续限额下重试是纯烧配额。

**#3 重试配置：Agent 工具 + admin 弹窗两侧可配；默认 2 次 / 固定 5 分钟。**
新增列 `retry_max`（默认 2，上限 5）、`retry_interval_minutes`（默认 5，范围 1-60）。桌面不建编辑弹窗（决策 §2.3 #2）。固定间隔不指数退避：最大 3 次尝试内退避收益可忽略，固定间隔用户可预期。备选"默认关闭"被否：无人值守场景"迟到总比没有好"，默认开启才兑现提案目标；备选"默认 3 次对齐提案示例"被否：模型持续故障时默认多烧一轮，2 次已覆盖绝大多数瞬时故障。

**#4 错过补偿默认 `RUN_ONCE`（补最近一次），`SKIP` 可选；不做 run_recent。**
理由：现状行为就是复工补一次，`RUN_ONCE` 是零行为变更 + 补记 MISSED 历史；`SKIP` 留给"迟到的报告比没有更糟"的任务显式选择。中间错过的周期一律记 MISSED。备选"默认 SKIP"被否：按天任务因 5 分钟重启错过今天 9:00 也跳过，用户直接损失一天且无手动运行入口；备选"宽限窗口制"被否：多一个隐藏规则，实现与测试都更重，收益边际。

**#5 连败自动暂停：阈值 3 次（常量），映射 `status=PAUSED`，恢复清零。**
照抄 `webhook_trigger` 五步模式（列 + `recordOutcome` 事务 + 阈值常量 + 停用即重置 + 通知）。3 比 Webhook 的 5 更及时：定时任务用户不在电脑前。计数规则：COMPLETED 清零 / FAILED +1 / CANCELLED 不计不清；同一 `fire_time` 多次 attempt 只计 1 次连败（按 run 计不按 attempt 计，否则 2 次重试的任务 3 个 run 就暂停）。备选"阈值进 system_setting"被否：全局参数代码常量即可（KISS，对齐 Webhook）；备选"新增 PAUSED_BY_SYSTEM 状态"被否：复用启停语义，不造第二暂停态。

**#6 通知：单次失败复用 `TASK_FAILED`，仅新增"自动暂停"一种 kind。**
单次失败今天已由 `task-terminal` 写入 `TASK_FAILED`（source=SCHEDULED），新增 `SCHEDULED_TASK_FAILED` 会双重通知，且需抑制原路径，复杂度纯增。新增 `SCHEDULED_TASK_PAUSED` 对齐 `TRIGGER_DISABLED`：无偏好开关、始终通知（运维级事件）。已知怪癖不修（超范围）：`isKindEnabled` 的 `TASK_FAILED` 当前读 `taskCompletedEnabled` 开关（`inbox.service.ts` 无独立 task_failed 列），即"任务完成"开关同时门控失败通知——本方案只记录不改。

**#7 运行记录粒度：一行一触发点，attempt 覆盖更新。**
`UNIQUE(task_id, fire_time)` 同时是幂等底座与重试续跑锚点；`error_summary` 保留最近一次 attempt，`attempt` 列递增。备选"一行一 attempt"被否：唯一索引要带 attempt，幂等判定与补偿插入都变复杂，"最近运行"列表也按 attempt 膨胀。

**#8 成本/耗时：duration 用窗口墙钟聚合（回落起止差值），cost 复用 run 窗口求和 `llm_call.cost_micros`。**
从 `run-trace.service.ts` 抽取 `aggregateWindowTotals(calls)` 共享（§6.9），不给 `llm_call` 加列。窗口 = 锚点 USER 消息 → 下一条 USER 消息，直跑路径终态时上界通常未产生，取值精确；任一行未配价则整组 null（与轨迹面板口径一致）。已知限制：busy 排队路径的执行起点不可知，该路径 run 行 `duration_ms/cost_micros` 记 null（§6.9）。

**#9 重试触发：DB 驱动（`next_retry_at` 列 + 60s 扫描捞起），补偿扫描只在启动时执行一次。**
重试计划落库才重启安全；进程内 `setTimeout` 重启即丢，反而要额外恢复扫描。补偿只扫启动一次：运行期迟触已由 60s 主循环覆盖（`next_fire_time <= now` 自然触发），不另做周期巡检；孤儿 run 行收敛除外（§6.6，靠 crash-recovery 终态钩子 + 小时级安全网）。

**#10 运行记录保留 90 天，代码常量，定时硬删。**
对齐 `inbox.cleanup.ts` 先例；数据保留策略提案已否决，本表只存摘要不存内容，独立短保留无冲突。备选"180 天/不清理"被否：与 inbox 对齐即可，更短不增加运维成本。

**#11 运行历史 UI 落点：桌面卡片展开 + admin 详情区，不做独立页。**
桌面是用户视角（提案既定），admin 详情弹窗加"运行历史"区是运维视角的低成本增量（同一个 runs 端点 + `scheduled-task:read` 权限）；独立历史页与现有设置页信息重复。

## 4 技术选型

| 关注点 | 选型 | 理由 |
|---|---|---|
| 错过点迭代 | croner `new Cron(expr, {timezone:'Asia/Shanghai'}).nextRun(Date)` 逐点推进 | 与 `calculateNextFireTime` 同库同时区，预览=实际；单点上限 `MAX_MISSED_POINTS_PER_TASK=100` 防分钟级 cron 长期停机爆炸 |
| 重试调度 | `scheduled_task_run.next_retry_at` 列 + 60s 主扫描融合捞起 | 重启安全、无进程内状态；与 `listDue` 同一循环，不新增 timer |
| 幂等底座 | `UNIQUE(task_id, fire_time)` + `INSERT IGNORE` + 档期 CAS 写 | 补偿扫描双实例跑、重启重入均安全 |
| 连败计数 | 照抄 `openapi.repository.ts:119-157` 的 `SELECT ... FOR UPDATE` 同事务读-改-写 | 池化 autocommit 下两条语句分会话丢计数（原注释已论证） |
| 通知 | `InboxService.record` 统一收口 + 新 kind + dedup_key | 幂等、偏好门控、WS 广播全部复用 |
| 成本聚合 | 抽取 `aggregateWindowTotals` 共享给 run-trace 与 schedule 两域 | 单一算法实现，防两处漂移 |

## 5 数据模型

> 迁移编号以实施时实际空闲号顺延（提案 README 已提示第五批多份提案都拟用 V142；下表 V142/V143 为拟定号）。

### 5.1 V142 `scheduled_task_run`（P1）

```sql
CREATE TABLE IF NOT EXISTS `scheduled_task_run` (
    `id`                BIGINT       NOT NULL AUTO_INCREMENT,
    `task_id`           BIGINT       NOT NULL COMMENT '所属定时任务',
    `fire_time`         DATETIME     NOT NULL COMMENT '计划触发点（cron 档期，Asia/Shanghai）',
    `attempt`           INT          NOT NULL DEFAULT 1 COMMENT '第几次尝试（重试递增，补偿补跑从 1 起）',
    `status`            VARCHAR(20)  NOT NULL DEFAULT 'RUNNING' COMMENT 'RUNNING/QUEUED/COMPLETED/FAILED/CANCELLED/MISSED',
    `session_id`        BIGINT       NOT NULL COMMENT '执行会话（任务绑定会话）',
    `message_id`        BIGINT       NULL COMMENT '锚点 USER 消息 id（成本/耗时窗口起点；排队路径为空）',
    `started_at`        DATETIME     NULL COMMENT '实际开跑时刻（排队路径为空）',
    `finished_at`       DATETIME     NULL COMMENT '终态时刻',
    `duration_ms`       BIGINT       NULL COMMENT '执行耗时：窗口 llm_call 墙钟聚合，无调用回落 finished-started',
    `cost_micros`       BIGINT       NULL COMMENT '窗口内 llm_call 成本合计（x1e6）；任一行未配价为 NULL',
    `error_summary`     VARCHAR(500) NULL COMMENT '最近一次 attempt 的错误摘要',
    `next_retry_at`     DATETIME     NULL COMMENT '下次重试时刻（P2；无待重试为 NULL）',
    `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_task_run_fire` (`task_id`, `fire_time`),
    KEY `idx_task_run_status_retry` (`status`, `next_retry_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='定时任务运行记录';
```

设计要点：

- `uk_task_run_fire` 是幂等底座：重试 = 同 `fire_time` 的 attempt 覆盖更新；补偿补跑 = 该 `fire_time` 行从 MISSED 改回 RUNNING；正常触发 = 新行。任何路径同一触发点只产生一行。
- `idx_task_run_status_retry` 服务重试扫描（`status='FAILED' AND next_retry_at <= now`）。"最近运行"列表按 `fire_time DESC` 走唯一索引左前缀，无需额外索引。
- 状态词汇与 `scheduled_task.last_execution_status` 对齐（QUEUED/COMPLETED/FAILED/CANCELLED），新增瞬态 RUNNING 与终态 MISSED（错过未跑）。
- 任务软删时级联软删 run 行不必要——run 行无 `deleted` 列，任务删后按 `task_id` 仍可查（会话跳转目标可能已删，前端降级提示，对齐 inbox 条目会话删除降级）；90 天清理兜底。

### 5.2 V143 `scheduled_task` 增列（P2/P3）

```sql
ALTER TABLE `scheduled_task`
    ADD COLUMN `consecutive_failures`  INT         NOT NULL DEFAULT 0 COMMENT '连续失败计数：FAILED+1 / COMPLETED 清零 / 达阈值自动暂停 / 手动启用重置',
    ADD COLUMN `retry_max`             INT         NOT NULL DEFAULT 2 COMMENT '失败后最大重试次数（不含首次），0=不重试，上限 5',
    ADD COLUMN `retry_interval_minutes` INT        NOT NULL DEFAULT 5 COMMENT '重试间隔（分钟，固定），范围 1-60',
    ADD COLUMN `missed_policy`         VARCHAR(20) NOT NULL DEFAULT 'RUN_ONCE' COMMENT '错过补偿策略：RUN_ONCE 补最近一次 | SKIP 只记录不补';
```

- `consecutive_failures` 照抄 `webhook_trigger.consecutive_failures`（V133）列定义与计数规则。
- 三个配置列全部带 DEFAULT，存量任务零迁移动作即获得"重试 2 次 / 间隔 5 分钟 / 错过补一次"默认行为。
- `ScheduledTask` 接口（service.ts:12-32）同步加四个可选字段；`updateById` 列级增量 patch 已支持任意列，store 无需改方法。

## 6 后端设计

### 6.1 执行路径 attempt 化重构

`executeTask`（service.ts:355-585）现有结构保持不动，把 `withSessionLock` 内的异步执行体抽为 `runAttempt(task, ctx)`，`ctx = { fireTime, attempt, isRetry }`：

- **正常触发**（`executeTask`）：`ctx = { fireTime: <本次档期>, attempt: 1, isRetry: false }`。推进 `next_fire_time`、`fireCount+1`、finally 重算档期/once 完结——全部逻辑原样保留。
- **重试提交**（新 `retryRun(run)`，§6.4）：`ctx = { fireTime: run.fireTime, attempt: run.attempt + 1, isRetry: true }`。**不推进 `next_fire_time`、不累加 `fire_count`**（重试不是新触发）；once 任务在仍有 pending 重试时不得置 `finished`（finally 的 once 完结判定追加"无 pending retry"条件）。
- 两条路径共用 `inFlight` 守卫（同一任务同时只一个 attempt 在飞）、`withSessionLock`、busy 入队、预算闸门、终态收敛——不双跑保证不变。

`runAttempt` 入口（`withSessionLock` 内、锁内重读 `latest` 之后、会话加载之前）：

```
首次 attempt 且 !isRetry → INSERT IGNORE INTO scheduled_task_run
    (task_id, fire_time, attempt=1, status='RUNNING', session_id, created_at, updated_at)
    （IGNORE：补偿扫描可能已为该 fire_time 写过 MISSED 行——补跑场景，见 §6.5）
isRetry → UPDATE scheduled_task_run SET attempt=attempt+1, status='RUNNING',
    started_at=NULL, finished_at=NULL, error_summary=NULL, next_retry_at=NULL
    WHERE task_id=? AND fire_time=?
```

### 6.2 运行记录生命周期与终态收敛 `finishRun`

所有终态站点统一收口到新私有方法 `finishRun(run, status, opts?: { error?, retryable? })`，与 `markTaskResult` 并列调用（不改 `markTaskResult` 本身）：

| 站点（service.ts 行号） | run 状态 | 可重试 |
|---|---|---|
| busy 入队成功（426-453） | QUEUED（attempt 行已由入口建） | —（等队列消费） |
| 预算 BLOCK（459-468） | FAILED，`error_summary='预算不足，执行被准入闸门阻止'` | 否 |
| saveMessage 失败（475-479） | FAILED | 是（临时性） |
| live 回读 FAILED/CANCELLED（486-492） | 同相位 | FAILED 是 / CANCELLED 否 |
| 成功收尾（507） | COMPLETED | — |
| catch 执行期异常（511-526） | FAILED | 是 |
| sessionGone（529-541） | FAILED，`error_summary='会话已删除'` | 否 |
| `settleQueuedExecution`（635-645，队列消费回写） | COMPLETED/FAILED/CANCELLED | FAILED 是 |

`finishRun` 动作序列：

1. `UPDATE run SET status, finished_at=now, duration_ms, cost_micros, error_summary`（§6.9 算耗时成本）；
2. FAILED 且 retryable 且 `attempt < 1 + task.retry_max` 且任务 `status='ACTIVE'` → `next_retry_at = now + retry_interval_minutes`；
3. 调用 §6.7 的 `recordOutcome(taskId, phase)` 连败计数（CANCELLED 不计）；
4. once 任务重试耗尽（FAILED 且不再重试）时由调用方 finally 置 `finished`（§6.1），`finishRun` 不碰任务行。

排队路径的 disambiguation：`settleQueuedExecution(taskId, status)` 无 fire_time 上下文，按"该任务最老的 QUEUED 行"匹配（`WHERE task_id=? AND status='QUEUED' ORDER BY id ASC LIMIT 1`）——message_queue 严格 FIFO（sort_order）消费，首次 settle 对应最早入队的 run；补偿把出队行 `enqueueHead` 回补队首也不破坏顺序。

### 6.3 可重试判定汇总

| 失败形态 | 重试 | 理由 |
|---|---|---|
| live/harness 执行期 FAILED（模型故障、超时、临时异常） | ✅ | 提案目标本体 |
| saveMessage / 提交期临时错误 | ✅ | 暂时性 |
| 排队消费终态 FAILED | ✅ | 同上，经同一 `finishRun` |
| 预算 BLOCK | ❌ | 限额语义；持续限额下重试纯烧配额，且每周期空跑比自动暂停伤害小 |
| 会话已删（SESSION_NOT_FOUND） | ❌ | 重试必然再失败；任务同时置 finished 停掉后续档期 |
| 用户取消（CANCELLED） | ❌ | 主动行为 |
| 线程池满（AgentExecutorRejectedError） | ❌ | 提交前同步拒绝，已有 `nextFireTime` 回滚 + 下轮扫描，不双重重试 |

### 6.4 重试调度（P2）

`ScheduledTaskScheduler.scanAndExecute`（744-774）在 `listDue` 循环之后追加：

```
dueRetries = store.listDueRetries(now)   -- status='FAILED' AND next_retry_at <= now
for run of dueRetries:
    task = store.selectById(run.task_id)
    if task == null || task.status !== 'ACTIVE' || task.finished === 1: continue
    await service.retryRun(run, task)
```

- `retryRun`：`inFlight` 守卫 → 经 `agentExecutor` 提交 `runAttempt(task, { fireTime: run.fireTime, attempt: run.attempt+1, isRetry: true })`；池满同步拒绝时保留 `next_retry_at` 下轮再试（不回滚任何档期——档期本就未动）。
- 重试期间任务被暂停/删除：`runAttempt` 锁内重读 `status != ACTIVE` → 走"未开跑放弃"分支（不回滚档期，重试无档期可回；run 行保持 FAILED，`next_retry_at` 清空）。
- once 任务：首次 attempt 失败即按现逻辑置 `finished`——**追加条件**：仅当无 pending 重试时才完结；重试耗尽后补置 `finished=1, finishedAt, nextFireTime=null`。

### 6.5 错过补偿（P3）

启动时（`ScheduledTaskScheduler.start()` 内、首轮 `scanAndExecute` 之前）执行一次 `compensateMissed(processStartedAt)`：

1. 捞 `status='ACTIVE' AND finished=0 AND next_fire_time < processStartedAt` 的任务（`next_fire_time` 在未来 = 没错过，交给 60s 主循环）。
2. 逐任务按 cron 迭代错过点：`t = next_fire_time`；`while (t < now && points.length < 100) { points.push(t); t = cron.nextRun(t) }`（`nextRun(Date)` 返回该时刻之后的下一个触发点）。
3. 为每个错过点 `INSERT IGNORE` run 行 `status='MISSED'`（已存在行不覆盖——补跑/崩溃场景，见下）。
4. 按 `missed_policy`：
   - **RUN_ONCE（默认）**：`latest = points[last]`；CAS 写 `UPDATE scheduled_task SET next_fire_time = latest WHERE id = ? AND next_fire_time = <原值>`（用户改过则不覆盖）；`latest` 点**不**写 MISSED——60s 主循环扫到即补跑，`runAttempt` 入口的 `INSERT IGNORE` 自然接管。实际效果 = 现状行为 + 中间错点留痕。
   - **SKIP**：所有错过点（含最近一个）记 MISSED；`next_fire_time = cron.nextRun(now)`（第一个未来点）。
5. once 任务错过且 SKIP：追加 `finished=1, finished_at=now, next_fire_time=null`（唯一一次配额没跑掉，记 MISSED 后完结，不无限欠账）；once + RUN_ONCE：正常补跑一次后按现逻辑完结。

幂等性：`INSERT IGNORE` + CAS 写保证重启重入、蓝绿双实例各跑一次均安全（第二个实例看到 `next_fire_time` 已是未来值或 MISSED 行已存在）。

### 6.6 孤儿 run 行 reconcile（P3）

崩溃时"已提交未收敛"的执行，其 run 行停留在 RUNNING（进程死在终态回写之前），而 `next_fire_time` 已推进到未来——补偿扫描看不到它，`crash-recovery-runner` 续跑会话后又无人回写 run 行。三级收敛：

1. **crash-recovery 终态钩子（主路径，及时）**：`create-app.ts:2684` 的 `onExecutionFinished(sessionId, userId, phase)` 回调里追加 `scheduledService.reconcileRunsForSession(sessionId, phase)`——把该会话 `status='RUNNING'` 的 run 行按 phase 收敛（补算耗时/成本）。崩溃恢复续跑以真实终态结束，钩子必然触发。
2. **启动 reconcile（兜底）**：启动扫描把 `status IN ('RUNNING','QUEUED')` 且会话相位已是终态 / 会话已删的行收敛（写回进程死在半路的情形）；会话仍 RUNNING/RESUMING 的一律不动（无论本实例还是蓝绿伙伴在跑）。
3. **小时级安全网（scheduler 内）**：每 60s 主循环顺带检查（计数到小时）把 `status='RUNNING'` 且 `updated_at < now - 6h` 且会话终态/已删的行收敛；`status='QUEUED'` 且 `updated_at < now - 24h` 的置 CANCELLED（`error_summary='长时间未消费'`）——排队行正常由 settle 回写，此网只防永久卡死。

### 6.7 连续失败与自动暂停（P3）

store 新增 `recordOutcome(taskId, phase, pauseAfter, now)`，逐行照抄 `openapi.repository.ts:125-157` 的 `FOR UPDATE` 事务读-改-写：

- COMPLETED → `consecutive_failures = 0`；
- FAILED → `+1`，`>= pauseAfter` 时同时 `status='PAUSED'`，返回 `{ paused: true }`；
- CANCELLED / 行已删或已暂停 → 不计不累加，返回 null。

阈值常量 `TASK_PAUSE_AFTER_FAILURES = 3`（service 文件头，对齐 `TRIGGER_DISABLE_AFTER_FAILURES` 先例）。调用点：`finishRun` 步骤 3（run 级终态，一触发点一次，与 attempt 无关——决策 #5）。暂停后经 `setFailureNotifier` 晚绑定注入的 notifier 发收件箱（§6.8）；通知失败只 warn 不抛出（对齐 webhook L251-253，停用本身已成功）。恢复清零：`updateTask` 显式把 `status` 改为 ACTIVE 时，patch 追加 `consecutiveFailures: 0`（对齐 webhook `update` L157-161"启停即重置"）。

### 6.8 通知（P3）

- `shared/contracts/src/inbox.ts` `InboxKind` 增加 `'SCHEDULED_TASK_PAUSED'`；`src/inbox/types.ts` `INBOX_KINDS` 同步；`inbox.service.ts` 新增 `recordScheduledTaskPaused(input)`（照抄 `recordTriggerDisabled` L142-158）：title `定时任务已自动暂停：{name}`，content `连续失败 {n} 次，已自动暂停；请检查模型/Agent 配置后手动启用`，payload `{ taskId, taskName, failures }`，tail `${taskId}:${Date.now()}`（每次暂停都可达），`sessionId` 传任务会话（可跳转）。`isKindEnabled` 增加 case 返回 true（无偏好开关）。
- 单次失败：不新增 kind、不改 `recordTaskTerminal`（决策 #6）。
- 装配：`create-app.ts` 在 `scheduledService` 构造后 `setFailureNotifier({ notifyTaskPaused: (input) => inboxService.recordScheduledTaskPaused(input) })`——`inboxService`（L932）先于 `scheduledService`（L1075）构造，无循环依赖；setter 模式对齐既有 `setBudgetCheck`。

### 6.9 成本/耗时聚合（P1）

从 `run-trace.service.ts` 抽取模块级共享函数（`session/run-window.ts` 新文件）：

```ts
export interface WindowTotals { costMicros: number | null; wallClockMs: number | null }
/** 窗口内 llm_call 成本合计（任一行未配价 → null）与墙钟耗时（max(end)-min(start)，无调用 → null）。 */
export function aggregateWindowTotals(calls: LlmCallRow[]): WindowTotals
```

`run-trace.service.ts:284-320`（buildRun 内的合计与 `wallClockMs` 组装，569 行函数）改为调用它——行为不变，由既有 run-trace spec 锁定。`finishRun` 也用同一函数：

- 直跑路径：锚点 = `run.message_id`（`saveMessage` 返回值 id）。窗口 = `[锚点 created_at, 下一条 USER 消息 created_at)`；终态时刻下一条通常未产生 → 上界 null（`selectBySessionWindow(sessionId, start, null)` 取到最新，即本次执行全部调用）。查询 `messageRepo.selectUserStamps(sessionId)` 取上界（run-trace 同款）。
- `duration_ms` = `wallClockMs`；窗口无调用（秒败/无 LLM 交互）回落 `finished_at - started_at`。
- 排队路径：执行起点不可知（消息由队列消费侧落库），`message_id/started_at/duration_ms/cost_micros` 记 null，UI 显示"—"。占比小（仅触发时会话正忙），已知限制记录在案；后续如需精确，可扩展 `onScheduledTaskQueueConsumed` 回调透传锚点消息 id。

### 6.10 REST API 与工具入参

- `GET /v1/scheduled-tasks/:id/runs?limit=20`（新）：本人或 `scheduled-task:read`；limit 1-50 默认 20；按 `fire_time DESC`；返回 `ScheduledTaskRun[]`。归属校验复用 `getTaskOwnedByUser`。无分页游标（运行历史只关心最近 N 条，对齐 §2.3 #9 的 90 天短保留）。
- `PUT /v1/scheduled-tasks/:id` 请求体扩展：`retryMax`（0-5）、`retryIntervalMinutes`（1-60）、`missedPolicy`（`RUN_ONCE|SKIP`），非法值 `PARAM_INVALID`。`updateTask` 签名追加可选参（现有 7 位置参 + `opts`，再加 `retryOpts` 或收敛为 options 对象，实施时定——倾向第 8 个可选参 `retryOpts?`，改动面最小）。
- Agent 工具：`create_scheduled_task` / `update_scheduled_task` 入参各加 `retry_max`（integer 0-5）、`retry_interval_minutes`（integer 1-60）、`missed_policy`（string enum），`getToolPrompt` 补一段"失败重试与错过补偿"说明（何时建议开启、默认值语义）。
- `GET /v1/scheduled-tasks`（列表）与 `/all`（管理端）响应体随 `ScheduledTask` 接口自动带出新字段，无需改路由。

## 7 前端设计

### 7.1 桌面 `ScheduledTaskPanel.vue` + `useScheduledTasks.ts`

- 任务卡片：meta 行追加策略小字（`重试 2 次 · 间隔 5 分 · 错过补跑`，缺省值不显示减少噪音）；`status==='PAUSED' && consecutiveFailures>0` 时显示"连续失败 N 次"。
- 卡片底部加"最近运行"折叠区（`el-collapse` 或行内展开按钮，默认收起）：`fetchRuns(taskId)` 拉 `/scheduled-tasks/:id/runs`；每行 = `formatFireTime` + 状态徽标（COMPLETED 成功 / FAILED 失败 / CANCELLED 取消 / MISSED 错过 / QUEUED 排队 / RUNNING 运行中；`attempt>1` 追加"第 N 次尝试"）+ `formatDuration(durationMs)` + `formatCost(costMicros)`（`/1e6`，对齐 `RunTracePanel.vue:408`）+ `next_retry_at > now` 时显示"待重试 hh:mm"）+ 点击整行跳转会话（`InboxDrawer.vue:88-95` 模式）。
- `useScheduledTasks.ts`：新增 `ScheduledTaskRun` 类型、`runs`/`runsLoading` 状态（按 taskId 缓存 Map）、`formatDuration`/`formatCost`；`ScheduledTask` 类型加 `consecutiveFailures/retryMax/retryIntervalMinutes/missedPolicy`。
- 会话已删降级：跳转前 `fetchSession` 失败 → toast 提示（对齐 inbox 条目降级）。

### 7.2 管理后台

- `ScheduledTaskFormDialog.vue`：新增三个表单项——重试次数（`el-input-number` 0-5）、重试间隔（1-60 分钟）、错过补偿（`el-radio-group`：补最近一次 / 只记录不补，附一句说明）。提交带入 PUT body。
- `ScheduledTaskDetailDialog.vue`：`el-descriptions` 下方加"运行历史"区（表格：触发时间/状态/attempt/耗时/成本/错误摘要），调 runs 端点；descriptions 区补"连续失败次数"项。
- `types.ts` 同步加字段。

### 7.3 展示层同步（AGENTS.md 规范）

工具入参扩展不新增/重命名工具，不触发 `tool-result-summarizer.ts` / `toolDisplay.ts` 改动；但工具 schema 与 `getToolPrompt` 变更需补/改 `scheduled-task-tools` 相关 spec。

## 8 分阶段实施

| 阶段 | 内容 | 涉及文件 | 规模 |
|---|---|---|---|
| P1 | V142 run 表 + `runAttempt` 入口插桩 + `finishRun`（无重试字段写入）+ `aggregateWindowTotals` 抽取 + runs API + 桌面展开列表 + admin 详情区 + 90 天清理 | `scheduled-task.service.ts`、`scheduled-task.store.ts`、`scheduled-task.routes.ts`、`session/run-window.ts`（新）、`run-trace.service.ts`、desktop/admin 三文件、`V142__scheduled_task_run.sql` | 中 |
| P2 | V143 任务列 + 重试配置（工具/admin/API）+ `retryRun` + 扫描捞起 + 可重试判定 + once×重试交互 | 上述 service/store/routes/tools/admin form + `V143__scheduled_task_reliability_columns.sql` | 中 |
| P3 | 启动补偿扫描 + MISSED 行 + reconcile 三级收敛 + `recordOutcome` 连败 + 自动暂停 + `SCHEDULED_TASK_PAUSED` 通知 | service/store/contracts/inbox/create-app + desktop 展示 | 中 |

每阶段独立发版、独立回滚；P1 落地后运行历史即生效（attempt 恒 1、无 next_retry_at 写入）。

## 9 测试要点

**P1**

- run 行生命周期：正常触发建行→终态回写；busy 入队建 QUEUED 行→消费 settle 按 FIFO 收敛最老 QUEUED 行；会话删（sessionGone）收敛 FAILED。
- 幂等：同一 `fire_time` 并发/重启只一行；补偿 `INSERT IGNORE` 不覆盖既有行。
- 历史一致性：面板"最近运行"状态/耗时/成本与 `llm_call` 实算一致；`cost_micros` 未配价时 null；跳转落到任务会话。
- `aggregateWindowTotals` 抽取后 run-trace 既有 spec 全绿（行为不变回归）。
- 90 天清理：过期行删、临界行留。

**P2**

- 可重试失败按策略重提且 attempt 递增、`next_retry_at` 到期被扫描捞起；池满拒绝保留 `next_retry_at` 下轮再试。
- 达 `retry_max` 标记 FAILED 不再重提；配置类错误（预算 BLOCK、会话已删）不重试；CANCELLED 不重试。
- 重试不推进 `next_fire_time`、不累加 `fire_count`；once 任务 pending 重试期间不完结、耗尽后完结。
- 重试中任务被暂停/删除：安全放弃不改档期。

**P3**

- 停机跨触发点：复工后 RUN_ONCE 只补一次（中间错点 MISSED）、SKIP 一次不补（全 MISSED + 档期进未来）；once×SKIP 完结；分钟级 cron 长停机受 100 点上限保护。
- 补偿扫描重启重入 / 双实例并发：幂等无重复行、CAS 不覆盖用户改期。
- reconcile：crash-recovery 终态钩子收敛 RUNNING 行；启动 reconcile 收敛会话已终态/已删的行；活跃会话（含蓝绿伙伴）不动。
- 连败：FAILED+1 / COMPLETED 清零 / CANCELLED 不计 / 一触发点多 attempt 只计 1 次；达 3 次自动 PAUSED + 通知一次；手动启用清零后可正常触发。
- 通知：自动暂停条目进收件箱（无开关门控）、dedup 允许同任务多次暂停各通知一次。
- 矩阵：停机 × 失败 × 超周期 × once × busy 排队组合（提案 §5 要求）。

## 10 风险与排期注意

- **收敛点相邻**：P2/P3 在 `finishRun` 只读终态、不重写 `task-terminal.service.ts` 的 `finishExecution`；与在途同类改动（记忆/收件箱/预算都动过该文件）错开实施。
- **补偿 × 重试叠加**：停机期间无提交即无重试欠账，复工先补偿后重试，两条路径经 attempt 与状态机分离；矩阵测试覆盖（§9）。
- **蓝绿双实例**：补偿扫描幂等 + CAS，与既有 `listDue` 双扫同边界；reconcile 只对"会话已终态/已删"的行动手，不碰活跃会话，零误伤伙伴实例在途执行。
- **窗口归因误差**：直跑路径窗口精确；崩溃延迟收敛的行可能多算后续执行的调用（记录在案，占比极小）；排队路径无成本/耗时（§6.9）。
- **通知风暴**：单次失败仅一条 `TASK_FAILED`（现有行为），自动暂停每条任务最多一次；无 kind 爆炸。
- **迁移编号**：V142/V143 为拟定号，实施时按实际空闲号顺延（第五批提案 README 已提示冲突）。
- **死列窗口**：若 P1 先发版，`next_retry_at` 等 P2 列暂不写入（恒 NULL），无行为影响——与收件箱 P1/P2 同批落地避免死列的经验（task-inbox 实施偏差①）相反，此处选择接受一个版本的死列换取分期清晰；如介意可 V142 一次建全。
