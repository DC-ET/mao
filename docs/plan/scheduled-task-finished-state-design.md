# 定时任务「已执行完结」状态区分方案

> 状态：已确认（2026-08-03）
> 关联代码：`backend/src/main/java/cn/etarch/mao/schedule/`、`desktop/src/components/ScheduledTaskPanel.vue`、`desktop/src/composables/useScheduledTasks.ts`、`admin/src/views/scheduled-tasks/index.vue`

## 1. 需求背景

客户端（桌面端）设置页的「定时任务」列表把**所有**任务混在同一张列表中展示。其中一部分是用户通过对话让 Agent 创建的一次性任务（如"明天上午 10 点提醒我"），这类任务的 cron 表达式只在未来某个时刻匹配一次。

现状问题是：一次性任务**执行完毕后仍然以 ACTIVE（绿色圆点"启用中"）状态留在列表中**，且「下次执行时间」为空、无任何"已完结"标识。用户无法区分它和以下两类任务：

- 日常重复任务（如"每天早上 9 点检查新股"，会持续周期性执行）；
- 尚未到触发时间的一次性任务（未执行）。

这导致列表信息误导性强、维护成本高，需要把"已执行完结"的任务从正常任务中明确区分出来。

## 2. 需求描述

### 2.1 目标

在客户端设置页与管理后台的定时任务列表中，将任务分为「进行中」与「已完结」两类清晰呈现；已完结任务不再混入正常任务，并对其禁用无意义的启停操作。

### 2.2 术语定义

| 术语 | 定义 |
|------|------|
| 已完结（finished） | 任务 cron 已无下次匹配（一次性任务执行完毕），不会再被调度器触发 |
| 进行中 | 尚未完结的所有任务，含日常重复任务、未到触发时间的一次性任务、暂停的任务 |
| QUEUED | 任务触发时会话繁忙，消息已进入队列等待执行，尚未真正执行完 |

### 2.3 要做的

1. 数据库为 `scheduled_task` 表新增 `finished`（是否完结）与 `finished_at`（完结时间）两列。
2. 后端在任务执行到终态（COMPLETED/FAILED）后，检测 cron 是否还有下次匹配，无匹配则置为已完结。
3. 后端在修改 cron 表达式且新表达式仍有下次匹配时，自动将任务复位为进行中。
4. 迁移脚本处理存量数据：已执行完的一次性任务升级后直接置为已完结。
5. 桌面端设置页用 Tabs 分组展示「进行中 / 已完结」，默认展示进行中。
6. 管理后台定时任务表格增加「完结」状态列；已完结任务禁用启停开关。
7. 已完结任务仅保留删除操作。

### 2.4 不做的

1. 不新增"重新激活"按钮（对一次性任务无意义：cron 已无匹配，重新启用也不会触发）。
2. 不新增编辑 cron 的 UI（桌面端与管理后台当前均无编辑入口，本次不补）。
3. 不对已完结任务做自动删除或批量清理。
4. 不改变调度器 `ScheduledTaskScheduler` 的扫描机制（仍以 `status=ACTIVE` + `next_fire_time <= now` 判定触发）。
5. 不修改 `create_scheduled_task` / `update_scheduled_task` / `delete_scheduled_task` / `list_scheduled_tasks` 四个 Agent 工具的入参出参协议（`finished` 字段随实体序列化自然带上，无需改动工具代码）。
6. 不在管理后台增加"完结"筛选下拉（`/all` 为后端分页，本地过滤不完整，需后端支持查询参数，本次不做，后续按需补）。

## 3. 现状与根因分析

### 3.1 相关代码

| 位置 | 职责 |
|------|------|
| `backend/.../schedule/entity/ScheduledTask.java` | 实体，`status`(ACTIVE/PAUSED)、`last_execution_status`(COMPLETED/FAILED/SKIPPED/QUEUED)、`next_fire_time`、`fire_count` |
| `backend/.../schedule/scheduler/ScheduledTaskScheduler.java` | 每 60s 扫描 `ACTIVE` 且 `next_fire_time <= now` 的任务 |
| `backend/.../schedule/service/ScheduledTaskService.java` | `executeTask` 执行前预重算 `next_fire_time`；`updateTask` 修改 cron/状态 |
| `backend/.../schedule/controller/ScheduledTaskController.java` | REST：`GET /v1/scheduled-tasks`（用户列表）、`/all`（后台分页）、`PUT /{id}`、`DELETE /{id}` |
| `desktop/src/composables/useScheduledTasks.ts` | 桌面端数据层 |
| `desktop/src/components/ScheduledTaskPanel.vue` | 桌面端设置页列表 UI |
| `admin/src/views/scheduled-tasks/index.vue` | 管理后台表格 UI |

### 3.2 根因

一次性任务执行流程：

