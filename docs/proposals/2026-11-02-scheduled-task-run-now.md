# 提案：定时任务「立即执行」—— 改完提示词当场试跑，不必改 Cron 等扫描器

> 今天定时任务面板有一件很拧巴的事：用户已经能点「编辑」打开带 Cron 实时预览的完整表单改任务（0.0.354），但编辑完提示词想马上验一下能不能跑通，面板里却没有像信号哨兵「立即测试探针」那样的**立即执行**按钮——唯一的办法是把 Cron 改成一分钟后等扫描器捞，测完再改回去，既繁琐，又容易忘改回来或误把一次性任务跑成已完结。

- 状态：已立项（技术方案见 [docs/plan/2026-11-03-scheduled-task-run-now-technical-design.md](../plan/2026-11-03-scheduled-task-run-now-technical-design.md)；2026-11-02 范围收窄已定案，§8 决策 1 采纳「允许」）
- 日期：2026-11-02
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（约 1 人日；**零迁移**）
- 关联：`backend-ts/src/schedule/scheduled-task.routes.ts`、`backend-ts/src/schedule/scheduled-task.service.ts`、`desktop/src/components/ScheduledTaskPanel.vue`、`skills/mao-cli/`

## 1. 背景与现状

### 1.1 已有积木全在，唯独缺「试跑」一个插座（代码可查）

| 能力 | 现状 | 代码证据 |
|---|---|---|
| 服务层执行任务 | ✅ `ScheduledTaskService.executeTask` 含在飞守卫、会话锁、结果投递、运行记录写入一应俱全 | `scheduled-task.service.ts:514` |
| REST 触发端点 | ❌ `scheduled-task.routes.ts` 只有 `GET / PUT / DELETE` 与 `cron-preview`，**没有 `POST /v1/scheduled-tasks/:id/run`** | `scheduled-task.routes.ts:24-134` |
| 触发调用方 | ❌ `executeTask` 仅由 `ScheduledTaskScheduler.scanAndExecute` 周期扫描与重试入口调用，没有任何手动入口 | `scheduled-task.service.ts:1426, 1437, 1463` |
| 桌面端编辑弹窗 | ✅ `ScheduledTaskEditDialog.vue` 已具备名称、Cron 实时预览（未来 3 次触发时间 + 一次性自动识别）、重试策略、提示词完整表单 | `ScheduledTaskEditDialog.vue:1-101` |
| 桌面端面板行内操作 | ❌ 只有编辑 / 删除，无「立即执行」 | `ScheduledTaskPanel.vue:94-99` |
| 对照：信号哨兵 | ✅ 设置页右上角「新建哨兵」+ 行内「立即测试探针」+ `mao signal-watcher create/test` 全齐 | `SignalWatchersView.vue:21, 36` |

### 1.2 真实痛点

1. **改完提示词没法当场验**：「定时任务」的 prompt 要求自包含（不能带「每天」等调度词）。用户在 `ScheduledTaskEditDialog` 里改完 prompt，想确认 Agent 能不能按这段 prompt 跑出预期结果，今天唯一的办法是把 Cron 改成 1 分钟后、等调度器扫到、跑完再把 Cron 改回 `0 0 9 * * ?`——既繁琐，又容易忘改回来或误把一次性任务跑成已完结。
2. **CLI 缺口**：`mao-cli` 已在 0.0.370 补齐了 `signal-watcher` 的完整 CRUD 与 `test`，而 `scheduled-task` 至今因为缺少 `:id/run` 端点，无法在命令行手动触发一次定时任务。

## 2. 目标 / 非目标

**目标**

1. **手动立即执行（试跑）**：新增 `POST /v1/scheduled-tasks/:id/run`（属主或 `scheduled-task:write` 管理员可调）；桌面端定时任务面板行内增加「立即执行」按钮（popconfirm 二次确认：「立即在绑定会话中执行一次？不会改变原有的下次触发计划」）。**核心不变量：手动触发不改写计划档期（`nextFireTime` 不变）、不把一次性任务标为已完结（`finished` 不变）、不计入连续失败自动暂停阈值**，但照常写入一条 `scheduled_task_run` 运行记录并走同一套会话锁与结果投递（飞书 / 微信 / 收件箱），跑完可在「最近运行」里直接点进会话看效果。
2. **`mao-cli` 对齐**：补齐 `mao scheduled-task run --id <id>` 子命令，与 `signal-watcher test` 体验拉齐。

**非目标**

- **不做手动新建定时任务**（2026-11-02 范围收窄定案）：创建维持现状——对话里让 Agent 调 `create_scheduled_task`，面板空态引导文案（「试试对 Agent 说：每天早上9点帮我检查新股」）保留。不新增 `POST /v1/scheduled-tasks`、不加面板「新建」按钮、不把 `ScheduledTaskEditDialog` 改双模。
- **管理后台不加「立即执行」按钮**（本次范围不含 admin）：端点按属主 / `scheduled-task:write` 权限门设计，后续若要向管理后台开放，只需在既有列表 / 详情上加按钮调同一端点。
- 不做「任务模板 / Runbook」（2026-10-19 已否决）——本提案连标准 REST 创建端点都不新增，更不沉淀任何模板资产。
- 不改动 `ScheduledTaskScheduler` 的周期扫描、错过补偿（`compensateMissed`）、启动收敛（`reconcileOnStartup`）与自动重试状态机——`executeTask` 现有的周期触发路径逐字节保持原样。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 任务模板 / Runbook（2026-10-19 否决） | 不引入模板表、参数占位符或跨任务复用；本提案只暴露「执行」入口，连 `POST /v1/scheduled-tasks` 创建端点都不新增。 |
| 信号哨兵对话内配置（2026-10-25 否决） | 方向相反：不是往 LLM `tools` 数组里塞新工具（定时任务工具早就有了），而是补齐 GUI / REST 侧缺失的试跑入口，零 prompt 膨胀。 |
| 批量任务（2026-10-24 否决） | 单任务单次触发，无并发扇出。 |

