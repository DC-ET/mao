# 提案：定时任务不再靠「对着对话框背 Cron」创建 —— 立即执行与新建向导补完

> 今天定时任务面板有一件很拧巴的事：用户已经能点「编辑」打开带 Cron 实时预览的完整表单改任务（0.0.354），但面板右上角**没有「新建」按钮**，空态还写着「试试对 Agent 说：每天早上 9 点帮我检查新股」——想建一个定时任务，必须先去切一个会话、烧一轮 LLM 让 Agent 调 `create_scheduled_task`；而且编辑完提示词想马上验一下能不能跑通，面板里也没有像信号哨兵「立即测试探针」那样的**立即执行**按钮，只能把 Cron 改成一分钟后等扫描器捞，测完再改回去。

- 状态：提案（待评审）
- 日期：2026-11-02
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（P1 立即执行 + P2 面板直接新建，合计约 2~3 人日；**零迁移**）
- 关联：`backend-ts/src/schedule/scheduled-task.routes.ts`、`backend-ts/src/schedule/scheduled-task.service.ts`、`desktop/src/components/ScheduledTaskPanel.vue`、`desktop/src/components/ScheduledTaskEditDialog.vue`、`admin/src/views/scheduled-tasks/index.vue`、`skills/mao-cli/`

## 1. 背景与现状

### 1.1 已有积木全在，唯独缺了「新建」与「试跑」两个插座（代码可查）

| 能力 | 现状 | 代码证据 |
|---|---|---|
| 服务层创建任务 | ✅ `ScheduledTaskService.createTask(userId, agentId, sessionId, ...)` 校验、计算 `nextFireTime`、落库一应俱全 | `scheduled-task.service.ts:381-404` |
| REST 创建端点 | ❌ `scheduled-task.routes.ts` 只有 `GET / PUT / DELETE` 与 `cron-preview`，**没有 `POST /v1/scheduled-tasks`** | `scheduled-task.routes.ts:24-135` |
| 桌面端编辑弹窗 | ✅ `ScheduledTaskEditDialog.vue` 已具备名称、Cron 实时预览（未来 3 次触发时间 + 一次性自动识别）、重试策略、提示词完整表单 | `ScheduledTaskEditDialog.vue:1-101` |
| 桌面端新建入口 | ❌ 面板头部只有 `<h3>定时任务</h3>`，无新建按钮；空态引导用户去跟 Agent 说话创建 | `ScheduledTaskPanel.vue:3-17` |
| 手动立即触发一次 | ❌ 无端点、无按钮；`executeTask` 仅由 `ScheduledTaskScheduler` 周期扫描调用 | `scheduled-task.service.ts:514, 1426` |
| 对照：信号哨兵 | ✅ 设置页右上角「新建哨兵」+ 行内「立即测试探针」+ `mao signal-watcher create/test` 全齐 | `SignalWatchersView.vue:20, 36` |

### 1.2 真实痛点

1. **改完提示词没法当场验**：「定时任务」的 prompt 要求自包含（不能带「每天」等调度词）。用户在 `ScheduledTaskEditDialog` 里改完 prompt 或刚建好任务，想确认 Agent 能不能按这段 prompt 跑出预期结果，今天唯一的办法是把 Cron 改成 1 分钟后、等调度器扫到、跑完再把 Cron 改回 `0 0 9 * * ?`——既繁琐，又容易忘改回来或误把一次性任务跑成已完结。
2. **创建入口不对称**：同一套设置页里，信号哨兵、Webhook 触发器、环境变量、MCP 服务器全部是「右上角新建按鈕 + 表单弹窗」，唯独定时任务只能靠对话让 Agent 调工具创建（或者先随便对 Agent 说一句建出来再去面板里改）。しかも Webhook 触发器弹窗里早已有「选 Agent + 搜索绑定会话（或自动新建）」的现成交互（`OpenApiView.vue:216-235`）。
3. **CLI 缺口**：`mao-cli` 已在 0.0.370 补齐了 `signal-watcher` 的完整 CRUD 与 `test`，而 `scheduled-task` 至今因为缺少 `POST /v1/scheduled-tasks` 与 `run-now` 端点，无法在命令行直接创建或手动触发定时任务。

## 2. 目标 / 非目标

**目标**

