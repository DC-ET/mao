# 提案：花出去的钱看得见 —— 个人用量预算的用户面可见性

> 预算体系 0.0.243 起全量运行：管理员设额度、执行前拦截、越线提醒——但全部能力长在 admin 域。普通用户今天只能被动收到一条「预算提醒」，没有任何入口回答「我这个月还能用多少」「为什么刚才任务被拦」「什么时候重置」。治理越严，用户越糊涂。

- 状态：待评审（第十七批，2026-10-26）
- 日期：2026-10-26
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（P1 约 1-2 人日、P2 约 1-2 人日、P3 约 1-2 人日；零迁移，执行链路零改动）
- 关联：`backend-ts/src/budget/`、`shared/contracts`、`desktop/src/components/usage/`

## 1. 背景与现状

### 1.1 预算执行链路已就绪，可见性为零（代码可查）

0.0.243 实施的预算管控（V139 `usage_budget` 表）：

| 环节 | 实现 | 位置 |
|---|---|---|
| 额度配置 | scope GLOBAL / USER / AGENT × period MONTHLY × limit_type COST / TOKENS × action WARN / BLOCK | `budget.service.ts:182-254`（list / create / update / remove） |
| 执行前拦截 | `checkAdmission` | `budget.service.ts:92` |
| 越线提醒 | `settleWarn` → 收件箱 `BUDGET_WARN` + 偏好开关 | `budget.service.ts:120`、`backend-ts/src/inbox/types.ts:15` |

**但全部 REST 端点在 admin 域**：`budget.routes.ts` 只有 `/v1/admin/budgets` CRUD（:21-55），`budget:read` / `budget:write` 权限按 V139 默认只授系统管理员。

### 1.2 用户侧的三个「答不上」

- 「我这个月还能用多少」——没有额度 / 已用 / 重置日的查看入口；用户只能在收件箱被动收一条提醒（`NotificationSettingsView.vue:159` 有开关，仅此而已）。
- 「为什么刚才任务被拦」——被 BLOCK 拦截时只有一个错误码，用户无法自查是全局额度见底还是本人额度见底。
- 「什么时候恢复」——MONTHLY 周期下月重置，但用户不知道重置日，只能等。

### 1.3 成本口径天然同源，缺的只是一个只读面

- 桌面已有用量抽屉（`UsageDrawer.vue`：总览 / 趋势 / 明细三 Tab，消费 `/llm-calls/me*`，`desktop/src/api/index.ts:919-943`），成本口径（`cost_micros`）与预算 `limit_type=COST` 完全同源；「预算」是 UsageDrawer 的第四个 Tab，不是新页面。
- 当期消耗计算可复用 `BudgetService.getPeriodSpend`（:81，settleWarn 同款），不新造统计口径——这正好接上摸底发现的「三套统计口径并存」隐患的反面：**预算消耗只应有一个算法**。

### 1.4 一个真实场景

团队给新用户设了月度 200 元 BLOCK 预算。25 号起他的新任务全部被拦，界面只有一句「预算拦截」。他看不到额度、已用、重置日，先怀疑系统故障、提了工单，管理员截图 admin 后台才解释清楚。成本治理对用户成了黑盒——**治理越严，困惑越多，管理员解释成本越高**。

## 2. 目标 / 非目标

**目标**

1. **P1 只读端点**：`GET /v1/me/budgets`（命名见待确认 3）返回对当前用户生效的预算——GLOBAL + 本人 USER scope（AGENT scope 见待确认 2）；每项含 limit_type / limit_value / action / period + 当期已用（复用 `getPeriodSpend`）+ 下次重置时间 + 状态（正常 / 已提醒 / 已拦截）。
2. **P2 桌面「预算」Tab**：UsageDrawer 新增第四个 Tab；进度条（已用 / 上限，WARN 黄、BLOCK 红，色调参考上下文抽屉三段式先例）+ 预算卡片列表；被拦截任务的错误提示增加「查看我的预算」入口。
3. **P3 归因深化**：按 Agent 拆解当期消耗（哪个 Agent 花的量）；常用 Agent 命中 AGENT scope 预算时轻提示「该 Agent 本月预算已用尽」（不给额度数字）；BUDGET_WARN 收件箱消息加跳转链接到本 Tab。

**非目标**

- 不让用户自建 / 修改 / 停用预算（治理权在管理员，admin CRUD 不动）。
- 不做历史月份预算报表（当期 + 既有明细 Tab 已够；历史消耗在明细里）。
- 不做预算趋势外推 / 预测（消耗曲线在趋势 Tab）。
- 不动计费口径、不动 `checkAdmission` / `settleWarn` 执行链路一行。
- 不做预算超支的二次确认弹窗（拦截已由执行链路负责）。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 月度用量预算（0.0.243 已实施） | 那是管理端配置 + 执行链路；本提案是它的用户面可见性，零执行改动。 |
| 每日运营摘要（0.0.281 已实施） | 日报是全局 / 运营口径的聚合推送；本提案是个人当期口径的自助查看，互补不重叠。 |
| 用量成本核算（0.0.243 同批实施） | 成本落账已就绪；本提案不改造账，只把账本翻给用户看。 |
| 数据保留与可携带（已否决） | 不导出用户数据、不做删除权，纯只读视图。 |
| 出站订阅 / 邮件通知（已实施） | 不新增通知渠道，只加站内跳转。 |

