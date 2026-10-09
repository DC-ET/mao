# 定时任务可靠性（重试 / 错过补偿 / 运行历史 / 失败升级）技术方案

- 日期：2026-10-09
- 状态：**已确认，评审通过，可实施**（2026-10-09 与需求方逐条确认 §3 全部 11 条决策，口径不变；同日对照调度器、收件箱白名单、崩溃恢复回调和 croner 复核，可行性成立，缺口已补进 §6–§10）。
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

- **桌面 `ScheduledTaskPanel.vue`**：任务卡片新增"最近运行"展开区——每行 = 触发时间（月-日 时:分）+ 状态徽标 + attempt>1 时标注"第 N 次尝试" + 耗时 + 成本（`cost_micros/1e6` 格式化，对齐 `RunTracePanel`）+ 点击跳转创建会话（复用 `InboxDrawer.vue:88-95` 的 `setActiveSession` + `router.push('/tasks/${sessionId}')` 模式）。徽标：COMPLETED 成功 / CANCELLED 取消 / MISSED 错过 / QUEUED 排队 / RUNNING 且 attempt=1 运行中 / RUNNING 且 attempt>1 **重试中** / FAILED 且 `next_retry_at` 未到 **待重试** / 其余 FAILED 失败。卡片 meta 行仅在策略偏离默认（2 次 / 5 分钟 / RUN_ONCE）时展示小字；自动暂停后始终展示"连续失败 N 次"。
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
不给 `llm_call` 加列。成本与轨迹同一算法（空窗口或任一行未配价 → null）。运行历史的墙钟只含本窗口 `llm_call`，无调用时回落起止差；轨迹面板的墙钟另外含工具活动，抽取时保持轨迹原行为（§6.9）。重试成功只统计最新 attempt 的锚点窗口。已知限制：busy 排队路径的执行起点不可知，该路径 `duration_ms/cost_micros` 记 null。

**#9 重试触发：DB 驱动（`next_retry_at` 列 + 60s 扫描捞起），补偿扫描只在启动时执行一次。**
重试计划落库才重启安全；进程内 `setTimeout` 重启即丢，反而要额外恢复扫描。补偿只扫启动一次：运行期迟触已由 60s 主循环覆盖（`next_fire_time <= now` 自然触发），不另做周期巡检；孤儿 run 行收敛除外（§6.6，靠 crash-recovery 终态钩子 + 小时级安全网）。

**#10 运行记录保留 90 天，代码常量，定时硬删。**
对齐 `inbox.cleanup.ts` 先例；数据保留策略提案已否决，本表只存摘要不存内容，独立短保留无冲突。备选"180 天/不清理"被否：与 inbox 对齐即可，更短不增加运维成本。

**#11 运行历史 UI 落点：桌面卡片展开 + admin 详情区，不做独立页。**
桌面是用户视角（提案既定），admin 详情弹窗加"运行历史"区是运维视角的低成本增量（同一个 runs 端点 + `scheduled-task:read` 权限）；独立历史页与现有设置页信息重复。

## 4 技术选型

| 关注点 | 选型 | 理由 |
|---|---|---|
| 错过点迭代 | croner `nextRun(Date)` 逐点推进；走不完时用 `nextRun` 二分定位最后一个 `< now` 的点 | 与 `calculateNextFireTime` 同库同时区。croner 的 `previousRun()` 是任务实例的上次运行时刻，不能按给定日期回溯。落库上限 100 行，但补跑目标必须是窗口内最后一点，不能是第 100 个旧点 |
| 重试调度 | `scheduled_task_run.next_retry_at` 列 + 60s 主扫描融合捞起 | 重启安全、无进程内状态；与 `listDue` 同一循环，不新增 timer |
| 幂等底座 | `UNIQUE(task_id, fire_time)` + `INSERT IGNORE` + 档期 CAS 写 | 补偿扫描双实例跑、重启重入均安全 |
| 连败计数 | 照抄 `openapi.repository.ts:119-157` 的 `SELECT ... FOR UPDATE` 同事务读-改-写 | 池化 autocommit 下两条语句分会话丢计数（原注释已论证） |
| 通知 | `InboxService.record` 统一收口 + 新 kind + dedup_key | 幂等、偏好门控、WS 广播全部复用 |
| 成本聚合 | 抽取 `sumCostMicros`；`wallClockMs` 原样搬出。运行历史只把 llm_call 送进墙钟 | 成本口径与轨迹相同。墙钟若合成一个函数再丢掉活动点，轨迹面板的耗时会变（§6.9） |

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
    KEY `idx_task_run_status_retry` (`status`, `next_retry_at`),
    KEY `idx_task_run_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='定时任务运行记录';
```