1. **P1 手动立即执行（试跑）**：新增 `POST /v1/scheduled-tasks/:id/run`（属主或 `scheduled-task:write` 管理员可调）；桌面端定时任务行内、管理后台定时任务列表/详情增加「立即执行」按钮。**核心不变量：手动触发不改写计划档期（`nextFireTime` 不变）、不把一次性任务标为已完结（`finished` 不变）、不计入连续失败自动暂停阈值**，但照常写入一条 `scheduled_task_run` 运行记录并走同一套会话锁与结果投递（飞书 / 微信 / 收件箱），跑完可在「最近运行」里直接点进会话看效果。
2. **P2 桌面端与 CLI 直接新建**：新增 `POST /v1/scheduled-tasks`；复用 `ScheduledTaskEditDialog.vue` 升级为「新建 / 编辑」双模弹窗（新建态增加「目标 Agent」与「绑定会话：每次在新建的专属会话中运行（推荐） / 选择已有 CLOUD 主会话」）；面板右上角补「新建定时任务」按钮。
3. **P2 `mao-cli` 对齐**：同步补齐 `mao scheduled-task create / run` 子命令，与 `signal-watcher` 体验拉齐。

**非目标**

- 不做「任务模板 / Runbook」（2026-10-19 已否决）——新建就是单条定时任务配置，不沉淀任何模板资产。
- 不改动 `ScheduledTaskScheduler` 的周期扫描、错过补偿（`compensateMissed`）、启动收敛（`reconcileOnStartup`）与自动重试状态机——`executeTask` 现有的周期触发路径逐字节保持原样。
- 不支持绑定 LOCAL 会话、子代理会话或边路任务会话（与 Webhook 触发器 `assertBindableSession` 口径严格一致：无人值守任务只能在 CLOUD 主会话上跑）。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 任务模板 / Runbook（2026-10-19 否决） | 不引入模板表、参数占位符或跨任务复用；只是把 `ScheduledTaskService.createTask` 已有的能力暴露成标准 REST `POST` 与新建弹窗。 |
| 信号哨兵对话内配置（2026-10-25 否决） | 方向相反：不是往 LLM `tools` 数组里塞新工具（定时任务工具早就有了），而是补齐 GUI / REST 侧缺失的创建与试跑入口，零 prompt 膨胀。 |
| 批量任务（2026-10-24 否决） | 单任务单次触发，无并发扇出。 |

## 4. 方案设计

### 4.1 P1：手动立即执行（`POST /v1/scheduled-tasks/:id/run`）

- **权限门**：复用 `scheduled-task.routes.ts` 既有的属主校验 + `WRITE_PERMISSION`（`scheduled-task:write`）管理员旁路。
- **并发与在飞守卫**：
  - 复用 `this.inFlight.has(taskId)`：若该任务当前已有周期触发或上一次手动触发在跑，直接返回业务错误「该定时任务正在执行中，请稍后再试」（409 / `PARAM_INVALID`），不叠加排队。
  - 若目标会话当前正忙（用户在里面聊天），与周期触发一致走 `messageQueueService.enqueue` 排队，或直跑——完全复用 `withSessionLock(task.sessionId, ...)`。
- **与周期调度的解耦（零回归的关键）**：
  - 新增窄入口 `runNow(taskId, userId, { allowNonOwner })`（或在 `executeTask` 增加 `ctx.manual === true` 分支）：
    1. **不推进 `nextFireTime`**：跳过开跑前的 `calculateNextFireTime` 与 `restoreNextFireIfUnchanged`；暂停中（`PAUSED`）或已完结（`finished = 1`）的任务也允许手动点「立即执行」试跑，跑完仍保持原 `PAUSED` / `finished` 状态。
    2. **不触发失败重试与连续失败停用**：手动试跑的 `finishRun` 固定 `retryable: false`，且不调 `recordTaskOutcome`（避免用户调试 prompt 报错 3 次把原本正常的启用任务给自动暂停了）。
    3. **运行记录照记**：`fireTime` 取当前时间 `formatDateTime(new Date())`（`attempt = 1`），照常写入 `scheduled_task_run`、回写 `lastFireTime / lastExecutionStatus / fireCount + 1`，前端「最近运行」列表无需改任何字段即可展示并点击跳会话。

### 4.2 P2：直接新建定时任务（`POST /v1/scheduled-tasks`）