1. 调度器扫到任务，调用 `ScheduledTaskService.executeTask(task)`；
2. `executeTask` **先**执行 `task.setNextFireTime(calculateNextFireTime(cron))` —— 对一次性任务，`cron.next(now)` 返回 `null`，`next_fire_time` 被置空；
3. 任务执行完成，`last_execution_status=COMPLETED`、`fire_count+1`；
4. 此后调度器的扫描条件 `next_fire_time <= now` 永远不满足，任务**不会再被触发**；
5. 但 `status` 仍为 `ACTIVE`，任务记录依然留在列表中，前端无从得知"它已经不会再执行了"。

即：**"不会再执行"这一事实从未被显式记录，列表因此无法区分**。

### 3.3 为什么不用 `next_fire_time IS NULL` 直接推断

- 语义隐含，前端需要自行推导，两端容易不一致；
- 无法区分"执行完不再触发"与"创建即过期（cron 在过去）"；
- QUEUED 场景下 `next_fire_time` 也已被预置为空，但任务实际还在排队等待执行，不能算完结。

因此引入显式字段 `finished`，由后端在执行链路中写入，作为唯一判定来源。

## 4. 技术选型与决策记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 「已执行完结」如何判定 | 新增显式状态字段，不依赖 `next_fire_time` 推断 |
| 2 | 新字段形态 | 新增 `finished TINYINT(0/1)` + `finished_at DATETIME` 两列；与 `status`（ACTIVE/PAUSED 开关语义）正交，不改枚举 |
| 3 | 哪些执行结果触发完结 | COMPLETED 与 FAILED 均置完结（失败的一次性任务同样不会再自动触发）；QUEUED 不置 |
| 4 | 客户端 UI 呈现 | Tabs 分组「进行中 / 已完结」，默认选中进行中 |
| 5 | 改动范围 | 桌面端 + 管理后台两端同步改 |
| 6 | 已完结任务操作 | 仅删除；启停开关禁用置灰 |
| 7 | 存量数据 | 迁移脚本一并处理（`next_fire_time IS NULL` 且 `fire_count > 0` 置完结） |

## 5. 实现步骤

### 5.1 数据库变更

新建 `backend/src/main/resources/db/migration/V069__scheduled_task_finished.sql`：

```sql
-- 定时任务完结状态：显式记录"不再自动触发"的生命周期终态
ALTER TABLE scheduled_task
    ADD COLUMN finished    TINYINT  NOT NULL DEFAULT 0 COMMENT '是否已执行完结：1=已完结(不再自动触发)，0=进行中',
    ADD COLUMN finished_at DATETIME          DEFAULT NULL COMMENT '完结时间';

-- 存量数据：已执行完的一次性任务（无下次触发且已至少触发一次）置为已完结
UPDATE scheduled_task
SET finished    = 1,
    finished_at = COALESCE(last_fire_time, updated_at)
WHERE deleted = 0
  AND next_fire_time IS NULL
  AND fire_count > 0;
```

> 说明：存量置完结仅针对"已触发过"（`fire_count > 0`）的任务；创建即过期但从未执行的任务保持进行中，由用户自行决定删除或修改。

### 5.2 后端

#### 5.2.1 实体 `ScheduledTask.java`

新增字段（与 `deleted` 的 Integer 风格保持一致）：

```java
/** 是否已执行完结：1=完结，0=进行中 */
private Integer finished;

/** 完结时间 */
private LocalDateTime finishedAt;
```

#### 5.2.2 执行后置完结 `ScheduledTaskService.executeTask`

在 `executeTask` 的 `finally` 块中，更新 `lastFireTime` / `fireCount` 之后、`updateById` 之前，追加完结判定：

```java
// 任务确已执行到终态（排除 QUEUED：消息仍在队列中，尚未真正执行完）
if (!"QUEUED".equals(task.getLastExecutionStatus())) {
    if (calculateNextFireTime(task.getCronExpression()) == null) {
        task.setFinished(1);
        task.setFinishedAt(LocalDateTime.now());
    }
}
```

要点：
- QUEUED 分支虽会 `return`，但 Java 的 `try-finally` 保证 `finally` 仍执行，因此必须显式排除 QUEUED；
- 不修改 `status`（保持 ACTIVE 展示为"启用"仅对进行中任务有意义，UI 按 `finished` 渲染，二者解耦）；
- 调度器扫描条件未变，完结任务 `next_fire_time` 为 null 天然不会被再触发。

#### 5.2.3 修改 cron 后复位 `ScheduledTaskService.updateTask`

在 `updateTask` 的 cronExpression 变更分支中，重算 `next_fire_time` 后，若新表达式仍有下次匹配则复位完结：

```java
task.setCronExpression(cronExpression);
LocalDateTime next = calculateNextFireTime(cronExpression);
task.setNextFireTime(next);
if (next != null) {
    // 新 cron 仍有触发计划 → 任务重新进入进行中
    task.setFinished(0);
    task.setFinishedAt(null);
}
```