设计要点：

- `uk_task_run_fire` 是幂等底座：重试 = 同 `fire_time` 的 attempt 覆盖更新；补偿补跑 = 该 `fire_time` 行从 MISSED 改回 RUNNING（`INSERT IGNORE` 做不到这步，见 §6.1）；正常触发 = 新行或接管刚插入的占位。任何路径同一触发点只产生一行。
- `idx_task_run_status_retry` 服务重试扫描（`status='FAILED' AND next_retry_at <= now`）。"最近运行"列表按 `fire_time DESC` 走唯一索引左前缀，无需额外索引。`idx_task_run_created` 给 90 天 `DELETE WHERE created_at < ?` 用：分钟级 cron 三个月可到十万行，不能靠全表扫。
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

档期推进与 run 行必须靠在一起。`executeTask` 在写完 `next_fire_time` 之后、`agentExecutor` 之前按下面的接管表放占位行：`fire_time = 推进前的 previousNextFireTime`，`attempt=1`，`status='RUNNING'`，`started_at=NULL`。只写档期、进程死在回调之前，这个触发点会从调度器消失，补偿也看不见（`next_fire_time` 已是未来），运行历史留不下。占位行让启动 reconcile 能把它收成可重试失败。

接管结果若是「已有开跑中的 RUNNING/QUEUED 或已是终态」，这次不能再跑：按现有 `restoreNextFireIfUnchanged` 把刚写上的下一档滚回去再返回。无行或 MISSED 才继续提交。

池满同步拒绝发生在回调之前：除了把 `next_fire_time` 滚回 due，还要删掉这行 `started_at IS NULL` 的占位。留下占位的话，下一轮真正开跑会被「已有 RUNNING」挡掉。

`runAttempt` 入口（`withSessionLock` 内、锁内重读 `latest` 之后、会话加载之前）按已有行接管，不用 `INSERT IGNORE` 充当更新。`INSERT IGNORE` 碰到已存在的行是 0 行更新，MISSED 补跑不会变回 RUNNING，终态行也不会拦住第二次开跑：

| 已有行 | 动作 |
|---|---|
| 无行 | `INSERT` RUNNING（重试路径不应走到这里） |
| `MISSED` | `UPDATE` 为 RUNNING，`attempt=1`，清 `finished_at/error_summary/next_retry_at`。这是 RUN_ONCE 补跑或竞态下补偿已落 MISSED 的接管 |
| `RUNNING` 且 `started_at IS NULL` | 正常触发的占位，接着跑，不要当成「已有人在飞」返回 |
| `RUNNING`/`QUEUED` 且已经开跑 | 直接返回，不双跑 |
| `COMPLETED`/`FAILED`/`CANCELLED` | 直接返回。失败后续跑只走 `isRetry` |

`isRetry`：`UPDATE ... SET attempt=attempt+1, status='RUNNING', message_id=NULL, started_at=NULL, finished_at=NULL, duration_ms=NULL, cost_micros=NULL, error_summary=NULL, next_retry_at=NULL WHERE task_id=? AND fire_time=? AND status='FAILED'`。`affected=0`（行已被改掉）则放弃。`saveMessage` 成功后把 `message_id` 写成这一次的锚点。成本窗口只覆盖最近一次 attempt，和「一行覆盖更新、error_summary 只留最近一次」一致；不更新的话上界会落在重试那条 USER 消息上，成功那次的费用被排除在外。

重试走 busy 入队时，入队分支现有的 `fireCount+1` / `lastFireTime` 必须跳过（`isRetry`）。该分支在 `finally` 之外单独计数，只改 `runAttempt` 的 finally 盖不住。一次性任务入队时今天会立刻 `finished=1`（service.ts 入队成功处）；有重试之后改为：入队只把 run 行写成 `QUEUED`，**不**在入队时写 `finished`。一次性任务改为把 `next_fire_time` 置 NULL（`listDue` 的 `<= now` 匹配不到 NULL，排队期间不会再开一档），`finished` 留给 settle 的终态。取消排队仍沿用现有「once 被取消则恢复未完结并重算下一档」。

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
2. FAILED 且 retryable 且 `attempt < 1 + task.retry_max` 且任务 `status='ACTIVE'` 且 `finished=0` → `next_retry_at = now + retry_interval_minutes`，`willRetry=true`；
3. **只有这次触发点不再重试时**才调用 §6.7 的 `recordOutcome`：COMPLETED 清零；FAILED 且 `willRetry=false` 才 +1；中间那些还会重试的 FAILED 不计。CANCELLED 不计。按 attempt 计的话，默认 2 次重试一次档期就加到 3，连败暂停会在第一次触发上误熔断（决策 #5 写的是按触发点计）；
4. `finishRun` 仍不直接改任务行。once 的完结由调用方在「无 pending 重试」时写 `finished`（§6.4）。

