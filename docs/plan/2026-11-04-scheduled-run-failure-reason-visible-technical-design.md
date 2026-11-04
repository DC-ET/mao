# 定时任务失败原因透出技术方案（`errorSummary` 展示层补齐）

- 状态：已确认（待实施）
- 日期：2026-11-04
- 需求来源：[提案：定时任务「最近运行」能点进去也看不到失败原因 —— `errorSummary` 透出](../proposals/2026-11-04-scheduled-run-failure-reason-visible.md)（待评审；本方案为评审前技术细化，范围与提案目标一致）
- 上游：第二十二批「只把后端早已写好的字段翻到展示层」第一件
- 规模：小（纯展示透出；后端零改动；仅桌面约 0.5 人日；零迁移。管理后台「错误摘要」列经代码核对已于 2026-10-09 上线，不在本方案范围，见 §1.1 修订）
- 关联：`backend-ts/src/schedule/scheduled-task.store.ts`、`backend-ts/src/schedule/scheduled-task.service.ts`、`desktop/src/components/ScheduledTaskPanel.vue`、`admin/src/views/scheduled-tasks/ScheduledTaskDetailDialog.vue`

## 1. 需求背景

### 1.1 现状（代码可查）

| 能力 | 现状 | 代码证据 |
|---|---|---|
| 后端写失败原因 | ✅ `finishRun` 无论成功失败都调 `clipError(opts.error)` 写 `error_summary`（截断 500 字，空转 null），单测断言为「排队执行失败」「会话已删除」 | `scheduled-task.service.ts:1576,1764-1768`、`scheduled-task.service.spec.ts:1389` |
| 后端回出 | ✅ `listRuns` 走 `SELECT *`，返回体含 `errorSummary`；`GET /v1/scheduled-tasks/:id/runs` 按属主/`scheduled-task:read` 门透出 | `scheduled-task.store.ts:166` `listRuns`、`scheduled-task.routes.ts:120-138` |
| 类型契约 | ✅ 两端 `ScheduledTaskRun` 接口均有 `errorSummary: string | null` | 桌面 `desktop/src/composables/useScheduledTasks.ts:30-41`、`admin/.../types.ts:34`（初稿误引 `desktop/src/api/index.ts:741`，该处 `errorSummary` 属 `OpenApiCallView`，与定时任务无关） |
| 桌面渲染 | ❌ `run-row` 只渲染时间/徽标/手动/attempt/时长/成本，从不读 `errorSummary` | `ScheduledTaskPanel.vue:63-90` |
| 管理后台渲染 | ✅ **已上线**（初稿误判为 ❌，2026-11-04 评审核对代码后更正）：详情弹窗 `runs` 表早有「错误摘要」列（`min-width="160"` + `show-overflow-tooltip`） | `ScheduledTaskDetailDialog.vue:67`，随 2026-10-09 `cbdfde84`（运行历史/失败重试/错过补偿/自动暂停）交付 |

### 1.2 要解决的问题

1. **失败了但不敢判断该怎么办**：用户看到「失败」，分不清是「模型没钱了」「会话被删了」还是「工具超时了」——三种处置完全不同，而后端其实早就写了结论。
2. **绕路去翻会话才知道原因**：用户必须点运行行进入绑定会话，再进 Run Trace 深挖。对每天凌晨跑的巡检任务，这一步是普遍的 friction。
3. ~~管理后台排障同样缺这条信息~~ **（评审更正：不成立）**：admin 详情弹窗的「错误摘要」列 2026-10-09 已上线（`cbdfde84`），管理端排障不受影响；真正缺展示的只有桌面「最近运行」行内。

### 1.3 关键事实（设计建立在其上）

- `errorSummary` 可为 `null`（成功执行、或失败原因为空）。`finishRun` 在成功时传 `errorSummary: null`（`scheduled-task.service.ts:1477`）。
- `clipError` 的截断口径：500 字（`scheduled-task.service.ts:1764-1768`，`text.slice(0, 500)`）。本方案不改截断口径。
- **透出价值边界（评审补充，代码可查）**：`finishRun` 全部写入方里，有信息量的结论（`会话已删除`、`预算不足，执行被准入闸门阻止`、`排队执行失败`、异常 `e.message` 等）集中在边缘路径；**主路径「Agent 本轮执行失败」写死的是通用文案「执行失败」**（`scheduled-task.service.ts:714-716` 与 `:1023-1025`，liveExecution 后回读会话 phase=FAILED 的分支）。即本次透出能区分「会话被删 / 预算不足 / 排队失败」；而「模型超时、工具报错」这类真正的执行失败，行内仍只显示「执行失败」，与「失败」徽标相比信息增量≈0。把 `taskTerminalService.finishExecution` 侧已有的 error message 回写进 `error_summary` 才能根治——属后端改动，超出 D1「零后端」边界，建议另立方案，不在本方案范围。
- `beginRetry` 会在重试前清空 `error_summary`（`scheduled-task.store.ts:123-125`，置 NULL）。即失败行的 `errorSummary` 只在「失败当次」有值；重试开始后该行回 NULL，下一次失败再写入新的。展示层必须按行独立渲染，不做跨 attempt 持有。
- 运行行的唯一键 `(task_id, fire_time)`；`/runs` 默认 `limit=20`，桌面 `fetchRuns` 已按 `limit=20` 请求。
- 桌面 api 拦截器对错误信封自动 toast（`desktop/src/api/index.ts:69-73`），本方案无新错误路径。
- 审计由全局 Audit 拦截器对 `/v1/**` 生效（`app-hooks.ts`），本方案不新增端点，不触审计。

