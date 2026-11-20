## 目标（已获用户批准）

在 `.worktrees/desktop-usage-drawer`（分支 `feature/desktop-usage-drawer`）中实施：桌面/Web 客户端顶栏新增「我的用量」图标入口，点击弹出抽屉，内含**总览 / 趋势 / 明细** 三个 Tab；明细筛选支持场景、模型、结果三个维度（设置页「使用记录」与抽屉明细 Tab 一致）。

## 实施步骤

### 0. Worktree
`git worktree add .worktrees/desktop-usage-drawer -b feature/desktop-usage-drawer main`，后续全部改动在该目录进行。

### 1. 后端（backend-ts）
- `src/usage/llm-call.repository.ts` 新增 4 个用户维度聚合方法（`WHERE user_id = ?` 强制注入，`COALESCE(SUM(...),0)`）：
  - `aggregateSummary(userId, filter)` → 调用数、成功/失败数、token 四项、成本（`SUM(cost_micros)/1000000`）
  - `aggregateByModel(userId, filter)` → 每模型（modelId/modelName、调用数、失败数、token、成本）
  - `aggregateByScene(userId, filter)` → 每场景（scene、调用数、失败数、token）
  - `aggregateTrend(userId, filter, granularity)` → day/hour 分桶（沿用 admin 口径 `DATE(created_at)` / `DATE_FORMAT(...,'%Y-%m-%d %H:00')`）
- `src/usage/llm-call.service.ts` 新增 `summaryForUser(userId, days)`（days 默认 30、钳制 1..365，`shanghaiYmd`/`addDaysYmd` 算窗口，一次返回 totals+byModel+byScene）与 `trendsForUser(userId, days, granularity)`。
- `src/usage/llm-call.routes.ts` 新增 `GET /v1/llm-calls/me/summary?days=30` 与 `GET /v1/llm-calls/me/trends?days=30&granularity=day`（均 `requireUserId`，无权限码）。
- 测试：扩 `llm-call.service.spec.ts`（mock repo：userId 注入、窗口计算、granularity 透传、days 钳制）+ repository 聚合测试（mock db.query 断言 SQL 与参数）。

### 2. 前端（desktop）
- 依赖：`echarts ^6.1.0` 入 package.json；`src/utils/echarts.ts` 按需注册（移植 admin）；`src/components/common/BaseChart.vue` 移植 admin BaseChart。
- `src/api/index.ts`：`fetchMyUsageSummary(days)`、`fetchMyUsageTrends(days, granularity)`。
- `src/components/usage/UsageFilterBar.vue`（共享筛选栏）：场景 + **模型**（拉 `GET /models/active`，value=id、label=name）+ 结果 + 查询/重置。
- `src/components/usage/UsageRecordTable.vue`（共享表格）：从 UsageView.vue 抽取；UsageView 改用筛选栏 + 共享表格，新增 modelId 传参（后端 `/v1/llm-calls/me` 已支持 modelId，零后端改动）。
- `src/components/usage/UsageDetailTab.vue`：筛选栏 + 共享表格 + 分页（size 10）+「查看完整使用记录」链接。
- `src/components/usage/UsageOverviewTab.vue`：统计卡片（调用数/总 Token/估算成本/成功率/缓存命中率）+ 按模型表 + 按场景表；成本 NULL 显示「—」加脚注。
- `src/components/usage/UsageTrendTab.vue`：ECharts 每日 Token 柱 + 成本线右轴；`buildTrendSeries` 纯函数补零（单测）。
- `src/components/usage/UsageBell.vue`：顶栏图标（28px 点击区 + tooltip「我的用量」+ TrendCharts），挂 TopNav.vue `nav-right`（InboxBell 后）。
- `src/components/usage/UsageDrawer.vue`：el-drawer（min(760px, 100vw-32px)）+ 周期 segmented（7/30/90 天）+ el-tabs 总览/趋势/明细，打开/切 Tab 懒加载。
- 测试：`buildTrendSeries` 与格式化函数单测；UsageFilterBar 组件测试（stub api 渲染模型选项、emit modelId）；抽屉 Tab 渲染测试（参照 run-trace-panel-session.test.ts stub 写法）。

### 3. 文档
- CHANGELOG.md 顶部新增 `## 0.0.259 (2026-10-10)`：后端（两个新接口）+ 前端（用量抽屉、使用记录模型筛选）。
- skills/mao-cli/SKILL.md 及 reference/analytics.md 补客户端用量抽屉说明。

### 4. 验收
- `cd backend-ts && npm run build && npm test`（日志落盘后 grep 摘要）
- `cd desktop && npm run build`（vue-tsc）+ `npm run test:unit`

### 5. 提交
在 worktree 分支提交并推送 origin。