排队路径：`settleQueuedExecution(taskId, status)` 无 fire_time，按该任务最老的 `QUEUED` 行匹配（`WHERE task_id=? AND status='QUEUED' ORDER BY id ASC LIMIT 1`）。message_queue 按 sort_order FIFO 消费，首次 settle 对应最早入队的 run；`enqueueHead` 把未落库的行补回队首，不打乱已入队顺序。找不到 QUEUED 行时只保持今天的 `lastExecutionStatus` 回写，不补造 run 行（功能上线前已入队的存量消息）。

once 的 settle 改写现入口径（今天：入队即 finished，FAILED 保持完结，CANCELLED 才恢复）：

| settle 结果 | once 任务 |
|---|---|
| COMPLETED | `finished=1`，`next_fire_time=NULL` |
| FAILED 且还会重试 | 保持 `finished=0`，`next_fire_time` 维持 NULL，交给 `next_retry_at` |
| FAILED 且重试耗尽 | `finished=1`，`next_fire_time=NULL` |
| CANCELLED | 沿用现在的恢复：`finished=0`，按 cron 重算下一档 |

### 6.3 可重试判定汇总

| 失败形态 | 重试 | 理由 |
|---|---|---|
| live/harness 执行期 FAILED（模型故障、超时、临时异常） | ✅ | 提案目标本体 |
| saveMessage / 提交期临时错误 | ✅ | 暂时性 |
| 排队消费终态 FAILED | ✅ | 同上，经同一 `finishRun` |
| 预算 BLOCK | ❌ | 限额语义；同一档期重试是纯烧配额。仍算一次触发点失败，计入连败：连续 3 个档期被预算拦住会暂停。不重试管的是同一档期，暂停管的是跨档期熔断 |
| 会话已删（SESSION_NOT_FOUND） | ❌ | 重试必然再失败；任务同时置 finished 停掉后续档期 |
| 用户取消（CANCELLED） | ❌ | 主动行为 |
| 线程池满（AgentExecutorRejectedError） | ❌ | 提交前同步拒绝，已有 `nextFireTime` 回滚 + 下轮扫描，不双重重试 |

### 6.4 重试调度（P2）

`scanAndExecute` 今天在 `listDue` 为空时直接 `return`（service.ts 扫描函数前部）。重试捞起、小时级安全网都不能放在这个 return 后面，否则没有到期任务时重试永远不跑。结构改成：

```
if (scanning) return
scanning = true
try:
  dueTasks = listDue(now)          -- 空列表也继续
  for task of dueTasks: executeTask(task)   -- 现有 catch 语义见下
  dueRetries = listDueRetries(now) -- JOIN scheduled_task：status='ACTIVE' AND finished=0 AND run.status='FAILED' AND next_retry_at<=now
  for run of dueRetries: retryRun(run)
  maybeReconcileStale()            -- §6.6 小时级安全网，同样不受 due 是否为空影响
finally:
  scanning = false
```

`listDueRetries` 用 JOIN 而不是捞出后再 `selectById` 跳过：任务已删或已暂停时把 `next_retry_at` 留着，每 60 秒都会再扫到，直到 90 天清理。

- `retryRun`：`inFlight` 已有该任务则直接返回，**不清** `next_retry_at`（本轮忙，下轮再试）。未占位才经 `agentExecutor` 提交 `runAttempt(..., isRetry: true)`。池满拒绝发生在回调前，占位 UPDATE 还没执行，`next_retry_at` 自然还在。
- 暂停、删除、或 `updateTask` 把状态写成非 ACTIVE：同一事务里 `UPDATE scheduled_task_run SET next_retry_at=NULL WHERE task_id=? AND next_retry_at IS NOT NULL`，run 保持 FAILED。重新启用**不**把这次重试找回来，下一档按 cron 正常触发。这和锁内发现已暂停的放弃分支同一口径；只跳过扫描、不清 `next_retry_at` 的话，启用瞬间会补打一次用户已经停掉的执行。
- 启用清零只在**状态跃迁**发生时做：库中原 `status !== 'ACTIVE'` 且本次写成 ACTIVE，才把 `consecutive_failures` 置 0。管理端保存会把当前状态一并提交，已启用任务再点保存不得清零。
- once 任务：直跑 `finally` 今天在 `once=1` 时写 `finished=1` 且重算/清空下一档。改为「还有 pending 重试则不写 finished」。同时必须把已经推进出去的 `next_fire_time` 置 NULL——首次 attempt 在开跑前就推进了下一档，只漏掉 `finished` 的话，周期短于重试间隔的 once 任务会在重试到期前再开一档。重试成功或耗尽后再写 `finished=1, next_fire_time=NULL`。循环任务（`once=0`）重试期间下一档照常推进，那是另一个 `fire_time`。
- 扫描器现有 catch（`executeTask` 抛出且不是池满）：回调内部的失败已经自己 `finishRun`，不应再冒到这里。若冒出来时本次 `fire_time` 的 run 行已存在，catch **不得**再算一遍 `next_fire_time`（会把档期多推进一格）；改为 `finishRun(FAILED, retryable)`。run 行还不存在时保持今天的行为：记 `last_execution_status=FAILED` 并推进下一档，不建重试。