## 2. 需求描述

### 2.1 要做的

1. **桌面「最近运行」失败原因内联展示**：`desktop/src/components/ScheduledTaskPanel.vue` 的 `run-row` 追加渲染 `run.errorSummary`——非空时在行内展示一句（次级字色、超长省略、`title` 悬停全文）；`null`/空串时整行布局与今日完全一致（不留空位）。
2. ~~管理后台详情「运行历史」表新增「错误摘要」列~~ **（评审删除：已上线，无需改动）**：`admin/src/views/scheduled-tasks/ScheduledTaskDetailDialog.vue` 的 `runs` 表 2026-10-09（`cbdfde84`）已有「错误摘要」列（`min-width="160"`、`show-overflow-tooltip`），空值 `—` 口径与本方案 D4 一致；实施时仅回归确认该列仍在，不做任何编辑。
3. **桌面端说明文档同步**：`skills/mao-cli/reference/` 下桌面端章节增一行「最近运行」失败原因可见说明（如 `desktop.md` 新增对应句）。

### 2.2 明确不做的

- **不做失败原因自动分型/归因推理**：不生成新的归因标签、不加失败分类维度、不引入失败归因卡的既有语义（本方案仅透出后端已写的结论文本）。
- **不改 `clipError` 的截断口径、不改失败重试/冷却/自动暂停的执行逻辑**：不动 `scheduled-task.service.ts` 的 `finishRun`/收尾分支。
- **不做「从失败轮重跑」**（2026-11-04 已驳回）：原因可见 ≠ 续跑入口；本方案不加任何触发入口。
- **不给桌面运行行加失败图标**：仅文字，与 `run-row` 朴素风格保持一致（行内徽标已在徽标位表达状态）。
- **不改管理后台详情弹窗其他列、不改桌面其他面板**；不新起后端端点、不新增收件箱 kind、不新增 LLM 场景。
- **不把主路径「执行失败」通用文案升级为具体原因**：不回写会话/执行侧 error message 到 `error_summary`（后端改动，另立项，见 §1.3「透出价值边界」）。
- **零数据库迁移**；不动 `task-terminal.service.ts`、监控调度器、重连/补偿逻辑；不改安卓壳与 Electron 端。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 后端改动 | **零后端改动** | `SELECT *` 已回出 `errorSummary`，`listRuns` 无白名单过滤；两端类型已齐。 |
| D2 | 桌面展示位置 | `run-row` 内追加 `<span class="run-error">`，与成本同级、`v-if="run.errorSummary"` | 复用已有行按钮语义（整行点击即进会话），不改行点击语义；与成本/时长同级使「行内信息密度」与 admin 表列数一致。 |
| D3 | 长文本处理 | 行内单行弱化字色、超长省略（需显式 `white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0`——`.run-row` 区块内无现成截断样式可复用，且 flex 子项默认 `min-width: auto` 不可收缩）；`title` 悬停全文 | `clipError` 最长 500 字，不做截断处再切；与 `run-row` 现有 `formatCost` 的行宽口径一致。 |
| D4 | 空值口径 | `null`/空串 → 不渲染该 span（不是渲染空位）；admin 列空时 `—` | 与桌面「`errorSummary === null` 不渲染」逻辑对齐；admin `—` 与该表既有 `durationMs/costMicros` 空值口径一致。 |
| D5 | 重试清空的语义 | 重试行 `errorSummary` 为 NULL 时不渲染（该行从「失败且有原因」回到「重试中/运行中」） | `beginRetry` 已把 `error_summary` 置 NULL（store:123），展示层无须额外处理：`run-row` 在重试时会自动去掉 reason 展示。 |

## 4. 数据契约

### 4.1 数据库

**无改动。** `scheduled_task_run.error_summary VARCHAR(500)` 已在（截断由 `clipError` 在写入端保证，见 §1.3）。

### 4.2 接口

**无改动。** `GET /v1/scheduled-tasks/:id/runs` 已返回 `errorSummary: string | null`。

