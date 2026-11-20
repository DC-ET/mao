# usage-cost-budget 前端（admin + desktop）与 P3 压缩模型独立配置 · Round 1 审查（2026-10-08）

- 审查对象：单提交 `25717737 feat(usage): 用量成本核算与预算管控（P1 计价/P2 预算/P3 压缩模型独立配置）`（相对 main）
- 范围：仅本 worktree（`/Users/yangjiayi/AiProjects/mao/.worktrees/usage-cost-budget`）内被指定文件——admin（`views/analytics/types.ts`、`chart-options.ts`、`utils/llmCallLabels.ts`、`OverviewTab/TrendsTab/ModelTab/UserTab/AgentTab.vue`、`LlmCallView.vue`、`ModelFormDialog.vue`、`budget/BudgetView.vue`、`router/index.ts`、`SideMenu.vue`）；desktop（`components/inbox/InboxDrawer.vue`、`composables/useInboxSystemNotify.ts`、`stores/inbox/index.ts`、`views/NotificationSettingsView.vue`）；后端 P3（`harness/tool/compaction-model-resolver.ts` + spec、`harness/core/session-compaction-orchestrator.ts`、`settings/settings.service.ts` 的 `compaction.modelId`、`create-app.ts` 装配）。
- 方法：读码 + 数值推演；`cd admin && npm run build`、`cd desktop && npm run build` 均 exit=0；`desktop` inbox 单测 32 passed、backend `compaction-model-resolver` / `budget` / orchestrator 相关 spec 57 passed；仅用一个已删除的临时测试文件确证 kind 白名单缺陷（未改动任何被审源码）。
- 结论：**发现 2 个功能性 BUG（高 1 / 中 1）**，另有 1 条低危观察。

---

## BUG 1（高）：desktop 收件箱 kind 白名单漏 `BUDGET_WARN`，预算提醒在桌面端既不渲染也不触发系统通知

**文件:行号**：`desktop/src/stores/inbox/index.ts:16-22`（`KNOWN_INBOX_KINDS`），影响面 `:28-30`（`isKnownInboxKind`）、`:63-64`（`visibleItems` getter）、`:114`（`peekInboxFirstPage` 的 filter）

**问题描述**：

```ts
/** 收件箱 kind 封闭集合：与契约枚举、后端写入白名单一致。 */
const KNOWN_INBOX_KINDS = new Set<string>([
  'TASK_COMPLETED',
  'TASK_FAILED',
  'QUESTION_PENDING',
  'APPROVAL_PENDING',
  'SUBAGENT_DONE'
])
```

本提交给契约 `InboxKind`、后端 `inbox/types.ts:15` 的 `INBOX_KINDS`、desktop `InboxDrawer.vue:33` 的 `KIND_META`、`useInboxSystemNotify.ts:40` 的偏好映射都补了 `BUDGET_WARN`，但 desktop store 的这个**渲染/通知白名单没同步加**——而注释恰恰写着"与契约枚举、后端写入白名单一致""新增 kind 时只改这里"，实现与注释不符。

`isKnownInboxKind` 有两处消费，两处都会被这个 kind 打掉：
- `visibleItems`（`:64`）：`state.items.filter((item) => isKnownInboxKind(item.kind))`，`InboxDrawer.vue` 直接渲染 `visibleItems` → BUDGET_WARN 条目永远不进列表；
- `peekInboxFirstPage`（`:114`）：同样 filter → 系统通知 diff 永远看不到 BUDGET_WARN 条目（`formatNotification` 的 `case 'BUDGET_WARN'` 分支形同死代码）。

服务端未读数是权威 COUNT（`fetchInboxUnreadCount`，红线 #2，前端禁本地推导），不受此白名单影响，于是形成"角标数字 > 0、打开抽屉却没有对应条目"的自相矛盾状态。临时在 `/tmp` 下按 vitest include 规则（`src/**/*.test.ts`）建的探针实跑确认：`isKnownInboxKind('BUDGET_WARN')` 返回 `false`（断言 `expect(false).toBe(true)` 失败），探针已删除。

**业务影响**：预算 WARN 触发的站内提醒与管理员的系统通知在桌面端完全静默——用户只看到未读角标跳动、点开是空的，属于 P2 预算管控"触达"闭环在桌面端整体失效。后端侧（`budget.service.ts` 写 inbox、`inbox.repository.ts` 的 `budget_warn_enabled` 列、`InboxPreference` 默认 `true`、`NotificationSettingsView.vue` 的开关与保存）全部正确，缺的只有这一处。

**复现方式**：
1. 建一条 `WARN` 预算（如 GLOBAL / COST / 上限 100），当期消耗越过上限；
2. 触发任意一次 Agent 任务终态（WARN 在终态结算），后端写入 BUDGET_WARN inbox 条目并推 `inbox_updated`；
3. 桌面端观察：顶栏未读角标 +1，但打开收件箱抽屉列表为空（`visibleItems` 被过滤）；窗口失焦时不弹系统通知（`peekInboxFirstPage` 被过滤）。