## 4. 技术方案

### 4.1 后端只读端点（P1）

- 新路由 `GET /v1/me/budgets`（或 `/v1/usage/budgets`，与 `/llm-calls/me` 同域风格，见待确认 3），任何登录用户可调，无需新权限码（只看 GLOBAL + 本人）。
- 服务方法 `listApplicable(userId)`：查 `usage_budget` enabled 行中 `scope IN ('GLOBAL', 'USER')` 且（GLOBAL 或 scope_id = 本人）→ 每项调 `getPeriodSpend` 算当期消耗 → 组装 VO。
- VO `BudgetStatusVO`（limitType / limitValue / action / period / scope / scopeId / periodSpend / resetAt / status）下沉 `@mao/contracts`——按规范跨端类型走契约；admin 后续若要做用户视角可直接复用。
- 零迁移：`usage_budget` 与 `llm_call` 全部既有数据。

### 4.2 桌面「预算」Tab（P2）

- UsageDrawer 增加第四个 Tab「预算」；总览页可加一条预算进度摘要（与 Tab 数据同源，一次请求两处消费）。
- 进度条：已用 / 上限 + 百分比；WARN 档黄色、BLOCK 档红色、已拦截置顶；无预算时显示友好空态（「当前没有预算限制」或引导联系管理员，按 readiness 同款根因分流思路）。
- 拦截联动：预算拦截错误提示（既有拦截路径）加「查看我的预算」动作，跳到本 Tab。

### 4.3 归因与跳转（P3）

- 按 Agent 拆分当期消耗：复用 `/llm-calls/me` 的 agent 维度（明细 Tab 已有 agent 筛选口径），展示「本期消耗 Top Agent」。
- AGENT scope 轻提示：用户常用 Agent（如其历史调用 Top N）命中启用中的 AGENT 预算且已 BLOCK 时，在对应行显示「本月预算已用尽」——不暴露额度数值（见待确认 2）。
- BUDGET_WARN 收件箱消息体增加跳转（inbox 条目跳转机制既有，任务类消息已用）。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | 只读端点 + VO 下沉 + 服务方法 | 1-2 人日 |
| P2 | 桌面预算 Tab + 拦截联动 | 1-2 人日 |
| P3 | Agent 归因 + AGENT 轻提示 + 收件箱跳转 | 1-2 人日 |

**改动面**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| backend-ts | `budget/`（新路由 + 服务方法 + repository 查询） | 小 |
| shared/contracts | `BudgetStatusVO` 下沉 | 小 |
| desktop | `usage/`（新 Tab 组件 + api）+ 拦截提示跳转 | 中 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| getPeriodSpend 每请求实时 SUM 聚合 | 低 | 单月 llm_call 量级可控；加 30-60s 进程内缓存即可，不建新统计表 |
| GLOBAL 额度对普通用户可见是否敏感 | 中 | 倾向可见：额度不是秘密，「知道天花板」优于「黑盒拦截」；见待确认 1 |
| 多档叠加（GLOBAL + USER + AGENT 同时命中） | 中 | 与 `checkAdmission` 判定顺序一致：最严一档做主卡片，其余折叠展示 |
| 周期边界口径 | 低 | MONTHLY 按服务器时区自然月，与用量抽屉 range 工具同口径，不新造 |
| 新端点被当 CRUD 误用 | 低 | 只读 + 契约名 `BudgetStatusVO`（非管理 VO），文档注明管理端仍走 admin 端点 |

**待确认决策**

1. GLOBAL 预算额度对普通用户可见（推荐）还是只显示「已启用全局预算」状态条？
2. AGENT scope 预算：P3 的「该 Agent 本月预算已用尽」轻提示是否做（不暴露数字）？若团队认为 Agent 级额度属内部治理信息，可只做 GLOBAL + USER。
3. 端点命名与归属：`/v1/me/budgets`（推荐，与 `/llm-calls/me` 的「me」风格一致）vs `/v1/usage/budgets` vs 并入 `/llm-calls/me/summary`（summary 响应已重，不推荐并入）。

## 7. 测试要点

- 组合：仅 GLOBAL / 仅 USER / 双档叠加 / 无预算四种装配下展示与状态色。
- 实时性：造数后刷新，已用随之变化；WARN 越线后状态从「正常」转「已提醒」。
- 拦截联动：构造 BLOCK 见底，任务被拦提示含「查看我的预算」且跳转正确。
- 口径：当期消耗与 admin 后台对同一用户的展示一致（同 `getPeriodSpend` 可证）；跨月边界用当月数据断言自然月口径。
- 权限：普通登录用户可调；未登录 401；admin CRUD 回归不受影响。
- 契约：`BudgetStatusVO` 双端编译期对齐（desktop + backend）。

## 8. 验收标准

1. 用户打开用量抽屉即见当期额度 / 已用 / 重置日 / 状态，无需找管理员。
2. 任务被预算拦截时，用户 2 次点击内能到达预算页并看懂原因。
3. 后端零迁移、`checkAdmission` / `settleWarn` 执行链路零改动（评审可核）；消耗口径与 admin 一致（同一算法）。
4. 无预算用户看到友好空态而非报错或空白。