### 6.5 错过补偿（P3）

`start()` 必须先 `await compensateMissed(processStartedAt)`，再跑首轮 `scanAndExecute`，然后才 `setInterval`。补偿和 60 秒定时器并行的话，补偿还在改 `next_fire_time`，主循环会按旧档期提交一次。

1. 捞 `status='ACTIVE' AND finished=0 AND next_fire_time < processStartedAt`（等于或晚于进程启动的档期交给主循环，避免把启动耗时期间自然到期的点记成错过）。
2. 逐点推进，但**补跑目标是窗口内最后一点**，落库上限不能把遍历提前截断。`t` 从库里的 `next_fire_time` 解析成上海时区的 `Date` 再交给 croner（不要把 `yyyy-MM-dd HH:mm:ss` 字符串直接丢给 `nextRun`，无时区字符串会被当成本机时区）。`nextRun(t)` 返回该时刻之后的下一点，t 本身是触发点时不会原地打转。
   - 环形缓冲最多留 101 个点（100 条 MISSED + 1 个补跑候选），更早的点丢掉并计数 `truncated`。
   - 单任务最多走 20000 步。还没走到 `now` 就停（秒级 cron 长停机会把启动拖死）：用 `nextRun` 在 `(最后走到的点, now)` 上二分，找出最后一个 `< now` 的触发点作为 latest。二分每步取 `mid`，`next = cron.nextRun(mid)`；`next < now` 则下界提到 `next`，否则上界降到 `mid`。`mid` 恰好落在触发点上时 `nextRun(mid)` 会跳到再下一档，所以还要用 `nextRun(mid - 1s)` 判断 `mid` 自己是不是触发点。
3. 先按策略定 latest，再插 MISSED。顺序反了的话，RUN_ONCE 的补跑点会被写成 MISSED，而 `INSERT IGNORE` 不会把它改回 RUNNING。
4. 策略：
   - **RUN_ONCE**：`latest = 最后一个 < now 的点`。该点**不**插入。其余已保留的点 `INSERT IGNORE` 为 MISSED（已有行不覆盖：崩溃留下的 RUNNING/终态不能被补偿打成错过）。CAS：`UPDATE scheduled_task SET next_fire_time = latest WHERE id=? AND next_fire_time=<原值>`。用户在补偿期间改过档期则不覆盖。主循环看到仍处于过去的 latest 会补跑，`runAttempt` 按 §6.1 接管（无行则插入，已是 MISSED 则改回 RUNNING）。
   - **SKIP**：保留点全部（含 latest）`INSERT IGNORE` 为 MISSED。CAS 把 `next_fire_time` 写成 `cron.nextRun(now)`。同样带 `AND next_fire_time=<原值>`，避免覆盖用户刚改的计划。
   - `truncated>0` 时打一条 warn（taskId、丢掉的点数）。不另造汇总行，避免和真实触发点抢唯一键。
5. once 且 SKIP：在 CAS 成功时追加 `finished=1, finished_at=now, next_fire_time=NULL`。once 且 RUN_ONCE：只把档期拨到 latest，补跑成功后的完结仍走现有 once 收尾。

幂等：`INSERT IGNORE` 不覆盖已有行，CAS 失败说明档期已被另一实例或用户改掉，本实例到此为止。重启时 `next_fire_time` 已是 latest 或未来，不会把已经记过的中间点再插一遍。

### 6.6 孤儿 run 行 reconcile（P3）

崩溃时"已提交未收敛"的执行，run 行停在 RUNNING，而 `next_fire_time` 已在未来——补偿扫描看不到它。`crash-recovery-runner` 续跑会话后今天也不会回写 run 行。另外还有一类更早的孤儿：占位行已插入（`started_at IS NULL`）但回调没跑起来，会话相位仍是 IDLE，按「只收敛终态会话」会永远留着。三级收敛：