或直接跑 store 导出函数：`expect(isKnownInboxKind('BUDGET_WARN')).toBe(true)` → 当前返回 `false`。

**修复方向**：`KNOWN_INBOX_KINDS` 补 `'BUDGET_WARN'`（顺带注意 `TRIGGER_DISABLED` 也缺，该 kind 后端 `INBOX_KINDS` 已包含、同样会被过滤——但它在 main 上就缺，属既有问题，非本提交引入）。

**严重度**：高（功能整体不可见，且角标与列表不一致；修复一行字符串即可）。

---

## BUG 2（中）：BudgetView `spendPercent` 分子分母单位不一致，COST 预算进度恒 0%、越线标签永不出现

**文件:行号**：`admin/src/views/budget/BudgetView.vue:209-213`（`spendPercent`），连带 `:215-220`（`progressColor`），模板消费点 `:42`（el-progress percentage）、`:45`（color）、`:48`（`（{{ spendPercent(row) }}%）`）、`:49-50`（`BLOCK 已生效` / `WARN 已越线` 标签）

**问题描述**：

```ts
function spendPercent(row: BudgetRow): number {
  const spend = row.periodSpend
  if (spend == null || row.limitValue <= 0) return 0
  return Math.min(100, Math.round((spend / row.limitValue) * 1000) / 10)
}
```

后端 `BudgetService.list()`（`backend-ts/src/budget/budget.service.ts:205` 附近）返回的列表行里：
- `row.limitValue` 是**微单位原值**（`limit_value` 列，成本 ×1e6）；
- `row.periodSpend` 对 COST **已做单位换算**：`item.periodSpend = spend == null ? null : (limitType === 'COST' ? spend / 1_000_000 : spend)`，即已是**成本单位**。

同一文件其它函数的处理都是对的：
- `formatLimit`（`:196-201`）COST 走 `formatCost(row.limitValue / 1000000)` → 先除 1e6，正确；
- `formatSpend`（`:203-207`）COST 走 `formatCost(spend)` → 不再除，正确；
- `openEdit`（`:253`）COST 走 `row.limitValue / 1000000` 回填、`buildPayload`（`:275` 附近）再 `* 1e6` 提交，往返正确。

只有 `spendPercent` 把**已换算的分子**除以**未换算的分母**，比值被系统性地缩小 1e6。

**业务影响**（COST 预算；TOKENS 预算两值同为 token 数，不受影响）：
- 进度条永远 ~0%（例：上限 100、当期已用 150 → `150 / 100_000_000 = 1.5e-6` → `Math.round(1.5e-3)/10 = 0`），颜色恒为绿色 `#67c23a`；
- `:49-50` 的 `BLOCK 已生效` / `WARN 已越线` 判定 `spendPercent(row) >= 100` 永不成立 → 预算是否越线的关键状态标识在管理后台彻底失效，管理员只能靠眼比对文本数值。

**复现方式**：新增一条 COST 预算（scope GLOBAL，上限填 `100`，action BLOCK），制造 ≥100 的当期消耗后进「管理后台 / 用量预算」：文本显示 `¥150.00 / ¥100.00`，同一行进度条为空、显示 `（0%）`、进度条为绿色，"BLOCK 已生效"标签不出现。（admin 未安装 vitest，无法给可执行单测，只能按上述步骤人眼确认。）

**修复方向**：`spendPercent` 内对 COST 先把上限换算到成本单位（与 `formatLimit` 同口径），例如

```ts
function spendPercent(row: BudgetRow): number {
  const spend = row.periodSpend
  if (spend == null || row.limitValue <= 0) return 0
  const limit = row.limitType === 'COST' ? row.limitValue / 1000000 : row.limitValue
  return Math.min(100, Math.round((spend / limit) * 1000) / 10)
}
```

**严重度**：中（数据与门控本身正确，仅进度/颜色/越线标签错误，但"是否越线"是预算页的核心观感，且会误导管理员判断预算是否已生效）。

---

## 观察 1（低）：`compaction.modelId` 在系统设置页只能手填模型 ID，且落入"其他"分组

**文件:行号**：`admin/src/views/settings/SystemSettingsView.vue:184`（`MODEL_SELECT_KEYS` 不含 `compaction.modelId`）；分类来源 `V136__usage_budget.sql` 种子行（category=`运行参数`）

**问题描述**：`compaction.modelId` 是 `editable=1` 的普通文本项，既不在 `INTEGRATION_KEYS`（走集成面板）也不在 `MODEL_SELECT_KEYS`（本应渲染成模型下拉），于是按字符串类型输入渲染；同时 `TOC_GROUPS` 未声明"运行参数"分类，该分类被 `unknown` 分支归入"其他"分组。同目录下 `MODEL_SELECT_KEYS` 已含 `embedding.modelId`、`approval.modelId`，明显是同步新增时漏了这一个。