| 端 | 字段 | 来源 |
|---|---|---|
| 桌面 | `ScheduledTaskRun.errorSummary` | `desktop/src/composables/useScheduledTasks.ts:30-41`（已在） |
| 管理后台 | `ScheduledTaskRunRow.errorSummary` | `admin/src/views/scheduled-tasks/types.ts:34` `ScheduledTaskRunRow`（字段已在；列渲染亦已在 `ScheduledTaskDetailDialog.vue:67`） |

## 5. 实现步骤

### 5.1 桌面 `desktop/src/components/ScheduledTaskPanel.vue`

1. **渲染**：在 `run-row`（`~63-90`）徽标之后追加：
   ```vue
   <span v-if="run.errorSummary" class="run-error" :title="run.errorSummary">{{ run.errorSummary }}</span>
   ```
   （`.run-error` 样式必须写全——初稿「复用 `.run-row` 区块内截断模式」不成立：该区块内并无任何截断样式，且 `.run-row` 为 `display: flex; flex-wrap: wrap`，flex 子项默认 `min-width: auto` 不会收缩，只写 `flex: 1 + text-overflow` 不会省略：
   ```css
   .run-error {
     flex: 1;
     min-width: 0;
     white-space: nowrap;
     overflow: hidden;
     text-overflow: ellipsis;
     color: var(--aw-ink-muted);
   }
   ```
   另注意 `.run-row` 带 `flex-wrap: wrap`：行内剩余宽度不足时该 span 会整体换到第二行并占满整行后省略——最多两行，属可接受行为，验收时勿当布局 bug。`title` 提供全文悬停。）
2. **空值**：`v-if` 而非三元占位，`run.errorSummary` 为 `null`/空串时不渲染该 span，整行布局与今日完全一致。
3. **不改点击语义**：整行按钮的 `@click="openRunSession"` 保持不变。

### 5.2 管理后台 `admin/src/views/scheduled-tasks/ScheduledTaskDetailDialog.vue`

**无需改动（评审核对后划除）。** 该列已于 2026-10-09 `cbdfde84` 上线：

```vue
<el-table-column prop="errorSummary" label="错误摘要" min-width="160" show-overflow-tooltip />
```

`el-table` 空值默认显示 `—`，与同表 `durationMs/costMicros` 口径一致。实施时仅需回归确认该列仍在（防误删），不做任何编辑。

### 5.3 文档同步

1. `skills/mao-cli/reference/desktop.md` 的「定时任务」节（现约 194-196 行）增一句：「最近运行」失败行内联展示错误摘要（悬停看全文）。注：CLI 侧 `reference/scheduled-task.md` 的 `runs` 命令说明早已含「错误摘要」，无需改。

### 5.4 CHANGELOG

按 AGENTS.md 规范写入根 `CHANGELOG.md` 顶部新版本号：用户/运维可见改动（失败原因透出）须同任务写入 `## x.y.z (2026-11-04)`；`./scripts/changelog-extract.sh` 口径（desktop 共用 UI → 前端节）。

## 6. 落地清单

| # | 动作 | 位置 |
|---|---|---|
| 1 | 桌面 `ScheduledTaskPanel.vue` 的 `run-row` 追加 `run.errorSummary` 渲染 + `.run-error` 完整样式（§5.1） | `desktop/src/components/ScheduledTaskPanel.vue` |
| 2 | 桌面端说明文档补一句 | `skills/mao-cli/reference/desktop.md` |
| 3 | CHANGELOG 新版本节（前端节） | 根 `CHANGELOG.md` |
| — | （管理后台「错误摘要」列已随 `cbdfde84` 上线，仅回归确认，无编辑） | `admin/src/views/scheduled-tasks/ScheduledTaskDetailDialog.vue` |

## 7. 测试要点

1. **桌面**：失败行展示 `errorSummary`；成功行/无原因的失败行布局与改动前一致；长文本（500 字）单行省略 + 悬停可见全文。
2. **管理后台（仅回归）**：runs 表「错误摘要」列仍在、空值 `—`；本方案不编辑该端。
3. **回归**：`/runs` 返回体与改动前一致（本方案零后端改动，断言仅为 VO 字段已在时的展示）；运行也不会因此多触发、写跑、触发重试语义变化。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| `errorSummary` 含换行/长文本把行撑高 | `title` 悬停全文 + 行内单行弱化字色、超长省略（D3） |
| 敏感错误信息暴露给非属主 | 字段已在属主端点内回读（`/runs` 属主或 `scheduled-task:read`），权限门不变；桌面读的是本人任务的 runs |
| 重试行 `errorSummary` 已被 `beginRetry` 清成 NULL，展示层误以为「失败且无原因」 | `v-if` 不渲染即天然一致（D5）；行徽标由 `runBadge` 表达「重试中」，不依赖 `errorSummary` |
| 主路径执行失败透出后只有通用「执行失败」，用户觉得「还是不知道为啥」 | 预期内：结论文本由后端写入方决定（§1.3 透出价值边界）。根治需后端把执行侧 error message 回写 `error_summary`，另立项，不在本方案 D1「零后端」边界内 |