1. **crash-recovery 终态钩子（主路径）**：`create-app.ts` 里 `CrashRecoveryRunner` 的 `onExecutionFinished(sessionId, userId, phase)` 回调追加 `reconcileRunsForSession(sessionId, phase)`。回调今天把队列接力放在 `if (phase !== 'FAILED')` 里面；reconcile 必须写在这个 if **外面**，FAILED 同样要收 run 行。按 phase 走 `finishRun`（补耗时/成本）。同一会话若有多行 RUNNING，只收 `started_at` 非空的那一行；对不上就 warn，不要把排队中的另一档一起收掉。
2. **启动 reconcile**：`status IN ('RUNNING','QUEUED')` 且会话已是终态或会话已删 → `finishRun`。会话仍是 RUNNING/RESUMING 的不动（本实例或蓝绿伙伴可能在跑）。另扫 `status='RUNNING' AND started_at IS NULL`：会话即使是 IDLE 也收成可重试 FAILED（档期已经推进，不收就丢这次触发）。这一支只在本实例是承接流量的实例时做（对照 `active-backend-port`，与崩溃恢复的孤儿巡检同一闸门）；本进程 `inFlight` 里的任务跳过。
3. **安全网**（§6.4 的 `maybeReconcileStale`，不依赖 `listDue` 非空）：每小时把 `RUNNING` 且 `started_at` 非空、`updated_at < now-6h`、会话已终态或已删的行收敛。`QUEUED` 且 `updated_at < now-24h` 置 CANCELLED（`error_summary='长时间未消费'`）。`started_at IS NULL` 的占位不进这张小时网——本进程队列里的回调可能还没开始，误收会和即将开跑的 attempt 撞车；那种行只交给进程重启后的启动 reconcile。

### 6.7 连续失败与自动暂停（P3）

store 新增 `recordOutcome(taskId, phase, pauseAfter, now)`，逐行照抄 `openapi.repository.ts:125-157` 的 `FOR UPDATE` 事务读-改-写：

- COMPLETED → `consecutive_failures = 0`；
- FAILED → `+1`，`>= pauseAfter` 时同时 `status='PAUSED'`，返回 `{ paused: true }`；
- CANCELLED / 行已删或已暂停 → 不计不累加，返回 null。

阈值常量 `TASK_PAUSE_AFTER_FAILURES = 3`（service 文件头，对齐 `TRIGGER_DISABLE_AFTER_FAILURES`）。调用点只在 §6.2 说的「这一触发点不再重试」时，一次档期最多 +1。暂停后经 `setFailureNotifier` 发收件箱（§6.8）；通知失败只 warn 不抛出（对齐 webhook 停用通知，停用本身已成功）。恢复清零的跃迁条件见 §6.4，不要在每次 PUT 都清。暂停成功的同时清掉该任务未开始的重试（§6.4）。

### 6.8 通知（P3）

- `shared/contracts/src/inbox.ts` `InboxKind` 增加 `'SCHEDULED_TASK_PAUSED'`；`src/inbox/types.ts` `INBOX_KINDS` 同步；`inbox.service.ts` 新增 `recordScheduledTaskPaused(input)`（照抄 `recordTriggerDisabled` L142-158）：title `定时任务已自动暂停：{name}`，content `连续失败 {n} 次，已自动暂停；请检查模型/Agent 配置后手动启用`，payload `{ taskId, taskName, failures }`，tail `${taskId}:${Date.now()}`（每次暂停都可达），`sessionId` 传任务会话（可跳转）。`isKindEnabled` 增加 case 返回 true（无偏好开关）。
- 单次失败：不新增 kind、不改 `recordTaskTerminal`（决策 #6）。
- 装配：`create-app.ts` 在 `scheduledService` 构造后 `setFailureNotifier({ notifyTaskPaused: (input) => inboxService.recordScheduledTaskPaused(input) })`——`inboxService` 先于 `scheduledService` 构造，无循环依赖；setter 模式对齐既有 `setBudgetCheck`。
- 桌面不改契约枚举就看不见这条通知。`desktop/src/stores/inbox/index.ts` 的 `KNOWN_INBOX_KINDS` 会滤掉未知 kind（漏过 `BUDGET_WARN` 的同一类坑）；`InboxDrawer.vue` 的 `KIND_META` 要加「任务已暂停」。系统通知走 `useInboxSystemNotify.ts` 的 `isInboxKindEnabled`，未知 kind 落到 `default: false`。`TRIGGER_DISABLED` 今天也落在这个 default 上，只进站内、不弹系统通知。自动暂停不要照抄这个缺口：该 case 返回 `true`（仍受「系统通知」总开关约束，不受「任务完成」开关约束）。Web / 安卓没有系统通知，只靠站内未读，与现有收件箱一致。
- 每次 attempt 的 FAILED 仍走现有 `finishExecution` → 一条 `TASK_FAILED`。默认 2 次重试时，一个触发点最多 3 条失败通知，外加达阈值后的 1 条暂停通知。不在 `task-terminal` 里按 attempt 抑制（决策 #6 / §2.3 #7）。