**业务影响**：功能可用（填对模型 ID 即可生效，P3 resolver 会校验），但管理员输入体验差、易填错 ID，且在设置页里位置不直观。属低危 UX/可用性问题，不阻断功能。

**修复方向**：把 `compaction.modelId` 加进 `MODEL_SELECT_KEYS`（并在 `TOC_GROUPS` 声明"运行参数"分类）。

---

## 重点核对项与通过结论

1. **后端契约字段名/单位换算**：逐字段比对 `admin-analytics.service.ts` 与前端读取，全部一致——`sumTrends` 的 `totalCost`（`previousTotals.totalCost` 同源）、趋势点 `cost`、`selectLlmCall*` 的 `COALESCE(SUM(cost_micros),0)/1000000 AS cost`、`qualitySummaryFields.cost`、llm-call 明细 `costMicros`；前端 `formatCostCell/formatCost(costMicros/1000000)`、CSV 导出 `(costMicros/1e6).toFixed(6)` 口径统一。cost 可为 `null`（未配价格）时显示 `'-'`，`formatCost(null)` 返回 `'-'`。
2. **HUGE 数字/精度**：`formatCost`（`llmCallLabels.ts`）绝对值 ≥10000 走 `maximumFractionDigits: 0`、≥1 走最多 3 位小数，非有限数走 `toFixed(2)`；无 NaN/Infinity 泄漏路径（costMicros 为 null 已在前置分支拦掉）。`IntentGroup` label 前缀用 `>=1000000` 而不是 `>1000000`，空 label 时不产生裸 `3.00`，正确。
3. **表格列 vs CSV 列顺序**：LlmlCall 表（时间/用户/场景/模型/入Token/出Token/成本/缓存/流式/首字/总耗时/结果/操作）与 CSV（同序 + 耗时、去掉场景/操作）一致；ModelTab / UserTab / AgentTab 的 CSV 列序均与表头一致（均只去掉「占比 / 最后登录操作」类交互列）。CSV 转义与 BOM 走共用 `exportCsv`。
4. **BudgetView 表单校验/提交**：`scopeId` 仅在 `scope !== 'GLOBAL'` 时渲染并有 required 校验器；`limitInput × 1e6` 用 `Math.round`；GLOBAL 至多一条由后端 `BusinessException`（拦截器提示"至多一条"）；读写权限分离正确（route/menu `budget:read`，写按钮 `budget:write`，与 `V136` 授予 role 1 的两个权限码字符串完全一致）；编辑回填（含目标已删除时补 `targetName` 占位）与删除/启停确认均在。仅 `spendPercent` 单位不一致（见 BUG 2）。
5. **ModelFormDialog**：价格输入仅 `modelType === 'text'` 时出现（`v-if="isTextType"`），非文本在 `submit` 前被强制置 `null`；编辑时空值即 `null` → 后端按"清空=不计成本"落 `price_output` 为 NULL，与后端注释语义一致；掩码 API Key 走 `password-only` 字段专用输入。`el-input-number` 的 `precision` 由 props 控制、nil/NaN 显示空串，空态占位正常。
6. **desktop 收件箱**：`KIND_META` 中文名/图标、`budgetWarnEnabled` 默认 `true`（与后端 `DEFAULT_PREFERENCE` / V136 `DEFAULT 1` 一致）、`useInboxSystemNotify` 的 `BUDGET_WARN → preference.budgetWarnEnabled` 映射、`NotificationSettingsView.vue` 保存 `{...inboxForm}` 全量字段、旧偏好行缺列时 `Number(row.budgetWarnEnabled ?? 1) === 1` 不崩——全部正确。唯独 store 白名单漏 kind（见 BUG 1）。
7. **P3 压缩模型独立配置**：`CompactionModelResolver` 四种回退（未配置/非数字/模型已删/模型停用 status≠1/模型非文本）+ 顶层异常兜底全部实现，spec 覆盖到"设置缺失视为未配置"与"模型/设置查询抛错回落"；orchestrator 三处（`compactSession`、`persist`、`record`）均传同一个 `compactionModelConfig`，`scene=compaction` 的 `llm_call.model_id` 与记录/落库三方一致；`create-app.ts` 的 resolver 装配（`(key)=>settingService.getValue(key)`、`(id)=>modelRepo.findById(id)`）与第 9 参传入 orchestrator 正确；`settings.service.ts` 已把 `compaction.modelId` 纳入模型 ID 校验分支。未发现 P3 功能性 BUG。
8. **构建/测试**：`cd admin && npm run build` exit=0；`cd desktop && npm run build` exit=0；desktop inbox 相关 32 passed；backend `compaction-model-resolver` / `budget` / orchestrator 相关 57 passed。