同时调整"激活 PAUSED 任务时重算 `next_fire_time`"的分支：当重算结果非空时同样复位 `finished`/`finished_at`（保证任何路径下"有下次计划即进行中"的单一规则成立）。

#### 5.2.4 控制器与工具

- `ScheduledTaskController` 无改动：`finished`/`finishedAt` 随实体自动序列化返回，桌面端 `GET /scheduled-tasks` 与管理后台 `GET /scheduled-tasks/all` 均自动携带。
- 四个 Agent 工具无改动（见 §2.4-5）。

### 5.3 桌面端

#### 5.3.1 数据层 `desktop/src/composables/useScheduledTasks.ts`

- `ScheduledTask` 接口新增：

```ts
finished: boolean
finishedAt: string | null
```

- 新增分组计算属性：

```ts
const activeTasks   = computed(() => tasks.value.filter(t => !t.finished))
const finishedTasks = computed(() => tasks.value.filter(t => t.finished))
```

- 新增完结时间格式化（复用 `formatNextFire` 的展示风格，命名 `formatFinishedAt`）。

#### 5.3.2 设置页 `desktop/src/components/ScheduledTaskPanel.vue`

- 面板头部下方加 `el-tabs`（或 `el-radio-group` 分段控件）：「进行中（n）」「已完结（n）」，默认选中「进行中」；
- 「进行中」列表逻辑与现状一致；
- 「已完结」列表渲染已完结任务：卡片显示「已完结」标签（`el-tag type="info"`）+ 完结时间（"完结于 x月x日 xx:xx"）；**启停开关 `:disabled="task.finished"`**；保留删除按钮与确认弹窗；
- 空态文案按当前 Tab 区分（进行中空：现有空态；已完结空：如"还没有已完结的任务"）。

### 5.4 管理后台 `admin/src/views/scheduled-tasks/index.vue`

- `ScheduledTask` 接口新增 `finished: boolean`、`finishedAt: string | null`；
- 表格新增「完结」列（置于"状态"列后）：`finished=true` 显示 `el-tag type="info"` 文案"已完结"（`title` 悬浮展示完结时间），否则显示"进行中"；
- 「操作」列启停开关：`:disabled="row.finished"`；
- 不增加筛选下拉（见 §2.4-6）。

## 6. 落地清单

- [ ] `V069__scheduled_task_finished.sql`：加列 + 存量数据置完结
- [ ] `ScheduledTask.java`：新增 `finished` / `finishedAt` 字段
- [ ] `ScheduledTaskService.executeTask`：finally 中置完结（排除 QUEUED）
- [ ] `ScheduledTaskService.updateTask`：改 cron / 激活后重算非空即复位完结
- [ ] `desktop/src/composables/useScheduledTasks.ts`：接口字段 + 分组计算属性
- [ ] `desktop/src/components/ScheduledTaskPanel.vue`：Tabs 分组 + 完结标签 + 开关禁用
- [ ] `admin/src/views/scheduled-tasks/index.vue`：完结列 + 开关禁用
- [ ] 后端编译检查：`cd backend && mvn compile`
- [ ] 前端类型检查：`cd desktop && npm run build`、`cd admin && npm run build`
- [ ] 手工验证（见 §7）

## 7. 验收标准

1. 新建一次性任务（如 `0 0 10 5 8 ?`）并等待执行完成后，桌面端设置页该任务出现在「已完结」Tab，带完结标签与时间；「进行中」Tab 不再包含它；开关置灰不可操作；可删除。
2. 日常重复任务（如 `0 0 9 * * ?`）执行后仍留在「进行中」，开关可正常切换。
3. 未到触发时间的一次性任务在「进行中」展示，状态与现状一致。
4. 任务触发时会话繁忙被 QUEUED 的，不显示为已完结（待真正执行完成后按终态判定）。
5. 对已完结任务通过 `update_scheduled_task` 修改 cron 为仍会匹配的表达式后，任务自动回到「进行中」。
6. 升级数据库后（Flyway 执行 V069），存量已执行完的一次性任务直接出现在「已完结」分组。
7. 管理后台表格：已完结任务显示"已完结"标签，开关禁用；其余任务表现与现状一致。

## 8. 风险与注意事项

- **QUEUED 误判**：已通过"仅终态（COMPLETED/FAILED）置完结 + 显式排除 QUEUED"规避；验证时覆盖会话繁忙场景（步骤 4）。
- **改 cron 复活规则**：`finished` 复位仅发生在 `updateTask` 重算 `next_fire_time` 非空时，单一规则"有下次触发计划即进行中"，无歧义。
- **两端一致性**：`finished` 由后端统一写入，桌面端与管理后台只做读取渲染，不存在双端口径差异。
- **不重启后端**：本方案仅代码与迁移脚本改动，部署时由用户自行重启后端生效，Agent 不代为重启。