### 6.9 成本/耗时聚合（P1）

轨迹面板的墙钟今天把 `llm_call` 和 `session_activity` 一起送进 `wallClockMs`，空集返回 0；成本只加 `llm_call`，空窗口或任一行未配价为 null（`run-trace.service.ts` 的 totals 组装）。不能抽一个「只收 calls、空集返回 null」的函数再声称轨迹行为不变。

`session/run-window.ts` 拆两个纯函数，轨迹侧原样改调用：

```ts
/** 空窗口或任一行 costMicros == null → null。 */
export function sumCostMicros(calls: LlmCallRow[]): number | null
/** 现 wallClockMs 原样搬出：无 duration 的点不参与，空集返回 0。 */
export function wallClockMs(points: ClockPoint[]): number
```

`finishRun` 只用 `sumCostMicros(本窗口 llm_call)`。耗时用 `wallClockMs`，入参只有这些 llm_call，不读 `session_activity`（schedule 域不再依赖活动表）。因此运行历史的耗时是 LLM 调用墙钟，可能短于轨迹面板（轨迹含工具活动）。窗口没有任何调用时回落 `finished_at - started_at`；起止也没有则为 null。

- 直跑路径：锚点 = 本 attempt 的 `run.message_id`（§6.1，重试后是新的 USER 消息）。窗口 = `[锚点 created_at, 下一条 USER 消息 created_at)`。终态时下一条通常还没有 → 上界 null，`selectBySessionWindow(sessionId, start, null)` 取到本次执行的调用。上界用 `messageRepo.selectUserStamps(sessionId)`，与轨迹相同。
- 排队路径：执行起点不在调度侧，`message_id/started_at/duration_ms/cost_micros` 保持 null，UI 显示「—」。只占「触发时会话正忙」的那部分。以后要精确，再扩展 `onScheduledTaskQueueConsumed` 把锚点消息 id 传回来，本方案不做。

### 6.10 REST API 与工具入参

- `GET /v1/scheduled-tasks/:id/runs?limit=20`（新）：本人或 `scheduled-task:read`；limit 1-50 默认 20；按 `fire_time DESC`；返回 `ScheduledTaskRun[]`。归属校验复用 `getTaskOwnedByUser`。无分页游标（运行历史只关心最近 N 条，对齐 §2.3 #9 的 90 天短保留）。
- `PUT /v1/scheduled-tasks/:id` 请求体扩展：`retryMax`（0-5）、`retryIntervalMinutes`（1-60）、`missedPolicy`（`RUN_ONCE|SKIP`），非法值 `PARAM_INVALID`。`updateTask` 签名追加可选参（现有 7 位置参 + `opts`，再加 `retryOpts` 或收敛为 options 对象，实施时定——倾向第 8 个可选参 `retryOpts?`，改动面最小）。
- Agent 工具：`create_scheduled_task` / `update_scheduled_task` 入参各加 `retry_max`（integer 0-5）、`retry_interval_minutes`（integer 1-60）、`missed_policy`（string enum），`getToolPrompt` 补一段"失败重试与错过补偿"说明（何时建议开启、默认值语义）。
- `GET /v1/scheduled-tasks`（列表）与 `/all`（管理端）响应体随 `ScheduledTask` 接口自动带出新字段，无需改路由。

## 7 前端设计

### 7.1 桌面 `ScheduledTaskPanel.vue` + `useScheduledTasks.ts`

- 任务卡片：meta 行只在偏离默认时展示（`重试 0 次` / `间隔 15 分` / `错过不补` 这类）；三项都是默认则不展示。`status==='PAUSED' && consecutiveFailures>0` 时显示"连续失败 N 次"。
- 卡片底部加"最近运行"折叠区（默认收起）：`fetchRuns(taskId)` 拉 `/scheduled-tasks/:id/runs`。徽标口径同 §2.2。耗时、成本空值显示「—」。`formatCost` 用 `/1e6`，对齐 `RunTracePanel`。点击整行跳转会话（`InboxDrawer` 的 `setActiveSession` + `router.push`）。
- `useScheduledTasks.ts`：新增 `ScheduledTaskRun` 类型、`runs`/`runsLoading` 状态（按 taskId 缓存 Map）、`formatDuration`/`formatCost`；`ScheduledTask` 类型加 `consecutiveFailures/retryMax/retryIntervalMinutes/missedPolicy`。
- 会话已删降级：跳转前 `fetchSession` 失败 → toast 提示（对齐 inbox 条目降级）。

