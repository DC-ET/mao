# 提案：定时任务「最近运行」能点进去也看不到失败原因 —— `errorSummary` 透出

> 定时任务跑失败了，用户在桌面端打开「最近运行」只看到「失败 + 耗时 + 成本」，想要的「为什么失败」根本不在那一行里——`scheduled_task_run.error_summary` 后端早在写（`clipError` 截断、单测里断言为「会话已删除」），却从没下发到桌面。用户最后只能点进行会聊有的轨迹面板去翻。管理后台的详情弹窗与之相同，错失唯一一句话「排队执行失败」这类结论的可见性。

- 状态：待评审
- 日期：2026-11-04
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（纯展示透出；后端零改动或仅确认 VO 已有字段、桌面/管理后台各约 0.5 人日；零迁移）
- 关联：`backend-ts/src/schedule/scheduled-task.store.ts`（`errorSummary` 读写）、`desktop/src/components/ScheduledTaskPanel.vue`（`run-row` 渲染）、`admin/src/views/scheduled-tasks/ScheduledTaskDetailDialog.vue`

## 1. 背景与现状

### 1.1 已有积木全在，唯独缺「展示最后一公里」（代码可查）

| 能力 | 现状 | 代码证据 |
|---|---|---|
| 后端写失败原因 | ✅ `finishRun` 无论成功失败都调 `clipError(opts.error)` 写 `error_summary`，单测断言「排队执行失败」「会话已删除」，字段已在 VO 里回出 | `scheduled-task.service.ts:1576`、`scheduled-task.service.spec.ts:1389`、`store.ts:102` |
| 后端回出 API | ✅ `ScheduledTaskRunRow` / 桌面 `ScheduledTaskRun` 接口都有 `errorSummary: string \| null`，`/runs` 端点返回体含该字段 | `admin/.../types.ts:34`、桌面 `composables/useScheduledTasks.ts:30-41` |
| 桌面渲染 | ❌ `run-row` 只渲染时间/徽标/手动/attempt/时长/成本，未读 `errorSummary`；失败行点开进的仍是同批会话 | `ScheduledTaskPanel.vue:65-85` |
| 管理后台渲染 | ✅ **已上线**（2026-11-04 评审核对代码后更正，初稿误判 ❌）：详情弹窗 `runs` 表早有「错误摘要」列（`min-width="160"` + `show-overflow-tooltip`），2026-10-09 `cbdfde84` 随运行历史交付 | `ScheduledTaskDetailDialog.vue:67` |
| 对照：哨兵同构情况 | ✅ 哨兵轮询记录表渲染了「详情」列（`row.error \|\| valueHash`），证明「轮询记录展示失败原因」是已接受口径 | `SignalWatchersView.vue:190-250`（checks 抽屉） |

### 1.2 真实痛点

1. **失败了但不敢判断该怎么办**：用户看到「失败」，分不清是「模型没钱了」「会话被删了」还是「工具超时了」——三种处置完全不同，而后端其实早就写了结论。
2. **绕路去翻会话才知道原因**：要确认原因，用户必须先想起来点那行进会话，再进 Run Trace 深挖。对只想快看的场景（比如每天凌晨的巡检任务），这一步是普遍的 friction。
3. **admin 详情表同样缺这一列**：排障的人在管理后台看批量列表时，复用任何桌面端了解但同样缺这条信息。

## 2. 目标 / 非目标

**目标**

1. **桌面「最近运行」失败行内联展示原因**：`run.errorSummary` 非空时，在行内用次级文字展示（如缩略一行）+ `title` 悬停全文；无原因的失败行维持现状（只显示徽标）。
2. ~~管理后台详情「运行记录」表加一列「失败原因」~~ **（2026-11-04 评审更正：已上线）**：该列 2026-10-09 `cbdfde84` 已在（`ScheduledTaskDetailDialog.vue:67`），无需改动；本提案实际范围收缩为桌面端。

**非目标**

- **不做失败原因自动分型/归因推理**：不生成新的归因标签、不加失败分类维度、不返回失败归因卡的既有语义（本提案仅透出后端已写的结论文本）。
- 不改 `clipError` 的截断口径、不改失败重试/冷却/自动暂停的执行逻辑，不动 `scheduled-task.service.ts` 的收尾分支。
- 不做「从失败轮重跑」（2026-11-04 已驳回）——原因可见 ≠ 续跑入口。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 失败任务重跑（归因与续跑，2026-11-04 已否决） | 不做归因分型/重跑入口，只把已写的 `errorSummary` 透出到本就该显示的运行行。 |
| 定时任务可靠性（2026-10-09 已实施） | 不改重试/补偿/自动暂停语义；只透出这些语义已经产出的记录。 |
| 定时任务失败重试入口 | 不新加触发器、不改 `scheduled_task_run` 的写入与调度路径。 |

## 4. 方案设计

### 4.1 桌面 ScheduledTaskPanel

- `run-row` 内部追加 `<span v-if="run.errorSummary" class="run-error" :title="run.errorSummary">{{ run.errorSummary }}</span>`，样式按 `run-row` 弱化字色；空/null 时整行布局与今日完全一致。
- 无后端改动；`ScheduledTaskRun` 类型里 `errorSummary` 已在。

### 4.2 管理后台详情弹窗

- ~~`ScheduledTaskDetailDialog` 的 `runs` 表（`ScheduledTaskRunRow`）新增一列「失败原因」~~ **（已上线，2026-10-09 `cbdfde84`，无需改动）**。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | **无改动**（确认 `/runs` 已回出 `errorSummary`，本次仅确认；若 VO 缺字段则补一行） |
| desktop | `ScheduledTaskPanel.vue` 的 `run-row` 追加 `run.errorSummary` 显示 |
| admin | **无改动**（「错误摘要」列已随 `cbdfde84` 上线，仅回归确认） |
| skills/mao-cli | 补桌面端说明（失败原因在行内可见） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `errorSummary` 含换行/长文本把行撑高 | `title` 悬停全文 + 行内单行弱化字色、超长省略 |
| 敏感错误信息暴露给非属主 | 字段已属主端点内回读，权限门不变；桌面读的是本人任务的 runs |

## 7. 测试要点

1. 桌面：失败行展示 `errorSummary`；无原因时行布局与今日一致；长文本省略 + 悬停可见。
2. 管理后台（仅回归）：runs 表「错误摘要」列仍在、空时 `—`。
3. 回归：运行也不会因此多触发、不会写跑、不会改变重试语义。

## 8. 待确认决策

1. 行内是否要加失败图标（与哨兵 checks 表的 `badge-danger` 对齐）还是仅文字——建议文字即可，与 `run-row` 朴素风格保持一致。
2. 管理后台列的宽度（仿哨兵 checks「详情」列 140px 还是更宽）——按哨兵同款。