## 4. 方案设计

### 4.1 手动立即执行（`POST /v1/scheduled-tasks/:id/run`）

- **权限门**：复用 `scheduled-task.routes.ts` 既有的属主校验 + `WRITE_PERMISSION`（`scheduled-task:write`）管理员旁路。
- **并发与在飞守卫**：
  - 复用 `this.inFlight` 集合（`scheduled-task.service.ts:314`）：若该任务当前已有周期触发或上一次手动触发在跑，直接返回业务错误「该定时任务正在执行中，请稍后再试」（409 / `PARAM_INVALID`），不叠加排队。
  - 若目标会话当前正忙（用户在里面聊天），与周期触发一致走 `messageQueueService.enqueue` 排队，或直跑——完全复用 `withSessionLock(task.sessionId, ...)`（`scheduled-task.service.ts:283`）。
- **与周期调度的解耦（零回归的关键）**：
  - 新增窄入口 `runNow(taskId, userId, { allowNonOwner })`（或在 `executeTask` 增加 `ctx.manual === true` 分支）：
    1. **不推进 `nextFireTime`**：跳过开跑前的 `calculateNextFireTime` 与 `restoreNextFireIfUnchanged`；暂停中（`PAUSED`）或已完结（`finished = 1`）的任务也允许手动点「立即执行」试跑，跑完仍保持原 `PAUSED` / `finished` 状态。
    2. **不触发失败重试与连续失败停用**：手动试跑的 `finishRun` 固定 `retryable: false`，且不调 `recordTaskOutcome`（避免用户调试 prompt 报错 3 次把原本正常的启用任务给自动暂停了）。
    3. **运行记录照记**：`fireTime` 取当前时间 `formatDateTime(new Date())`（`attempt = 1`），照常写入 `scheduled_task_run`、回写 `lastFireTime / lastExecutionStatus / fireCount + 1`，前端「最近运行」列表无需改任何字段即可展示并点击跳会话。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | `scheduled-task.routes.ts` 新增 `POST /v1/scheduled-tasks/:id/run`；`scheduled-task.service.ts` 新增 `runNow`（不碰 `nextFireTime` / `finished` / `consecutiveFailures`，周期调度路径逐字节不变） |
| desktop | `ScheduledTaskPanel.vue` 行内「立即执行」按钮（popconfirm 二次确认，编辑旁） |
| admin | **无改动**（本次不加「立即执行」按钮） |
| skills/mao-cli | `mao scheduled-task` 补 `run` 子命令及手册说明（`reference/scheduled-task.md`） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 手动触发与刚好到点的 Cron 周期扫描撞车（同一秒 `fire_time` 冲突或并发执行） | 入口共用 `this.inFlight` 集合 + `withSessionLock` 会话串行锁；`claimRun` 遇 `(task_id, fire_time)` 唯一键冲突时对手动触发做秒级偏移或直接复用 |
| 手动试跑一次性任务，跑完误把 `finished` 置 1 导致真正到点时不跑了 | `runNow` 分支在 finally 中显式跳过 `once` 完结状态改写与 `nextFireTime` 重算，单测专门锁死「一次性任务手动试跑后 `finished === 0` 且 `nextFireTime` 不变」 |

## 7. 测试要点

1. `POST /v1/scheduled-tasks/:id/run`：
   - 正常循环任务手动执行后，`nextFireTime` 与执行前逐字符一致，`fireCount + 1`，`scheduled_task_run` 多一条记录；
   - 一次性任务（`once = 1`）手动执行后，`finished` 仍为 `0`、`nextFireTime` 不变；
   - `PAUSED` 任务手动执行后，仍为 `PAUSED`；
   - 手动执行失败不触发自动重试，也不累加 `consecutiveFailures`；
   - 任务已在 `inFlight` 中时重复点击返回明确错误；
   - 他人任务在无 `scheduled-task:write` 权限时拒绝。
2. 前端：点击「立即执行」后展开「最近运行」可见新记录并可跳回会话。
3. `mao-cli`：`mao scheduled-task run --id <id>` 正常返回、无权限 / 任务不存在 / 在飞中均有明确错误文案。

## 8. 待确认决策

1. 手动「立即执行」是否允许对处于 `PAUSED` 或 `finished = 1`（已完结）的任务调用？（建议**允许**：试跑调试 prompt 正是启用前的高频动作，且跑完不改变 `PAUSED` / `finished` 状态）。

> **范围收窄记录（2026-11-02 定案）**：本提案只做「手动触发执行」——不做手动新建定时任务（创建入口维持对话让 Agent 调 `create_scheduled_task`），管理后台也不加「立即执行」按钮。原「新建向导」部分（`POST /v1/scheduled-tasks`、`ScheduledTaskEditDialog` 双模、`mao scheduled-task create`）整体移出本提案，如后续要做另行提案。
