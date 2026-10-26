# 定时任务「改得动」——桌面端编辑与 Cron 即时预览技术方案

> 版本：v1.0（2026-10-26）
> 状态：待评审（§0 决策待需求方逐条确认；提案见 [../proposals/2026-10-26-scheduled-task-editing.md](../proposals/2026-10-26-scheduled-task-editing.md)，第十七批）
> 一句话：接通后端已就绪的 PUT 全字段与 cron-preview 端点，桌面端定时任务从「只能启停删」升级为「改得动、输不错」；后端仅 cron-preview 权限门一处修正，零迁移，调度行为零变化。

## 0. 待确认决策

| # | 决策点 | 建议结论 | 连带影响 |
|---|--------|----------|----------|
| 1 | 保存载荷形态 | **全字段 PUT（不含 status）**，与 admin 表单对齐 | 完结任务编辑会按后端逻辑重新激活（C3），对话框须内嵌 alert；单一代码路径，三种入口行为一致 |
| 2 | 一次性任务可否改 Cron | **允许**（修订提案原「不允许」），配套 onceMismatch 警告 + 开关自动跟随 | 与 admin / agent 工具 `update_scheduled_task` 对齐；后端对 once 重判有完整逻辑（`once==null` 自动派生被显式传参关闭，见 C4） |
| 3 | cron-preview 权限门 | **去除 READ_PERMISSION 门**（纯计算端点，零数据访问），保留 `requireUserId` | 默认角色用户（role 2 无 `scheduled-task:read`）否则预览 403（C1）；备选「补授权限」否决（会连带放出跨用户读） |
| 4 | 打开对话框时是否重拉详情 | **拉**（`GET /v1/scheduled-tasks/:id`），失败降级列表快照 + 提示 | 防面板快照陈旧与 Agent 并发修改（C2/C9）；一次额外 GET |
| 5 | 预览防抖与竞态 | 400ms 防抖 + 请求代际丢弃（`previewSeq`），复制 admin 范式 | 快速输入不展示过期结果（C6）；0.0.353 刚修过同款代际问题 |
| 6 | 高级字段默认态 | **默认折叠**「高级设置」（重试 / 间隔 / 错过补偿），名称 / Cron / 提示词平铺 | 与面板行 policyHint「仅异值」口径分层，不增加日常噪音 |
| 7 | 保存后投影刷新 | 局部替换 tasks 数组项；`finished` 1→0 时自动切「进行中」Tab 并提示 | 防「保存后任务不见了」（C8） |
| 8 | P3 行内配置可见性 | 行内配置区**始终展示**三项当前值（默认值弱化标注「默认」）；**若评审持稳可降级为仅异值（现状不动，P3 取消）** | 唯一可见层增量，其余零感知 |

## 1. 需求背景

提案 §1 已论证。代码侧事实在本方案定稿前逐条核实（行号为 2026-10-26 实测）：

**三种入口的能力不对称（其中 admin 强于提案描述，见 §12）**

| 入口 | 能做什么 | 证据 |
|---|---|---|
| 后端 REST | PUT 全字段：name / prompt / cronExpression / once / retryMax / retryIntervalMinutes / missedPolicy；本人可改本人任务（owner 语义），`scheduled-task:write` 才可改他人 | `scheduled-task.routes.ts:89-109`；`updateTask` 见 `scheduled-task.service.ts:406-486` |
| 管理后台 | 完整编辑表单 + **编辑态 Cron 预览已在调用 cron-preview**（打开与输入时，400ms 防抖 + 代际丢弃） | `ScheduledTaskFormDialog.vue:196-215` |
| mao-cli | `scheduled-task update` 全字段（**缺 once**，无 `--once` flag） | `skills/mao-cli/lib/commands/scheduled-task.js:89-131` |
| **桌面端** | **只有启停（PUT 仅 `{status}`）、删除、运行记录** | `useScheduledTasks.ts:70`、`ScheduledTaskPanel.vue:81-94` |

桌面端用户改周期 / 改提示词的现实路径：删掉任务 → 回会话让 Agent 用自然语言重建 → 运行历史归零。Agent 侧工具 `update_scheduled_task`（`scheduled-task-tools.ts:140-186`）字段比 mao-cli 更全（含 once），但那是对话内路径，用户对「刚才那句到底改了没有」没有确定感。

**cron-preview：为编辑场景设计、桌面端却接不上的端点**