- **后端端点**：
  - 请求体：`{ name, agentId, sessionId?: number | null, prompt, cronExpression, once?: boolean, retryMax?: number, retryIntervalMinutes?: number, missedPolicy?: 'RUN_ONCE' | 'SKIP' }`。
  - 会话绑定规则（对齐 `WebhookTriggerService.assertBindableSession`）：
    - 传了 `sessionId`：校验会话存在、归属当前用户、`sessionType === 'NORMAL'`、`executionMode === 'CLOUD'`、且 `session.agentId === agentId`；
    - 未传 `sessionId`（默认推荐）：自动調 `sessionService.createSession(userId, agentId, name, 'CLOUD', ...)` 创建一个专属 CLOUD 主会话绑定上去，避免定时任务输出污染用户正在日常聊天的会话。
  - 随后直接调用既有的 `scheduledTaskService.createTask(...)`，零新表、零新字段。
- **前端 `ScheduledTaskPanel.vue` + `ScheduledTaskEditDialog.vue`**：
  - 面板标题栏右侧加「新建任务」按钮；每行操作区（编辑旁）加「立即执行」按钮（二次确认 popconfirm：「立即在绑定会话中执行一次？不会改变原有的下次触发计划」）。
  - `ScheduledTaskEditDialog` 支持 `task === null` 的新建模式：顶部多出「Agent 选择」与「执行会话（自动新建专属会话 / 选择已有会话）」两项，其余 Cron 预览、一次性开关、高级设置、提示词表单 100% 复用现有代码。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | `scheduled-task.routes.ts` 新增 `POST /v1/scheduled-tasks` 与 `POST /v1/scheduled-tasks/:id/run`；`scheduled-task.service.ts` 新增 `createFromApi`（含会话校验/自建）与 `runNow`（不碰 `nextFireTime` / `finished` / `consecutiveFailures`） |
| desktop | `ScheduledTaskPanel.vue` 新增「新建任务」与行内「立即执行」按钮；`ScheduledTaskEditDialog.vue` 兼容新建态（Agent + 会话选择） |
| admin | `scheduled-tasks/index.vue` 与详情弹窗补「立即执行」按钮（复用同一端点） |
| skills/mao-cli | `mao scheduled-task` 补 `create` 与 `run` 子命令及手册说明 |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 手动触发与刚好到点的 Cron 周期扫描撞车（同一秒 `fire_time` 冲突或并发执行） | 入口共用 `this.inFlight` 集合 + `withSessionLock` 会话串行锁；`claimRun` 遇 `(task_id, fire_time)` 唯一键冲突时对手动触发做秒级偏移或直接复用 |
| 手动试跑一次性任务，跑完误把 `finished` 置 1 导致真正到点时不跑了 | `runNow` 分支在 finally 中显式跳过 `once` 完结状态改写与 `nextFireTime` 重算，单测专门锁死「一次性任务手动试跑后 `finished === 0` 且 `nextFireTime` 不变」 |
| 用户选了 LOCAL 会话或他人会话绑定定时任务 | 服务端强校验 `userId`、`executionMode === 'CLOUD'`、`sessionType === 'NORMAL'`，非法直接 400 拒绝 |

## 7. 测试要点

1. `POST /v1/scheduled-tasks`：不传 `sessionId` 自动创建 CLOUD 主会话并绑定；传入本人合法 CLOUD 会话绑定成功；传入他人会话 / LOCAL 会话 / 边路会话 / 停用 Agent 均拒绝。
2. `POST /v1/scheduled-tasks/:id/run`：
   - 正常循环任务手动执行后，`nextFireTime` 与执行前逐字符一致，`fireCount + 1`，`scheduled_task_run` 多一条记录；
   - 一次性任务（`once = 1`）手动执行后，`finished` 仍为 `0`、`nextFireTime` 不变；
   - `PAUSED` 任务手动执行后，仍为 `PAUSED`；
   - 手动执行失败不触发自动重试，也不累加 `consecutiveFailures`；
   - 任务已在 `inFlight` 中时重复点击返回明确错误。
3. 前端：新建态与编辑态切换不残留旧表单状态；点击「立即执行」后展开「最近运行」可见新记录并可跳回会话。

## 8. 待确认决策

1. 手动「立即执行」是否允许对处于 `PAUSED` 或 `finished = 1`（已完结）的任务调用？（建议**允许**：试跑调试 prompt 正是启用前的高频动作，且跑完不改变 `PAUSED` / `finished` 状态）。
2. 新建定时任务时，「执行会话」默认选项是「自动新建同名专属会话」（推荐，零前置步骤）还是「必须手选一个已有会话」？
3. 管理后台 `scheduled-tasks/index.vue` 是否同步加上「立即执行」按钮（仅需调同一接口，约 0.5 人日）？
