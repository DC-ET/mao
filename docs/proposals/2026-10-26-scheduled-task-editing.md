# 提案：定时任务「改得动」—— 编辑能力下沉桌面端与 Cron 即时预览

> 后端 PUT 早支持全字段修改，admin 有完整表单、mao-cli 有 `scheduled-task update`，唯独日常承载定时任务管理的桌面端面板只能启停和删除——改个周期、改句提示词，只能删掉让 Agent 用自然语言重建。三个入口三种能力，最常用的那个最弱。

- 状态：已细化，技术方案待评审（第十七批）：[docs/plan/2026-10-26-scheduled-task-editing-technical-design.md](../plan/2026-10-26-scheduled-task-editing-technical-design.md)（含 §0 八项待确认决策与 §7 十八条冲突风险表）
- 日期：2026-10-26
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（P1 约 2 人日、P2 约 1 人日、P3 约 0.5-1 人日；零迁移，后端仅权限门一行）
- 关联：`desktop/src/components/ScheduledTaskPanel.vue`、`desktop/src/composables/useScheduledTasks.ts`、`backend-ts/src/schedule/scheduled-task.routes.ts`

## 1. 背景与现状

### 1.1 三种入口的能力不对称（代码可查）

| 入口 | 能做什么 | 证据 |
|---|---|---|
| 后端 REST | PUT 全字段：name / prompt / cronExpression / status / once / retryMax / retryIntervalMinutes / missedPolicy；本人可改自己任务 | `scheduled-task.routes.ts:89-108` |
| 管理后台 | 完整编辑表单（名称 / Cron / 一次性 / 失败重试 / 重试间隔 / 错过补偿 / 提示词） | `ScheduledTaskFormDialog.vue:20-89` |
| mao-cli | `scheduled-task update` 同款全字段 | `skills/mao-cli/lib/commands/scheduled-task.js:18` |
| **桌面端** | **只有启停、删除、看运行记录** | `useScheduledTasks.ts:70`（PUT 仅 `{ status }`）、`ScheduledTaskPanel.vue:60-91` |

桌面端用户改周期 / 改提示词的现实路径：删掉任务 → 回会话对 Agent 说「重建一个」→ Agent 重新理解需求重建。中途丢的是运行历史衔接与用户对「刚才那句到底改了没有」的确定感。

### 1.2 cron-preview 建好了却没人接，还带着错位的权限门

- 端点已就绪：`POST /v1/scheduled-tasks/cron-preview`（routes.ts:58-75），服务端 `buildCronPreview`（scheduled-task.service.ts:254）用同一套解析（含 Spring `?` 兼容）算未来触发时间；**非法表达式返回 `valid:false` 不抛异常——注释明写「编辑过程中输到一半属预期状态，不该弹全局错误」**，这是一个为编辑场景专门设计的端点。
- desktop 零调用；admin 表单只读展示「下次触发」（由任务自带的 nextFireTime 来），没有编辑态预览。
- 权限门错位：cron-preview 要求 `scheduled-task:read`（V121 语义是「**跨用户**查看定时任务列表、详情和 Cron 预览」，默认只授管理员与被回填角色）。但预览是纯计算、不读任何数据，与 `updateTask` 的「本人可改本人任务」owner 语义不匹配——默认角色用户在桌面编辑时预览会 403。

### 1.3 一个真实场景

用户让 Agent 建了「每个工作日 9:30 汇总销售数据」。两周后想把时间改到 10:00、提示词里的日期范围从「昨天」改成「近 7 天」。现在的做法是删除重建；重建后运行历史归零，他还不敢确认 Agent 有没有把两个改动都吃进去。改个时间要付出「重建整个任务」的代价，这就是断点。

## 2. 目标 / 非目标

**目标**

1. **P1 桌面编辑对话框**：字段集与 admin 表单对齐（名称 / Cron / 一次性 / 失败重试 / 重试间隔 / 错过补偿 / 提示词），保存走既有 PUT；面板行新增「编辑」入口，保存后局部刷新。
2. **P2 Cron 即时预览**：编辑框内防抖调 cron-preview，展示未来 3 次触发时间；非法表达式行内红字（不弹全局错误，沿用端点既有语义）；同步修正权限门——纯计算端点去掉跨用户读门（与 updateTask 的 owner 语义对齐）。
3. **P3 配置可见性收口**：面板行直接展示重试 / 错过补偿配置（`policyHint` 已有部分展示，补全口径）；「下次触发」与编辑预览同源。

**非目标**

- 不做 REST 创建端点（产品决策不变：创建走 Agent 自然语言入口，保持「一句话建任务」的低门槛）。
- 不做跨用户任务管理页（`/scheduled-tasks/all` 是 admin 域）。
- 不改调度引擎任何语义（重试 / 错过补偿是 0.0.256 已实施能力，本提案只暴露其编辑面）。
- 不做可视化 Cron 生成器（表达式 + 预览已覆盖纠错需求，生成器是另一个量级）。
- 不做「以运行记录为模板新建」（新建入口仍归 Agent）。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 任务模板 / Runbook（2026-10-19 否决） | 不生产模板资产、不新增存储，只把既有 PUT 能力接上桌面 UI。 |
| 信号哨兵对话内配置（2026-10-25 否决） | 不同域（schedule vs signal），且本提案不新增工具。 |
| 定时任务可靠性（0.0.256 已实施） | 那是调度行为（重试 / 补偿 / 暂停）；本提案是其配置面的 UI 收口，零调度语义改动。 |
| 执行中引导 / 批量任务（已否决） | 不碰执行内核，纯配置编辑。 |