- `POST /v1/scheduled-tasks/cron-preview`（routes.ts:58-72）：与调度器共用 `normalizeSpringCron` + croner + Asia/Shanghai，**预览时间即实际执行时间**；非法表达式返回 `valid:false` 不抛异常（注释明写「编辑过程中输到一半属预期状态」）。
- 其权限门 `scheduled-task:read`（routes.ts:60-62）语义是「**跨用户**查看定时任务列表、详情和 Cron 预览」（V121 权限目录原文）。V001 默认用户角色（role_id=2）只有 `agent:read` + `model:read`，V121 的回填显式排除 role 2——**默认角色用户今天调该端点会 403**。admin 能用是因为 role 1 恒有该权限。
- 桌面端 `ScheduledTask` 接口（`useScheduledTasks.ts:4-25`）缺 `once` 字段（后端数据本就返回，V096 列），编辑对话框需要补声明。

**面板现状**：`/settings/scheduled-tasks` 路由（`router/index.ts:131-133`，导航在 `SettingsView.vue:56`）；`onMounted(fetchTasks)` 拉取，**无 WS 推送**（`useStreamWS.ts` 零 scheduled 事件），行内变更全靠本地 mutation；仅 `useScheduledTasks.test.ts`（42 行）测 `statusLabel` / `runBadge` 两个纯函数，无组件测试基建（desktop 无 `@vue/test-utils` 先例）。

## 2. 需求描述

### 2.1 目标

1. **P1 编辑对话框**：字段 = 名称 / Cron / 一次性开关 / 提示词 + 高级（重试 / 间隔 / 错过补偿，默认折叠）；保存走既有 PUT（全字段、不含 status）；完结任务内嵌重新激活 alert；面板行新增「编辑」入口；保存后局部刷新 + 跨 Tab 提示。
2. **P2 Cron 即时预览**：对话框内 400ms 防抖调 cron-preview，展示未来 3 次触发；非法行内红字、保存禁用；后端去除 cron-preview 权限门并补 gates 测试。
3. **P3 行内配置可见性（可降级，决策 8）**：面板行内始终展示重试 / 间隔 / 错过补偿当前值。

### 2.2 范围边界

| 维度 | 做 | 不做 |
|---|---|---|
| 后端 | 仅 cron-preview 去权限门（一行 + 注释）；零迁移 | 不加端点、不动 updateTask / 调度器 / 任何既有逻辑 |
| desktop | `ScheduledTaskPanel.vue` 接线 + 新 `ScheduledTaskEditDialog.vue` + `useScheduledTasks.ts` 扩展 + 新纯函数模块 | 不碰消息 / 会话 / WS / 其他面板；不做创建（产品决策：创建走 Agent 自然语言）；不做跨用户管理（`/all` 是 admin 域） |
| 对话框字段 | 名称 / Cron / once / 提示词 / 重试 / 间隔 / 错过补偿 | 不暴露 status（开关已有，误传会触发 `enabling` 清零连续失败计数，见 C17）、agentId / sessionId（不可变） |
| CLI | mao-cli 缺 `--once` 列为已知口径差，**不扩** | 不改 mao-cli / agent-cli 任何命令 |
| 移动端 | 对话框宽度 `min(520px, calc(100vw - 32px))`（ShareDialog 先例） | 不改布局、不引入新手势（安卓壳约束） |

## 3. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| 对话框范式 | `el-dialog` + `open()` 命令式打开 + `form` ref + `management-dialog` class，宽 `min(520px, calc(100vw - 32px))`、`append-to-body` | 与 `CommandEditDialog.vue` / `ShareDialog.vue` 既有范式一致；ShareDialog 的宽度写法是仓内唯一窄屏安全先例 |
| 保存载荷 | 全字段（name / prompt / cronExpression / once / retryMax / retryIntervalMinutes / missedPolicy），**不含 status** | 与 admin 表单逐字段对齐（决策 1）；不含 status 防误触发启用态跃迁（C17） |
| 详情刷新 | 打开时 `GET /v1/scheduled-tasks/:id`（owner 可读，routes.ts:74-87），失败降级快照 | 防陈旧快照覆盖 Agent 并发修改（C2） |
| 预览联动 | 复制 admin 的 `previewSeq` 代际丢弃 + 400ms 防抖 + `onceTouched` / `initialCron` / `onceMismatch` 三件套 | 已被 admin 生产验证；0.0.353 修复的同款代际问题可作回归参照 |
| 可测性 | 新逻辑全部抽到 `desktop/src/utils/scheduledTaskEdit.ts` 纯函数（表单构建 / 本地 cron 校验 / 可提交判定 / once 派生 / 载荷构造），vitest 单测 | desktop 无组件测试基建；纯函数模块与 `pie-series.ts` / `trend-options.ts` 同范式 |
| 状态管理 | 不新增 store；`useScheduledTasks.ts` 扩 `updateTask` / `fetchTaskDetail` 两个方法 | composable 是本面板唯一消费方（已核实），无外溢 |
| 图标 | 「编辑」用文字 link 按钮（与「删除」并列），不引入新图标 | 避免动 `main.ts` 按需注册图标集（0.0.345 口径） |