### 7.2 管理后台

- `ScheduledTaskFormDialog.vue`：新增三个表单项——重试次数（`el-input-number` 0-5）、重试间隔（1-60 分钟）、错过补偿（`el-radio-group`：补最近一次 / 只记录不补，附一句说明）。提交带入 PUT body。
- `ScheduledTaskDetailDialog.vue`：`el-descriptions` 下方加"运行历史"区（表格：触发时间/状态/attempt/耗时/成本/错误摘要），调 runs 端点；descriptions 区补"连续失败次数"项。runs 请求失败或返回空数组时，原有描述区照常展示——`tests/admin-scheduled-tasks.spec.ts` 的 mock 对未知路径返回 `[]`，详情用例不能被新请求拖垮。
- `types.ts` 同步加字段。

### 7.4 CLI（mao-cli）

AGENTS.md 要求用户可见的行为同步 `skills/mao-cli/`。本需求改了更新入参和运行历史，CLI 不能只改桌面：

- `skills/mao-cli/lib/commands/scheduled-task.js` 的 `update` 增加可选 `--retry-max`、`--retry-interval-minutes`、`--missed-policy`，写入现有 PUT body。
- 新增 `scheduled-task runs --id <id> [--limit]`，对应 `GET /scheduled-tasks/:id/runs`。
- `skills/mao-cli/reference/scheduled-task.md` 与 `reference/admin.md` 的定时任务小节补上这三个配置、运行历史和自动暂停的含义。创建入口仍是 Agent 工具，CLI 不新增 create。

### 7.3 展示层同步（AGENTS.md 规范）

工具入参扩展不新增/重命名工具，不触发 `tool-result-summarizer.ts` / `toolDisplay.ts` 改动；但工具 schema 与 `getToolPrompt` 变更需补/改 `scheduled-task-tools` 相关 spec。

## 8 分阶段实施

| 阶段 | 内容 | 涉及文件 | 规模 |
|---|---|---|---|
| P1 | V142 run 表 + 占位行/`runAttempt` 接管 + `finishRun`（不写重试）+ `sumCostMicros`/`wallClockMs` 抽取 + runs API + 桌面展开列表 + admin 详情区 + 90 天清理 | `scheduled-task.service.ts`、`scheduled-task.store.ts`、`scheduled-task.routes.ts`、`session/run-window.ts`（新）、`run-trace.service.ts`、`schedule/run-cleanup.ts`（新，对齐 `inbox.cleanup.ts`，在 `create-app.ts` 里 `inboxCleanupScheduler` 旁边 start）、desktop/admin、`V142__scheduled_task_run.sql` | 中 |
| P2 | V143 任务列 + 重试配置（工具/admin/API/mao-cli）+ `retryRun` + 扫描捞起（含 listDue 为空）+ 可重试判定 + once×重试交互 | 上述 service/store/routes/tools/admin form + `skills/mao-cli/` + `V143__scheduled_task_reliability_columns.sql` | 中 |
| P3 | 启动补偿扫描 + MISSED 行 + reconcile 三级收敛 + `recordOutcome` 连败 + 自动暂停 + `SCHEDULED_TASK_PAUSED` 通知 | service/store/contracts/inbox/create-app + 桌面收件箱白名单与系统通知 + 卡片展示 + mao-cli | 中 |

每阶段独立发版、独立回滚；P1 落地后运行历史即生效（attempt 恒 1、无 next_retry_at 写入）。

## 9 测试要点

**P1**

- run 行生命周期：正常触发建行→终态回写；busy 入队建 QUEUED 行→消费 settle 按 FIFO 收敛最老 QUEUED 行；会话删（sessionGone）收敛 FAILED。
- 幂等：同一 `fire_time` 并发/重启只一行；已有 RUNNING/终态时补偿的 `INSERT IGNORE` 不覆盖。MISSED 行被补跑接管后变为 RUNNING，而不是停在 MISSED。
- 占位：`next_fire_time` 已推进且 `started_at IS NULL` 的行，在承接流量实例启动时收成可重试 FAILED；本进程 `inFlight` 中的占位不被 60 秒网收掉。池满拒绝会删掉占位并把档期滚回 due。
- 历史一致性：直跑路径耗时/成本与该窗口 `llm_call` 实算一致；未配价时 `cost_micros` 为 null；无调用时耗时回落起止差。抽取后 run-trace 既有 spec 全绿（墙钟仍含活动、空集仍为 0，成本空窗口仍为 null）。
- 90 天清理：过期行删、临界行留。`created_at` 索引被这条 DELETE 用到。

**P2**