## 4. 技术方案

### 4.1 编辑对话框（P1）

- 新增 `ScheduledTaskEditDialog.vue`（桌面端设计 token），从面板行「编辑」按钮打开；表单字段与 admin 对齐但按桌面端密度裁剪；失败重试 / 重试间隔 / 错过补偿折叠进「高级」（默认展示名称 / Cron / 提示词，见待确认 3）。
- 保存：`useScheduledTasks.ts` 扩展 `updateTask(id, fields)`，PUT 提交变更字段；前端做「至少一个字段」校验（与 mao-cli update 同款口径，后端已有校验兜底）。
- 语义护栏：仅允许编辑本人任务（面板本就只列本人 `listByUser`，UI 不出现他人任务入口，与 updateTask 的 owner 语义一致）。
- 一次性（once）任务：允许改提示词，不允许改 Cron（一次性任务的触发时点改了语义就变了，见待确认 1）。

### 4.2 Cron 预览联动（P2）

- 编辑框内 Cron 输入防抖 500ms 调 cron-preview；展示「未来 3 次：…」；`valid:false` 时行内红字提示，不弹全局错误（端点语义本就是为这个场景设计的）。
- 权限门修正：`scheduled-task.routes.ts` 的 cron-preview 去掉 `READ_PERMISSION` 门——纯计算、零数据访问，保留门只会挡住最需要它的默认角色用户。若评审倾向保留权限模型，退路是给默认角色补授 `scheduled-task:read`，但那会把「跨用户查看」能力一并授出，不推荐。
- 保存前二次确认：Cron 变更时展示「下次触发将变为 …」，与预览同源。

### 4.3 配置可见性（P3）

- 面板行 `policyHint` 补全：重试次数 / 间隔 / 错过补偿按 0.0.256 既有口径展示；运行记录 Tab 不变。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | 编辑对话框 + updateTask 全字段 | 2 人日 |
| P2 | Cron 预览联动 + 权限门修正 | 1 人日 |
| P3 | 行内配置展示收口 | 0.5-1 人日 |

**改动面**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| desktop | `ScheduledTaskPanel.vue`、新增 `ScheduledTaskEditDialog.vue`、`useScheduledTasks.ts` | 主要工作量 |
| backend-ts | `scheduled-task.routes.ts` cron-preview 权限门（一行） | 极小，零迁移 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| Cron 改错导致任务不触发 | 中 | 编辑态预览 + 保存前「下次触发」确认双保险；非法值后端 parseCron 本就拒绝 |
| 误改提示词丢关键约束 | 中 | 对话框回填原文，用户可见旧值；不做逐字 diff（改动可视化是另一个量级） |
| 桌面编辑与「Agent 也能改」竞态 | 低 | PUT 全量覆盖最后写赢；保存后刷新该行，与 mao-cli / Agent 工具同语义 |
| 权限门修正的回归面 | 低 | cron-preview 零数据访问，去掉门不影响任何既有调用方（admin 本来就有权限） |
| once 任务编辑限制引发困惑 | 低 | 表单内禁用 Cron 字段并注明原因 |

**待确认决策**

1. once（一次性）任务是否允许改 Cron？建议不允许（改时点=改语义），提示词可改。
2. cron-preview 权限门：去掉（推荐）vs 给默认角色补授 `scheduled-task:read`。
3. 高级字段（重试 / 间隔 / 错过补偿）默认折叠还是平铺？建议折叠「高级」，与面板行展示口径分层。

## 7. 测试要点

- 编辑：名称 / Cron / 提示词 / 重试 / 错过补偿各字段保存后面板刷新；空值与非变更提交被前端拦截；保存失败原位保留不关闭。
- 预览：合法 / 非法 Cron、防抖合并、编辑中输到一半不弹全局错误（端点语义回归）。
- 权限：默认角色用户（无 scheduled-task:read）编辑 + 预览全流程 200；admin 行为不变。
- 语义：once 任务 Cron 字段禁用；他人任务在面板与对话框均不出现。
- 回归：启停 / 删除 / 运行记录 / 已完成任务 Tab 行为不变；mao-cli update 与桌面保存结果一致。

## 8. 验收标准

1. 桌面端内 2 次点击完成「改周期 + 改提示词」，运行历史保留，无需删除重建。
2. Cron 输错即时行内反馈；保存前明确看到「下次触发」时间。
3. 管理员表单 / mao-cli / 桌面端三入口能力一致（同一 PUT 契约）。
4. 后端改动仅 cron-preview 权限门一行、零迁移（评审可核）；调度行为零变化。