## 4. 总体架构

```
┌──────────────────── backend-ts（唯一改动：去一行权限门） ────────────────────┐
│ PUT  /v1/scheduled-tasks/:id        全字段 patch（既有，零改动）             │
│ GET  /v1/scheduled-tasks/:id        详情（既有，owner 可读）                │
│ POST /v1/scheduled-tasks/cron-preview  ★去除 scheduled-task:read 门（§5.1）  │
└────────────────────────────────────────────────────────────────────────────┘
                 │ 全部既有端点；updateTask 调度语义（reactivate /            │
                 │ pendingOnceRetry / enabling 清零）一行不动                  │
                 ▼
┌────────────────── useScheduledTasks.ts（+2 方法，+1 字段） ────────────────┐
│ once?: number|null（类型补声明）                                            │
│ updateTask(id, fields) → PUT → 成功局部替换 tasks 数组项，返回 task|null     │
│ fetchTaskDetail(id)   → GET → 失败返回 null（降级快照）                     │
└────────────────────────────────────────────────────────────────────────────┘
        │                                    │
        ▼                                    ▼
┌ ScheduledTaskPanel.vue ──────┐   ┌ utils/scheduledTaskEdit.ts（纯函数） ┐
│ 行内「编辑」按钮 → 开对话框   │   │ buildEditForm / cronLocalError /     │
│ saved 后局部刷新 + 跨 Tab    │   │ canSubmitEdit / resolveOnceAfter-    │
│ 删除时关对话框（C13）        │   │ Preview / buildUpdatePayload          │
└──────────────────────────────┘   └─────────────────────────────────────┘
                 │
                 ▼
┌ ScheduledTaskEditDialog.vue（新组件） ─────────────────────────────────────┐
│ 名称 / Cron（防抖预览 + 未来 3 次 + oneShot 徽标）/ 一次性开关（mismatch 警告）│
│ 提示词 / 高级折叠（重试 0-5、间隔 1-60、错过补偿）                          │
│ 完结任务 alert + 「保存并重新激活」按钮文案                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

数据流原则：

- **对话框是任务的一次性编辑视图**：打开时以服务端详情为准（决策 4），保存时全字段覆盖——与 admin 表单完全同语义，last-write-wins（C2 接受并文档化）。
- **面板是投影**：保存成功后 composable 局部替换数组项，`activeTasks` / `finishedTasks` 两个 computed 自动跟随；跨 Tab 消失问题由决策 7 的切 Tab + 提示解决。
- **错误一律走既有拦截器 toast**（composable 现有注释「interceptor handles toast」口径），对话框不自建第二套错误展示；预览端点的 `valid:false` 是唯一行内展示的错误（端点语义本就是为此设计）。

## 5. 详设

### 5.1 后端：cron-preview 去权限门（唯一后端改动）

```ts
app.post('/v1/scheduled-tasks/cron-preview', async (req, reply) => {
  const userId = requireUserId(req, deps.jwt);
  // 纯计算端点（croner nextRuns，不触碰任何数据）：登录即可用。
  // 原 scheduled-task:read 门是「跨用户读」语义（V121 权限目录原文），
  // 会把默认角色用户挡在桌面端编辑预览之外——该端点本就为「编辑过程中输到一半」设计。
  const body = (req.body ?? {}) as { expression?: unknown; count?: unknown };
  // ……以下逐字不动
```

- `requireUserId` 保留（未登录仍 401）；`previewCron` / `buildCronPreview` / `clampPreviewCount` 一行不动。
- admin 行为不变（role 1 恒有权限，去门不改变其结果）。
- 测试落到 `backend-ts/src/permission/admin-permission-gates.spec.ts`（该文件已有 scheduled-task 用例，:90-126），新增：无 `scheduled-task:read` 的登录用户调 cron-preview 得 `code:0` 且 `previewCron` 被调用（§8）。

### 5.2 composable 扩展（`useScheduledTasks.ts`）

```ts
export interface ScheduledTask {
  // ……既有字段
  once?: number | null          // 新增：V096 列本就返回，只是类型未声明
}

export interface ScheduledTaskEditFields {
  name: string
  prompt: string
  cronExpression: string
  once: boolean
  retryMax: number
  retryIntervalMinutes: number
  missedPolicy: 'RUN_ONCE' | 'SKIP'
}

/** 全字段保存（不含 status）。成功局部替换并返回更新后的任务；失败返回 null（拦截器已提示）。 */
async function updateTask(id: number, fields: ScheduledTaskEditFields): Promise<ScheduledTask | null> {
  try {
    const { data } = await api.put(`/scheduled-tasks/${id}`, fields)
    if (data) {
      const idx = tasks.value.findIndex(t => t.id === id)
      if (idx >= 0) tasks.value = [...tasks.value.slice(0, idx), data, ...tasks.value.slice(idx + 1)]
    }
    return data ?? null
  } catch { return null }
}

/** 打开对话框时的详情刷新；失败返回 null，调用方降级列表快照。 */
async function fetchTaskDetail(id: number): Promise<ScheduledTask | null> {
  try {
    const { data } = await api.get(`/scheduled-tasks/${id}`)
    return data ?? null
  } catch { return null }
}
```

- 数组替换用不可变写法（与既有 `deleteTask` 的 filter 赋值风格一致），触发 computed 重算。
- `toggleStatus` / `deleteTask` / `fetchRuns` 等既有方法一行不动。

### 5.3 纯函数模块（`desktop/src/utils/scheduledTaskEdit.ts`，vitest 单测对象）

| 函数 | 职责 | 边界用例 |
|---|---|---|
| `buildEditForm(task)` | 任务 → 表单初值；`retryMax ?? 2`、`retryIntervalMinutes ?? 5`、`missedPolicy === 'SKIP' ? 'SKIP' : 'RUN_ONCE'`、`once === 1` | 四项全 null / undefined 的老任务；missedPolicy 非法值兜底 |
| `cronLocalError(expr)` | 本地 6 段预校验（trim + 连续空白归一 + 分段计数），复制 admin `cronLocalError` | 空串、5 段、7 段、多空格、前后空白 |
| `canSubmitEdit(form, preview)` | 名称 / 提示词非空 + `cronLocalError === ''` + `preview?.valid === true` | 各字段空、预览 null / invalid |
| `resolveOnceAfterPreview({ onceTouched, cronChanged, previewOneShot })` | Cron 改过且用户没手动拨过开关时返回 `previewOneShot`（开关跟随），否则返回 `null`（不动） | 三分支各一；`preview.valid=false` 时调用方不调用 |
| `buildUpdatePayload(form)` | trim 后构造全字段载荷；**断言式设计：不含 status 键**（§8 单测锁定，防回归误传触发 `enabling` 清零） | 首尾空白、once 布尔序列化 |

`onceMismatch` 提示文案判定（`preview.valid && cron 改过 && 开关与预览形态不一致`）也抽为纯函数 `onceMismatchWarning(form, preview, initialCron)`，返回 string | null。

### 5.4 编辑对话框（`desktop/src/components/ScheduledTaskEditDialog.vue`）

```
props:  { modelValue: boolean; task: ScheduledTask | null }   // task = 面板行快照
emits:  update:modelValue / saved(updated: ScheduledTask)
```

**打开流程**（watch modelValue → true）：

1. `resetForm()`：`buildEditForm(props.task)` 填表；`initialCron` / `onceTouched` 归零；`previewSeq++`（作废上一轮残留请求）。
2. `void refreshDetail()`：`fetchTaskDetail(task.id)` → 成功则用详情重建表单（保留用户尚未输入——实际上对话框刚打开无输入，直接重建无损失）；失败 `ElMessage.warning('任务详情获取失败，当前显示的可能不是最新')` 并用快照继续。
3. `void fetchPreview()`：立即预览当前 Cron（非防抖，与 admin resetForm 同款）。

**Cron 输入**：`@input` → `cancelPreview()` → 本地段数非法则清空 preview 返回 → 否则 400ms 防抖 `fetchPreview()`。`fetchPreview` 内 `const seq = ++previewSeq`，返回时 `seq !== previewSeq` 丢弃；`valid && !onceTouched && cron 改过` → `form.once = data.oneShot`（复制 admin :207-209 的防「一次性 Cron + 关闭开关 → 重复触发」逻辑）。

**字段与分区**：

- 名称（maxlength 200，show-word-limit）、Cron（placeholder + 6 段提示文案，照 admin 措辞）、提示词（textarea rows 8，maxlength 10000，placeholder 明示「不要写调度措辞、不要要求创建/修改定时任务」——与 agent 工具的 prompt 契约同源，防用户写出会触发 `buildScheduledPrompt` 包裹后语义打架的内容）。
- 「下次触发」行：预览 valid 时列未来 3 次 + 「（北京时间）」+ oneShot 徽标；invalid 时行内红字（`preview.message || cronLocalError || '请输入 Cron 表达式'`）。
- 一次性开关 + hint；`onceMismatchWarning` 非空时展示警告（照 admin :55-58 措辞）。
- 「高级设置」折叠（el-collapse 或自定义）：重试 0-5（el-input-number）、间隔 1-60、错过补偿单选。
- 完结任务（`task.finished`）：顶部 warning alert「该任务已完结。保存后若 Cron 能算出下次触发时间，任务会自动重新激活（恢复为进行中）。」（照 admin :9-17）；此时主按钮文案「保存并重新激活」。

**提交**：`canSubmitEdit` 守卫 + `submitting` 禁用；`buildUpdatePayload` → composable `updateTask` → 成功：`ElMessage.success(updated.nextFireTime ? \`已保存，下次触发 ${formatNextFire(updated.nextFireTime)}\` : '已保存')` → `emit('saved', updated)` → 关闭。失败（返回 null）：拦截器已 toast，对话框保持打开不改表单。

### 5.5 面板接线（`ScheduledTaskPanel.vue`）

- `task-actions` 区在 el-switch 之后、「删除」之前加 `<button class="runs-toggle">编辑</button>`（复用既有 `.runs-toggle` 朴素按钮样式，零新 CSS 依赖），点击 `openEdit(task)`。
- 组件 state：`editingTask = ref<ScheduledTask | null>(null)`；对话框 `v-model` + `:task`。
- `onSaved(updated)`：composable 已局部替换；若 `editingTask.value?.finished && !updated.finished` → `activeTab = 'active'` + `ElMessage.info('任务已重新激活，已切换到进行中')`。
- `deleteTask` 内：若 `editingTask.value?.id === id` 先 `editingTask.value = null`（C13）。
- 既有 switch / 删除 / 运行记录 / 空态 / Tab 逻辑一行不动。

### 5.6 P3 行内配置可见性（可降级，决策 8）

- `policyHint` 从「仅异值返回文本」升级为「始终返回三项当前值」：重试 N 次（N=2 时标注「默认」）/ 间隔 N 分（5 标注「默认」）/ 错过补偿文案（RUN_ONCE 标注「默认」）；异值正常色、默认值弱化（`--aw-ink-muted`）。
- 渲染处不变（仍挂 `.task-policy` 行）。
- **降级路径**：若评审认为日常噪音大于收益，P3 整体取消，`policyHint` 保持现状——P1/P2 不依赖它。

## 6. 改动面

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| backend-ts | `schedule/scheduled-task.routes.ts` cron-preview 去门（删 3 行 if + 补注释） | 唯一后端改动，零迁移 |
| backend-ts | `permission/admin-permission-gates.spec.ts` 补 cron-preview 用例 | 测试 |
| desktop | `components/ScheduledTaskEditDialog.vue`（新增，约 300 行） | P1/P2 主要工作量 |
| desktop | `components/ScheduledTaskPanel.vue`（编辑入口 + saved 处理 + 删除关对话框 + P3 policyHint） | 小 |
| desktop | `composables/useScheduledTasks.ts`（once 字段 + updateTask + fetchTaskDetail） | 小 |
| desktop | `utils/scheduledTaskEdit.ts`（新增纯函数）+ `scheduledTaskEdit.test.ts` | 中 |
| desktop | `composables/useScheduledTasks.test.ts`（扩 updateTask / fetchTaskDetail 用例） | 小 |
| mao-cli / agent-cli / admin / android | 无 | 零改动 |
| 文档 | CHANGELOG「前端（桌面 / Web / 安卓）」节；`skills/mao-cli/reference/desktop.md` 定时任务段（补编辑能力 + 三入口字段对照表，注明 mao-cli 缺 once） | 同任务完成 |

## 7. 冲突与风险详表

| # | 冲突 / 风险 | 分析 | 应对 |
|---|---|---|---|
| 1 | **cron-preview 权限门 vs 默认角色用户（核心冲突）** | 门是 `scheduled-task:read`（跨用户读语义，V121 目录原文）；V001 默认用户角色（role 2）仅 `agent:read`+`model:read`，V121 回填显式排除 role 2 → 桌面编辑预览对普通用户 403；admin 能用只因 role 1 恒有权限 | 决策 3：去门（纯计算端点，croner nextRuns 零数据访问，`requireUserId` 保留未登录 401）。备选「给 role 2 补授 scheduled-task:read」**否决**：会把跨用户查看列表/详情能力一并放出。去门后 gates spec 补用例锁定（§8） |
| 2 | **多写者并发（Agent 工具 / admin / mao-cli / 桌面）** | `update_scheduled_task` 可随时改任务；桌面对话框打开期间 Agent 可能已改 retryMax 等，全字段保存会用打开时的值覆盖 | 决策 4：打开时 GET 详情重建表单（把窗口压到最小）；接受 last-write-wins（与 admin 表单同语义，非本方案引入）；文档明示。不做字段级 diff / 乐观锁（增量成本高于收益） |
| 3 | **完结任务全字段保存的重新激活语义** | 全字段 PUT 必带 cron → 走后端 cron 分支 → 算出下一档即 `finished=0/finishedAt=null`（service.ts:435-440）。用户只想改完结任务的提示词错别字时，重新激活可能是非预期 | 完结任务对话框顶部 alert + 按钮文案「保存并重新激活」（照 admin）；保存成功 toast 带下次触发时间；决策 7 的切 Tab + 提示让结果可见。**此为 admin 既有同款语义，非新风险面** |
| 4 | **once 显式传参关闭后端自动派生** | 后端「换 cron 且未显式传 once 时按新形态重判」（service.ts:432）依赖 `once == null`；对话框始终显式传 once → 该保护对桌面路径失效，只剩前端 onceTouched/派生逻辑兜底 | 复制 admin 三件套（`onceTouched` / `initialCron` / mismatch 警告）并抽纯函数单测（§5.3）；保存后 toast 展示下次触发供用户核对 |
| 5 | 待重试一次性任务（pendingOnceRetry）守门 | 后端对「一次性 + 有待重试 + 同 cron 保存」有专门守卫防重开档期（service.ts:418-425，判据提到分支外对所有保存路径生效；`zz-logicbug-probe.spec.ts` 已固化 reactivate 绕过路径） | 桌面无需特殊处理（守卫路径无关）；回归跑既有 probe / reliability spec 全绿即证明未被破坏 |
| 6 | 预览防抖竞态 / 代际混乱 | 快速输入产生多次预览请求，乱序返回会展示过期结果 | `previewSeq` 代际丢弃（admin 同款）；0.0.353「新手引导连点串答案」是同款教训，回归可参照 |
| 7 | 本地 cron 校验 vs 服务端权威校验口径差 | 前端只查 6 段（admin 同款），更细的语义（如 `0 0 9 * * *` 五段被本地拒但服务端能容忍？）以服务端 preview / parseCron 为准 | 本地校验只做「尽早反馈」，权威判定一律以 `preview.valid` 与保存时后端异常为准；两条路径的文案都不冒充权威 |
| 8 | 保存后跨 Tab 消失 | 完结任务重新激活后从「已完结」Tab 消失，用户以为保存失败 / 任务丢失 | 决策 7：`finished` 1→0 时切「进行中」Tab + ElMessage.info；单测覆盖该分支 |
| 9 | 详情拉取失败的降级 | GET 详情失败（网络 / 会话过期）时若无降级，对话框打不开 | 降级列表快照 + warning toast（§5.4 步骤 2）；保存仍可用（后端以库内数据 patch） |
| 10 | 桌面类型与响应字段对齐 | `ScheduledTask` 缺 `once`（数据本就返回，V096）；新增字段漏声明 vue-tsc 不报（结构类型宽松），但运行期取不到 | 接口补 `once?: number \| null`；§8 断言 `buildEditForm` 对 `once=1/0/null` 三种输入的初值 |
| 11 | vue-tsc 严格模式构建 | 新组件 / 新接口 / 新方法任何类型缺口 → `npm run build` 失败（vue-tsc -b 全量检查，非单文件假通过，AGENTS.md 明令） | §6 改动面逐文件过类型；验收必跑 `npm run build`（不用 `--noEmit` 单文件替代） |
| 12 | 无组件测试基建 | desktop 无 `@vue/test-utils` 先例，组件逻辑无法直接单测 | 全部可测逻辑前置到 `scheduledTaskEdit.ts` 纯函数（§5.3）；composable 用既有 vitest + mock api 模式（`useScheduledTasks.test.ts` 先例）；组件层只留不可测的模板接线，靠人工冒烟兜底 |
| 13 | 删除任务时对话框存续 | 对话框打开中删除该任务 → 保存打到已删 id → 后端 `SCHEDULED_TASK_NOT_FOUND` → toast，体验断点 | `deleteTask` 内同 id 先关对话框（§5.5）；即使漏网，后端 404 + 拦截器 toast 兜底不白屏 |
| 14 | 重复提交 / 保存中状态 | 连点保存产生并发 PUT | `submitting` 禁用 + 按钮 loading 态（CommandEditDialog 先例）；保存期间防抖定时器 `onUnmounted(cancelPreview)` 清理 |
| 15 | 窄屏（安卓 WebView / 窄窗口）布局 | el-dialog 固定 px 宽在窄屏溢出（仓内 CommandEditDialog 用 480px 无防护） | 宽度 `min(520px, calc(100vw - 32px))`（ShareDialog 先例）；冒烟清单含窄窗口 / 安卓壳一票 |
| 16 | 三入口字段口径差（mao-cli 缺 once） | mao-cli `update` 无 `--once`（scheduled-task.js:89-131），「三种入口能力一致」严格说不成立 | 本方案不扩 CLI（范围外）；`desktop.md` 文档注明口径差；后续如需对齐是独立小改 |
| 17 | **对话框误传 status 的陷阱** | 全字段载荷若含 `status: 'ACTIVE'`，对 PAUSED 任务会触发 `enabling` 跃迁、清零连续失败计数（service.ts:464-465），改变 0.0.256 可靠性语义 | 载荷构造**不含 status 键**（§5.3）；`buildUpdatePayload` 单测断言载荷无 status；启停始终走既有 switch |
| 18 | 提示词内容契约 | 用户可能把「每天早上」等调度措辞或「修改这个任务」写进提示词，触发时经 `buildScheduledPrompt` 包裹后语义打架 | placeholder + hint 明示禁忌（照 admin 措辞）；不做强校验（Agent 工具侧同款依赖提示词契约） |

## 8. 测试要点

**后端（Vitest，既有 spec 扩展）**

- `admin-permission-gates.spec.ts` 新增：无 `scheduled-task:read`（allow 列表为空或仅 `session:read`）的登录用户 `POST /v1/scheduled-tasks/cron-preview` → `code:0` 且 service `previewCron` 被调用（mock service 同既有用例风格）；顺带锁 `expression` 非字符串仍 `PARAM_INVALID`。
- 回归全绿：`scheduled-task.service.spec.ts`（updateTask / previewCron / reactivate / enabling 清零既有用例）、`scheduled-task-reliability.spec.ts`（同 cron 保存不变量）、`zz-logicbug-probe.spec.ts`（pendingOnceRetry 绕过路径）——证明去门与保存路径零行为变化。

**desktop 单测（vitest）**

- `scheduledTaskEdit.test.ts`：§5.3 表内全部边界用例；重点两条——`buildUpdatePayload` 输出**不含 status 键**（C17 防回归）、`resolveOnceAfterPreview` 三分支。
- `useScheduledTasks.test.ts` 扩展：`updateTask` 成功后数组原位替换（mock api.put 返回新 task）、失败返回 null 且数组不变；`fetchTaskDetail` 失败返回 null；既有 statusLabel / runBadge 用例不动。

**人工冒烟清单（CONTRIBUTING 或随 PR 描述）**

1. 改周期 + 改提示词 → 保存 → 行内「下次」变化、运行历史保留、无删除重建。
2. 完结任务编辑 → alert + 「保存并重新激活」→ 保存后自动切「进行中」并提示。
3. Cron 输错（5 段 / 非法字符）→ 行内红字 + 保存禁用；输到一半不弹全局错误。
4. 一次性 Cron（`0 0 8 15 8 ?`）→ oneShot 徽标；改成循环 Cron 且未拨开关 → 开关自动跟随；手动拨过 → mismatch 警告出现。
5. 高级字段：重试 0 / 5、间隔 1 / 60、错过补偿切换后保存并回看行内（P3 启用时）。
6. **默认角色用户（无 scheduled-task:read）全流程无 403**（预览 + 保存）。
7. Agent 同时在会话里改任务 → 桌面打开对话框显示最新值（详情刷新生效）。
8. 对话框打开中删除该任务 → 对话框关闭、无报错。
9. 窄窗口 / 安卓 Capacitor 壳内对话框不溢出、可滚动。
10. mao-cli `scheduled-task update` 与桌面保存同字段，结果一致（含 admin 后台回看）。

**回归**：启停 switch（PAUSED↔ACTIVE、loading 互斥）、删除 + popconfirm、运行记录展开、双 Tab 分组、onMounted 拉取、拦截器 toast 口径、`npm run test:unit` + `npm run build` 全绿。

## 9. 验收标准

1. 桌面端 2 次点击完成「改周期 + 改提示词」；保存后行内下次触发刷新，运行历史保留，无需删除重建。
2. Cron 输错即时行内反馈；保存前可见未来 3 次触发时间（北京时间）。
3. 完结任务重新激活有明确 alert / 按钮 / toast / 切 Tab 四重提示，无「保存后任务不见了」。
4. 默认角色用户全流程无 403（预览去门生效，gates spec 锁定）。
5. 后端仅 cron-preview 去门一处改动、零迁移；调度行为零变化（三个既有 spec 全绿可证）。
6. `npm run test:unit` 与 `npm run build`（vue-tsc -b）通过；Web / 安卓端零感知（无 Electron 专属分支）。

## 10. 迁移与回滚

- **零 DB 迁移、零数据变更**。后端改动是纯权限面（去一行 if），无数据影响。
- 回滚粒度：P1/P2/P3 各自独立可退——对话框组件与面板接线整体回退即恢复现状；后端去门回滚 = 加回 3 行 if（不影响任何已存数据，仅普通用户预览重新 403）；composable 两个新方法无外部消费方可直接删。
- 发版口径：前端改动走 CHANGELOG「前端（桌面 / Web / 安卓）」节；后端去门走「后端」节一句带过（无用户可见行为变化，除桌面预览可用）。

## 11. 排期注意

1. **实施顺序**：后端去门 + gates 用例（独立小 PR，可先行合入，零风险）→ 纯函数模块 + 单测 → composable 扩展 → 对话框 → 面板接线 → P3（可降级）。P1 合入即可交付用户价值，P2 的预览联动可紧随其后。
2. **与在途方案的关系**：本方案与 session-list-navigation（0.0.351 已实施部分）、electron-shell-completeness（待评审）**无文件交集**——`ScheduledTaskPanel.vue` 全仓仅被 `router/index.ts` 引用（已核实），可并行实施。
3. **相邻收敛点**：不碰 `task-terminal.service.ts` / AgentLoop / prompt-engine / WS；`useScheduledTasks.ts` 的既有方法（toggleStatus / deleteTask / fetchRuns）零改动，只新增。
4. **文档同步**（同任务）：CHANGELOG 前端节（编辑能力 + 完结任务重新激活语义明示）+ `reference/desktop.md` 定时任务段补「编辑」与三入口字段对照表（admin 全字段含 once；mao-cli 缺 once；桌面本次补齐）；`reference/mao-agent.md` 无需动（agent 工具面未变）。
5. **后续项（不在本方案）**：mao-cli 补 `--once` 对齐口径；「以运行记录为模板新建」（创建入口仍归 Agent，产品决策不变）。

## 12. 与提案的出入说明（提案为历史文档不回改，以本方案为准）

1. **事实修正**：提案 §1.2 称 admin「只读展示下次触发、没有编辑态预览」——不准确。`ScheduledTaskFormDialog.vue:196-215` 在打开与 Cron 输入时均已调用 cron-preview（400ms 防抖 + `previewSeq` 代际丢弃）。本方案的预览联动设计直接复用该生产验证范式；「desktop 零调用」的判断不变。
2. **范围修订**：提案 §2 目标 1「一次性任务不允许改 Cron」→ 本方案决策 2 修订为「允许 + mismatch 警告 + 开关自动跟随」。理由：admin 与 agent 工具均允许、后端对 once 重判有完整逻辑，桌面禁用会制造第四种不对称；提案担心的「误改时点」由 mismatch 警告与保存后 toast 覆盖。
3. **定稿**：提案 §4.1「高级字段折叠进高级」定为默认折叠（决策 6）；提案 §4.2「权限门放宽或补授二选一」定为去门（决策 3，备选补授已否决，理由见 C1）。
4. **载荷形态定稿**：全字段 PUT 不含 status（决策 1 + C17）——提案未明确载荷构造，此处补全「不含 status」的关键约束（误传会触发启用态跃迁清零连续失败计数）。