- 可重试失败按策略重提且 attempt 递增、`message_id` 换成新锚点、`next_retry_at` 到期被扫描捞起。`listDue` 为空的那一轮也要捞重试。池满拒绝保留 `next_retry_at`。`inFlight` 占用时不清 `next_retry_at`。
- 达 `retry_max` 后不再重提。预算 BLOCK、会话已删、CANCELLED 不重试。预算 BLOCK 仍然给连败 +1。
- 中间失败的 attempt 不增加 `consecutive_failures`；同一 `fire_time` 最终失败只 +1。重试成功的成本窗口不含上一 attempt。
- 重试不推进 `next_fire_time`、不累加 `fire_count`（含 busy 入队那条提前计数）。once 在 pending 重试期间 `finished=0` 且 `next_fire_time` 为 NULL，耗尽或成功后才完结。周期短于重试间隔时不得再开一档。
- 入队的 once 任务在 settle 之前不是 finished。settle FAILED 且还会重试时保持未完结；CANCELLED 仍恢复下一档。
- 暂停/删除清掉未开始的 `next_retry_at`。已是 ACTIVE 的任务再次保存不清零连败。状态从 PAUSED 写成 ACTIVE 才清零。
- 扫描器 catch 在 run 行已存在时不再推进档期。

**P3**

- 停机跨多个触发点：RUN_ONCE 补的是最后一点，更早的点记 MISSED；不是「第 100 个旧点」。SKIP 全部记 MISSED 且档期进入未来。once×SKIP 完结。超过 100 个点时只留最近的，更早的计数进日志。走满 20000 步后二分得到的 latest 仍是 `< now` 的最后一点。
- 补偿与首轮扫描串行：`setInterval` 在补偿完成之前不会把旧档期再提交一次。重启重入 / 双实例：不产生第二行，CAS 不覆盖用户改期。字符串档期按上海时区解析，不偏移 8 小时。
- reconcile：崩溃恢复回调在 FAILED 时也收 run 行，且不写进 `phase !== 'FAILED'` 的队列接力分支。启动 reconcile 收终态/已删会话，也收 `started_at IS NULL` 的占位（仅承接流量实例）。会话仍 RUNNING/RESUMING 的不动。
- 连败：最终 FAILED +1 / COMPLETED 清零 / CANCELLED 不计 / 一次触发点的多次 attempt 只计 1 次。达 3 次 PAUSED，并清掉未开始的重试。手动从暂停启用后清零，且不会补打暂停前那次重试。
- 通知：自动暂停进收件箱且桌面白名单放行；系统通知在总开关打开时弹出，不受「任务完成」开关影响。同一任务多次暂停各有一条（tail 含时间戳）。每个失败 attempt 各一条现有 `TASK_FAILED`。
- 矩阵：停机 × 失败 × 超周期 × once × busy 排队 × 重试间隔长于 cron 周期。

## 10 风险与排期注意

- **收敛点相邻**：P2/P3 在 `finishRun` 只读终态、不重写 `task-terminal.service.ts` 的 `finishExecution`；与在途同类改动（记忆/收件箱/预算都动过该文件）错开实施。
- **补偿 × 重试叠加**：停机期间无提交即无重试欠账，复工先补偿后重试，两条路径经 attempt 与状态机分离；矩阵测试覆盖（§9）。
- **蓝绿双实例**：补偿扫描幂等 + CAS，与既有 `listDue` 双扫同边界；reconcile 只对"会话已终态/已删"的行动手，不碰活跃会话，零误伤伙伴实例在途执行。
- **窗口归因误差**：直跑路径按本 attempt 的锚点取窗口。崩溃延迟收敛的行可能把后续执行的调用算进来（占比小）。排队路径无成本/耗时（§6.9）。运行历史墙钟不含工具活动，和轨迹面板不是同一个数。
- **通知条数**：一个触发点的每次失败 attempt 各一条现有 `TASK_FAILED`（默认最多 3 条），自动暂停另加 1 条 `SCHEDULED_TASK_PAUSED`。不新增失败 kind，也不在终态服务里合并重试通知。
- **启动补偿耗时**：20000 步是单任务上限。秒级 cron 停机很久时，二分只保证 latest 正确，中间点允许被截断计数，不要求逐条落库。
- **迁移编号**：V142/V143 为拟定号，实施时按实际空闲号顺延（第五批提案 README 已提示冲突）。
- **死列窗口**：若 P1 先发版，`next_retry_at` 等 P2 列暂不写入（恒 NULL），无行为影响——与收件箱 P1/P2 同批落地避免死列的经验（task-inbox 实施偏差①）相反，此处选择接受一个版本的死列换取分期清晰；如介意可 V142 一次建全。
