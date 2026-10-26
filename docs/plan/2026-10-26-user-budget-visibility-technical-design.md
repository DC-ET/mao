# 个人用量预算用户面可见性技术方案

> 版本：v1.0（2026-10-26）
> 状态：待评审（提案见 [../proposals/2026-10-26-user-budget-visibility.md](../proposals/2026-10-26-user-budget-visibility.md)，第十七批）
> 一句话：新增只读端点 `GET /v1/me/budgets` + 桌面用量抽屉「预算」Tab + 收件箱 BUDGET_WARN 跳转，把 0.0.243 起运行在 admin 域的预算额度、当期消耗、周期重置时间翻给普通用户看；**零迁移、执行链路零改动、admin / mao-cli / agent-cli 零改动**。

## 0. 待确认决策（评审逐条定）

| # | 决策点 | 推荐定稿 | 说明 |
|---|--------|----------|------|
| 1 | 端点命名与归属 | `GET /v1/me/budgets`，注册在 `budget.routes.ts` | 与 `/v1/llm-calls/me*`（`llm-call.routes.ts:65/85/95`）的「me」风格一致；注册在 budget 域**零装配改动**（`app-routes.ts:615` 不变）——若塞进 llm-call.routes.ts 则要给该路由组新增 budgetService 依赖，动了 usage 域装配 |
| 2 | 返回范围 | GLOBAL + 本人 USER scope 的 **enabled** 行 | AGENT scope 不进 v1（决策 3）；停用行不返回（"已停用"是管理噪音，admin 页可见）；USER 行按 `scope_id = 本人` 过滤，天然无越权面 |
| 3 | AGENT scope 处理 | v1 不返回；P3 可选「常用 Agent 本月预算已用尽」轻提示（不带额度数字） | Agent 级额度属团队治理信息；轻提示是否做、以何口径暴露，另评 |
| 4 | 单位口径 | VO 内 COST 的 `limitValue` 与 `periodSpend` **同为成本单位** | admin 列表 `limitValue` 是微单位、`periodSpend` 是成本单位，前端被迫自除（`BudgetView.vue:209-218` 注释记录了"比值恒小 1e6、进度条永远 0%"的差点事故）；用户面 VO 从根上去掉该不对称 |
| 5 | 状态派生 | 服务端派生 `status: 'NORMAL' \| 'WARNED' \| 'BLOCKED'` | BLOCKED = action=BLOCK 且越线；WARNED = action=WARN 且越线；前端不做口径判断，只做展示 |
| 6 | 周期口径 | 月度（服务器本地时区当月 1 日 00:00 起），VO 带 `period`（yyyy-MM）与 `resetAt` | 与 admin 预算页 hint（`BudgetView.vue:8`）、`monthStartLocal`（`budget.service.ts:51`）同口径；`resetAt` 服务端算好原样展示，不在前端做时区换算 |
| 7 | Tab 与抽屉周期选择器 | 预算 Tab 固定月度，**不消费** `range` | 两种周期语义混用比没有更糟；Tab 内自标周期与重置日；刷新走 `refreshKey` 令牌 |
| 8 | 缓存 | 不加 | 单次 1-2 条 SUM（与 `checkAdmission` 同款已上线查询，`budget.repository.ts:95-118` 有索引说明）；缓存失效复杂度大于收益 |
| 9 | 查询失败语义 | 整请求失败（500 → 拦截器 toast + Tab 内错误态可重试） | 与 admin `list()` 的 `safeSpend` 容错（null）**刻意不同**：个人视图部分数据缺失会误导（"看起来才用 10%"），宁缺毋假 |
| 10 | 收件箱跳转 | BUDGET_WARN 点击 → 打开用量抽屉并切「预算」Tab | 现状点击 BUDGET_WARN 得到「该通知没有关联会话」（`InboxDrawer.vue:99-102`；`sessionId` 恒 null，`inbox.service.ts:295`）——本方案顺带修掉这个现存死端 |
| 11 | 拦截横幅跳转 | P3 **可选**；用 window 事件 + ExecutionErrorBanner 可选 prop，**不动 store** | 直接 BLOCK 不写收件箱（`noticeQueueBlocked` 仅队列消费路径，`budget.service.ts:169`），横幅文案已含消耗/上限数字（`budgetBlockMessage`，`streaming-ws-handler.ts:231-235`）；跳转是便利增量，误差面敏感，列为可选、不做也完整 |
| 12 | mao-cli 是否补命令 | 不做 | 桌面优先；CLI 用户面命令（如 `budget me`）留作独立小任务，不混入本方案评审面 |

## 1. 需求背景

提案 §1 已论证。代码侧事实已在本方案定稿前逐条核实（行号均为 2026-10-26 实测）：

**预算执行链路完整、可见性为零**

- 表与配置：`usage_budget`（V139 迁移：scope GLOBAL/USER/AGENT × period MONTHLY × limit_type COST/TOKENS × action WARN/BLOCK × enabled）。
- 准入拦截：`BudgetService.checkAdmission`（`budget.service.ts:92`）——enabled BLOCK 行按 GLOBAL → USER → AGENT 逐一比对，命中即拒；WS 路径显式发 error 帧早退（`streaming-ws-handler.ts:596-604`，消息不落库不入队），开放接口路径经 `budgetCheck` 复用同一判定（`app-openapi-services.ts:80-84`）。
- 越线提醒：`settleWarn`（`budget.service.ts:120`）任务终态后按 WARN 行写 `BUDGET_WARN` 收件箱（`inbox.service.ts:277-305`，dedup tail = `budgetId:period`）。
- 管理面：CRUD 全在 admin 域（`budget.routes.ts:21-59`，`budget:read`/`budget:write` 权限按 V139 默认只授管理员）+ admin 预算页（`views/budget/BudgetView.vue`，进度条 / 越线标签 / 停用启停）。

**用户侧的三个"答不上"与一个死端**

- 无入口：普通用户没有任何页面回答"本月额度 / 已用 / 重置日"；`NotificationSettingsView.vue:159` 只有 BUDGET_WARN 的开关。
- 死端：BUDGET_WARN 收件箱条目 `sessionId` 恒为 null（无会话关联），点击走 `InboxDrawer.vue:99-102` 的"该通知没有关联会话"警告——**提醒发出了，用户点进来却什么也做不了**。
- 直接 BLOCK 时横幅有数字无全貌：`budgetBlockMessage`（`streaming-ws-handler.ts:231-235`）已带当期消耗/上限，但没有额度全貌、重置日、WARN 档存在性。
- 被拦时刻才知情：WARN 档用户直到越线提醒进收件箱才知道有预算这回事。

**现成地基（本方案"零新增基础设施"的根据）**

- 消耗计算单一口径：`BudgetService.getPeriodSpend`（`budget.service.ts:81`）+ `BudgetSpendStore`（`budget.repository.ts:99-118`，USER 走 `idx_llm_call_user_created`、GLOBAL 走 `idx_llm_call_created` 范围扫描）——admission / settleWarn / admin 列表共用，本方案第四次复用，不新造统计口径（摸底发现的"三套统计口径并存"隐患因此不扩大）。
- 用户面 me 端点先例：`/v1/llm-calls/me*`（`llm-call.routes.ts:65-108`）——`requireUserId` 登录即可、不加权限码；路由 spec 用 Fastify inject + preHandler 注入 `req.userId`（`budget.routes.spec.ts:8-22` 同款 harness）。
- 契约下沉先例：`shared/contracts/src/readiness.ts`（ReadinessVO，desktop + admin 双端经 tsconfig path / vite alias 消费，`desktop/tsconfig.app.json:8`、`desktop/vite.config.ts:34`）。
- 跨组件打开用量抽屉的既有机制：`window` 事件 `open_usage_drawer`（`UsageBell.vue:11-15` 监听；`InboxDrawer.vue:135-139` 摘要详情"查看用量"已在派发）——扩展 detail 即可带 Tab 参数，向后兼容。
- 桌面用量抽屉三 Tab（总览 / 趋势 / 明细）与 `refreshKey` 刷新令牌、`formatCost` 等展示工具（`UsageDrawer.vue:55-65`、`components/usage/usageFormat.ts`）全部就绪。

## 2. 需求描述

### 2.1 目标

1. **P1 只读端点 + 契约**：`GET /v1/me/budgets` 返回对本人生效的 enabled 预算（GLOBAL + 本人 USER），每项含口径、上限、当期消耗、派生状态、周期标签、重置时间；`MyBudgetItemVO` 等类型下沉 `@mao/contracts`。
2. **P2 桌面「预算」Tab + 跳转**：UsageDrawer 新增第四个 Tab（固定月度、不跟周期选择器）；BUDGET_WARN 收件箱条目点击跳转本 Tab（修死端）。
3. **P3 归因与便利（可选独立上线）**：预算 Tab 内按 Agent 拆分当期消耗（复用 `/llm-calls/me/summary?range=month` 的 byAgent，零后端改动）；直接 BLOCK 横幅加"查看我的预算"跳转（window 事件 + 可选 prop，不动 store）。

### 2.2 范围边界

| 维度 | 做 | 不做 |
|---|---|---|
| 后端 | 新路由 + 新 repo/service 方法 + 契约文件 | 不动 `checkAdmission` / `settleWarn` / `noticeQueueBlocked` / admin CRUD 一行；不加权限码；零迁移 |
| 契约 | 新增 `budget.ts`（枚举 + VO），index.ts 加一行导出 | 不改既有联合类型与文件 |
| desktop | api 函数、`UsageBudgetTab`、`budget-status.ts` 纯函数、Drawer/Bell/InboxDrawer 各最小改动 | 不动既有三个 Tab 的行为与周期选择器；不改 store（含 error 存储） |
| admin | 零改动 | 不自建"用户视角"页（与桌面分工不变） |
| mao-cli / agent-cli | 零改动 | 不补用户面命令（决策 12） |
| 通知 | 零改动 | 不新增 kind / 渠道 / 偏好（BUDGET_WARN 既有） |

## 3. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| 端点注册位 | `budget.routes.ts` 内新增 `/v1/me/budgets` | 预算域内聚；`app-routes.ts:615` 装配零改动（决策 1） |
| 鉴权 | `requireUserId`（`common/http-error.js`，llm-call.routes.ts:2 同款 import） | 只读本人 + GLOBAL 数据，无需权限码；与 me 端点先例一致 |
| 行查询 | repo 新增 `listApplicableToUser(userId)` | 既有 `list(filter)` 只支持单 scope 过滤（`budget.repository.ts:38-55`），不适配"GLOBAL OR 本人 USER"；新方法不动旧方法 |
| 消耗计算 | 复用 `getPeriodSpend` + 私有 `displaySpend`（同类内调用） | 单一口径第四次复用；单位换算与服务端既有展示口径一致 |
| 状态派生 | 服务端算 `status` | 前端不判断越线口径（决策 5）；WARN/BLOCK 语义只有服务端全貌 |
| 契约 | `shared/contracts/src/budget.ts` 新增文件 | 一域一文件先例（readiness.ts / signal.ts）；AGENTS.md 跨端类型走契约 |
| 桌面 Tab | `UsageBudgetTab.vue` + `budget-status.ts` 纯函数（+ `.test.ts`） | 纯函数可测（Node 无 DOM 环境）；组件测试沿用 `UsageDetailTab.test.ts` 的源码/AST 套路 |
| 跨组件跳转 | 扩展 `open_usage_drawer` 事件 detail（`{ tab }`）+ nonce 防重复同值 | 既有机制（UsageBell.vue:11-15）；nonce 保证连续两次同 Tab 跳转都生效（C8） |
| 失败语义 | 整请求失败 + Tab 错误态重试 | 决策 9：个人视图宁缺毋假 |

## 4. 总体架构

```
┌──────────────────────── 后端（全部新增，零改动既有） ────────────────────────┐
│ GET /v1/me/budgets          requireUserId（无权限码）                        │
│   └─ BudgetService.myBudgets(userId)                                        │
│        ├─ BudgetRepository.listApplicableToUser(userId)   ← 新方法          │
│        │    WHERE enabled=1 AND (scope='GLOBAL' OR (scope='USER' AND id=?)) │
│        └─ getPeriodSpend() ← 既有（SUM llm_call，与 admission 同款）        │
│ V139 usage_budget（既有）＋ llm_call（既有）——零迁移                        │
└───────────────────────────────────────────────────────────────────────────┘
                 │ Result<MyBudgetsVO>（契约类型，desktop 经 vite alias 消费）
                 ▼
┌──────────────────────── desktop（新增为主，三处最小改动） ──────────────────┐
│ api.fetchMyBudgets()  ──►  UsageBudgetTab.vue（新）                        │
│                             ├ 卡片：作用域 / 状态 / 进度条 / 消耗-上限      │
│                             ├ 周期与重置日（月度，服务器本地时区）          │
│                             └ 空态 / 错误态重试                            │
│ UsageDrawer.vue     ＋第四个 Tab（不消费 range；监听 refreshKey）           │
│ UsageBell.vue       open_usage_drawer detail.tab + nonce → 切 Tab          │
│ InboxDrawer.vue     BUDGET_WARN 分支：派发事件（修"没有关联会话"死端）      │
└───────────────────────────────────────────────────────────────────────────┘
```

数据流原则：

- **只读单向下行**：本方案不写任何业务表（收件箱跳转只是前端导航），不存在与服务端状态的竞态。
- **消耗口径唯一**：`myBudgets` 与 `checkAdmission` / `settleWarn` / admin 列表共用 `getPeriodSpend`，不引入第二套算法。
- **展示单位服务端归一**：COST 一律成本单位进 VO，前端零换算（决策 4），从结构上消灭 admin 页那种单位不对称。

## 5. 详设

### 5.1 契约（`shared/contracts/src/budget.ts` 新增）

```ts
// 用量预算的用户面契约（个人可见）。消费方：desktop（用量抽屉「预算」Tab）。
// 管理面 CRUD 仍走 admin（budget:read/write），不共用本文件。
// 单位口径（决策 4）：COST 的 limitValue 与 periodSpend 同为「成本单位」，
// 与模型价格填写口径一致；后端存储为微单位（×1e6），由服务端换算后下发。

export type BudgetScope = 'GLOBAL' | 'USER' | 'AGENT';
export type BudgetLimitType = 'COST' | 'TOKENS';
export type BudgetAction = 'WARN' | 'BLOCK';
/** 服务端派生（决策 5）：BLOCK 档越线 → BLOCKED；WARN 档越线 → WARNED；否则 NORMAL。 */
export type BudgetStatus = 'NORMAL' | 'WARNED' | 'BLOCKED';

export interface MyBudgetItemVO {
  id: number;
  scope: BudgetScope;
  /** 当期消耗（COST → 成本单位；TOKENS → token 原值）。 */
  periodSpend: number;
  /** 上限，与 periodSpend 同单位。 */
  limitValue: number;
  limitType: BudgetLimitType;
  action: BudgetAction;
  status: BudgetStatus;
  /** 周期标签 yyyy-MM（服务器本地时区）。 */
  period: string;
  /** 下次重置时间（服务器本地时区；月度 = 下月 1 日 00:00:00）。 */
  resetAt: string;
}

export interface MyBudgetsVO {
  items: MyBudgetItemVO[];
}
```

- `shared/contracts/src/index.ts` 增加一行导出（照 `:34` readiness 行样式）：`export type { BudgetScope, BudgetLimitType, BudgetAction, BudgetStatus, MyBudgetItemVO, MyBudgetsVO } from './budget';`
- 不返回 `createdBy` / `createdAt` / `enabled` 等管理字段（v1 只返 enabled 行，`enabled` 恒 1 无信息量）；不返回 AGENT scope 行（决策 3）。
- 既有 admin 前端 `BudgetView.vue:133-145` 的本地联合类型**不动**（admin 零改动；与契约的长期统一留作独立小任务，不在本方案扩面）。

### 5.2 后端 repository（`budget.repository.ts` 新增一个方法）

```ts
/** 对本人生效的启用中预算：GLOBAL 全部 + scope_id=本人的 USER 行（决策 2）。 */
async listApplicableToUser(userId: number): Promise<UsageBudgetRow[]> {
  return this.db.query<UsageBudgetRow>(
    `SELECT * FROM usage_budget
     WHERE enabled = 1 AND (scope = 'GLOBAL' OR (scope = 'USER' AND scope_id = ?))
     ORDER BY id ASC`,
    [userId],
  );
}
```

- 排序在 service 侧按 GLOBAL → USER 稳定重排（与 `checkAdmission` 的 `scopeOrder` 同序，`budget.service.ts:316-323`；同 scope 内 id 升序由 SQL 保证）。
- `scope='USER' AND scope_id = ?` 天然排除 `scope_id IS NULL` 的脏行（`validate` 本就拒绝创建，`budget.service.ts:287-290`），无额外防御。
- 不动既有 `list` / `findById` / `BudgetSpendStore`。

### 5.3 后端 service（`budget.service.ts` 新增一个方法 + 一个纯函数）

```ts
/** 下次重置时间：服务器本地时区下月 1 日 00:00:00（与 monthStartLocal 同族）。 */
export function nextMonthStartLocal(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-01 00:00:00`;
}

/** 用户面：对本人生效的预算 + 当期消耗 + 派生状态。失败整抛（决策 9），不做 safeSpend 式容错。 */
async myBudgets(userId: number): Promise<MyBudgetsVO> {
  const rows = (await this.repo.listApplicableToUser(userId))
    .sort((a, b) => this.scopeOrder(a.scope) - this.scopeOrder(b.scope) || (a.id ?? 0) - (b.id ?? 0));
  const period = currentPeriodLabel();
  const resetAt = nextMonthStartLocal();
  const items: MyBudgetItemVO[] = [];
  for (const row of rows) {
    const scope = row.scope as BudgetScope;
    const limitType = row.limitType as 'COST' | 'TOKENS';
    const spend = this.displaySpend(limitType, await this.getPeriodSpend(scope, row.scopeId ?? null, limitType));
    const limitValue = this.displaySpend(limitType, Number(row.limitValue));
    items.push({
      id: row.id!,
      scope,
      periodSpend: spend,
      limitValue,
      limitType,
      action: row.action as BudgetAction,
      status: spend >= limitValue ? (row.action === 'BLOCK' ? 'BLOCKED' : 'WARNED') : 'NORMAL',
      period,
      resetAt,
    });
  }
  return { items };
}
```

要点：

- `scopeOrder` 是私有方法，同类内调用无需改可见性；`displaySpend`（`:352`）同理——**两个既有私有成员零改动**。
- 越线比较用展示口径（`spend >= limitValue`，两侧同除 1e6）与 `checkAdmission` 的原始口径（`:101`，两侧同乘 1e6）数学等价；GLOBAL 行 `scopeId` 传 null，与 `sumCostSince` 的 GLOBAL 分支一致（`budget.repository.ts:110-118`）。
- `periodSpend` 不做四舍五入（与 admin `list()` 的 `:205` 同行为），展示由前端 `formatCost` 收口。
- WARN 与 BLOCK 两行可同时存在（`validate` 只对 GLOBAL 去重，`:263-268`），全部返回，卡片列表自然呈现。

### 5.4 路由（`budget.routes.ts` 新增一个端点）

```ts
// 对本人生效的用量预算（GLOBAL + 本人 USER scope）。仅需登录，不加权限码（决策 1/2）。
app.get('/v1/me/budgets', async (request, reply) => {
  const userId = requireUserId(request);
  return sendOk(reply, await deps.budgetService.myBudgets(userId));
});
```

- `requireUserId` 从 `../common/http-error.js` 追加 import（该文件已从此模块 import `requireRequestPermission` / `sendOk`，`budget.routes.ts:2`）。
- 与 `/v1/admin/budgets` 同文件注册但路径前缀不同，Fastify 按路径分发，无顺序耦合；`app-routes.ts:615` 装配不变（deps 已有 budgetService）。
- 无 query 参数、无新错误码（失败即 500 走既有 `handleError` → 拦截器 toast）。

### 5.5 desktop：api 函数与纯函数

`desktop/src/api/index.ts`（照 `:933-935` signal 类型的 contracts 导入样式追加）：

```ts
export type { BudgetScope, BudgetLimitType, BudgetAction, BudgetStatus, MyBudgetItemVO, MyBudgetsVO } from '@mao/contracts'
import type { MyBudgetsVO } from '@mao/contracts'

/** 对我生效的用量预算（GLOBAL + 本人 USER scope；月度周期，服务器本地时区）。 */
export async function fetchMyBudgets(): Promise<MyBudgetsVO> {
  const { data } = await api.get('/me/budgets')
  return data
}
```

`desktop/src/components/usage/budget-status.ts`（新增纯函数模块，仿 `pie-series.ts` / `trend-series.ts` 的可测模块先例）：

```ts
import type { MyBudgetItemVO } from '@mao/contracts'
import { formatCost, formatNumber } from '../../utils/usageFormat'

export function budgetScopeLabel(scope: MyBudgetItemVO['scope']): string {
  return scope === 'GLOBAL' ? '全局预算' : '我的预算'
}

/** 越线比例（VO 两侧同单位，决策 4；上限 100 封顶，与 admin 进度条口径一致）。 */
export function budgetSpendPercent(item: MyBudgetItemVO): number {
  if (item.limitValue <= 0) return 0
  return Math.min(100, Math.round((item.periodSpend / item.limitValue) * 1000) / 10)
}

/** 进度条配色：阈值与 admin（BudgetView.vue:221-226）一致——越线按档红/橙、≥80% 橙、否则绿。 */
export function budgetProgressColor(item: MyBudgetItemVO): string {
  const p = budgetSpendPercent(item)
  if (p >= 100) return item.action === 'BLOCK' ? '#f56c6c' : '#e6a23c'
  if (p >= 80) return '#e6a23c'
  return '#67c23a'
}

export function budgetStatusLabel(item: MyBudgetItemVO): string {
  return item.status === 'BLOCKED' ? '已拦截' : item.status === 'WARNED' ? '已越线' : '正常'
}

export function formatBudgetValue(value: number, limitType: MyBudgetItemVO['limitType']): string {
  return limitType === 'COST' ? formatCost(value) : formatNumber(value)
}
```

### 5.6 desktop：Tab 与两处跳转

**`UsageBudgetTab.vue`（新增）**

- props：`{ refreshKey: number }`；数据获取：`onMounted(fetch)`（`el-tab-pane` 懒渲染——首次切到本 Tab 时挂载即拉取）+ `watch(() => props.refreshKey, fetch)`（抽屉头部刷新按钮驱动，与明细 Tab 同模式）；切走再切回不自动重拉（取舍定稿 (a)，见 C10；当月消耗数据 + 刷新按钮可兜底）。
- 卡片：作用域标签（全局预算 / 我的预算）+ 状态标签（正常 / 已越线 / 已拦截）+ `el-progress`（`:percentage` / `:color` 走 5.5 纯函数）+ 「当期消耗 X / 上限 Y（口径）」+ 周期行「月度周期 · 本月（yyyy-MM）· 服务器本地时区」+「重置时间：resetAt」；卡片展示序 BLOCKED → WARNED → NORMAL、同状态保服务端序（Tab 内稳定排序 computed，服务端返回序不变）。
- 空态（无 enabled 行）：「当前没有生效的预算限制」+ 次行「团队预算由管理员配置，可在任务收件箱接收越线提醒」——不报错、不白屏（C12）。
- 错误态：请求失败显示重试按钮（拦截器已 toast，此处给原地恢复入口）；加载态 `v-loading`。
- **不消费** `range` / `dateRange`（决策 7）：预算恒为月度，Tab 内自标周期；`range` 切换不触发本 Tab 重拉。

**`UsageDrawer.vue`（最小改动）**

- `el-tabs` 增第四个 `<el-tab-pane label="预算" name="budget"><UsageBudgetTab :refresh-key="refreshKey" /></el-tab-pane>`；`UsageTab` 联合加 `'budget'` 并 `export`（供 UsageBell 引用）。
- 新增可选 prop `openRequest?: { tab: UsageTab; nonce: number } | null` + `watch` 置 `activeTab`（见 5.6 UsageBell）。
- 既有三个 Tab 的渲染、周期选择器、刷新令牌逻辑零改动。

**`UsageBell.vue`（最小改动）**

```ts
const openRequest = ref<{ tab: UsageTab; nonce: number } | null>(null)
let openNonce = 0
function handleOpenUsageDrawer(e: Event) {
  drawerVisible.value = true
  const tab = (e as CustomEvent<{ tab?: UsageTab }>).detail?.tab
  if (tab) openRequest.value = { tab, nonce: ++openNonce }   // nonce 保证重复同值也触发（C8）
}
```

- 现有派发方 `InboxDrawer.vue:139`（摘要"查看用量"）不带 detail → `tab` 为 undefined → 不改 `activeTab`，**存量行为逐字节不变**。
- `<UsageDrawer v-model="drawerVisible" :open-request="openRequest" />`。

**`InboxDrawer.vue`（最小改动，修死端）**

```ts
// 预算提醒无关联会话（sessionId 恒 null）：跳用量抽屉「预算」Tab，
// 取代原来落到「该通知没有关联会话」的死端（决策 10）。
if (item.kind === 'BUDGET_WARN') {
  visible.value = false
  window.dispatchEvent(new CustomEvent('open_usage_drawer', { detail: { tab: 'budget' } }))
  return
}
```

- 插入位置：`DAILY_DIGEST` 分支之后、`sessionId == null` 警告之前（`InboxDrawer.vue:96-102`）；其余 kind 路径零变化。

### 5.7 P3（可独立上线，也可整体不做）

**按 Agent 归因（零后端改动）**：预算 Tab 底部「本期消耗按 Agent」——调既有 `fetchMyUsageSummary('month')`（`api/index.ts:919`，range=month 与预算周期同口径），渲染其 `byAgent`（`UsageOverviewTab.vue:63-69` 已有同款数据消费与兜底命名）。一次额外请求，不碰后端。

**直接 BLOCK 横幅跳转（可选，决策 11）**：

- 服务端两处 budget gate 早退发 error 帧时加 `code: 'budget_exceeded'`（`streaming-ws-handler.ts:602` 与 `:945` 编辑路径；error 帧已支持 code 字段——`useStreamWS.ts:1204` 已有 `side_session_rejected` 分支先例）。
- `useStreamWS.ts` error case 增一个分支：`if (data?.code === 'budget_exceeded') window.dispatchEvent(new CustomEvent('budget_blocked', { detail: { sessionId } }))`——**不改 store、不改相位逻辑**（`setExecutionError` / FAILED 翻转原样执行）。
- `ExecutionErrorBanner.vue` 增可选 props（`actionLabel?: string` + `emit('action')`）；`ChatPanel.vue` 持 `budgetBlocked` ref 监听事件（会话匹配才置位；`executionError` 变化时复位），置位时传 `action-label="查看我的预算"`，点击派发 `open_usage_drawer { tab: 'budget' }`。
- 不做的退路：横幅数字 + 收件箱跳转已覆盖主要路径；本项纯便利。

### 5.8 与 admin 页面的口径对齐（不进 admin 代码）

| 口径 | admin 现状 | 本方案 |
|---|---|---|
| 周期 | 「月度周期（服务器本地时区当月 1 日 00:00 起）」（`BudgetView.vue:8` hint） | VO `period` / `resetAt` 同源（`monthStartLocal` / `nextMonthStartLocal`） |
| 进度条配色 | ≥100 按档红/橙、≥80 橙、否则绿（`:221-226`） | `budgetProgressColor` 逐字复刻 |
| 越线文案 | 「BLOCK 已生效」/「WARN 已越线」（`:49-50`） | 状态标签「已拦截」/「已越线」 |
| 成本格式 | `formatCost`（admin `utils/llmCallLabels`） | desktop `utils/usageFormat` 的 `formatCost`（两端各自既有工具，不新建） |

## 6. 改动面

| 层 | 文件 | 改动 |
|---|---|---|
| shared/contracts | `src/budget.ts`（新增）、`src/index.ts`（+1 行导出） | 契约 |
| backend-ts | `budget/budget.repository.ts` | +`listApplicableToUser`（新方法，旧方法不动） |
| backend-ts | `budget/budget.service.ts` | +`nextMonthStartLocal` 纯函数、+`myBudgets` 方法；两个私有成员零改动 |
| backend-ts | `budget/budget.routes.ts` | +`GET /v1/me/budgets`；+`requireUserId` import |
| backend-ts | `budget/budget.routes.spec.ts` / `budget.service.spec.ts` | 新增用例（§8） |
| desktop | `api/index.ts` | +`fetchMyBudgets` + 契约类型再导出 |
| desktop | `components/usage/UsageBudgetTab.vue`（新增）、`budget-status.ts`（新增）+ `.test.ts` | 预算 Tab 与纯函数 |
| desktop | `components/usage/UsageDrawer.vue` | +第四 Tab、+`openRequest` prop、`UsageTab` 加 `'budget'` 并导出 |
| desktop | `components/usage/UsageBell.vue` | 事件处理读 `detail.tab` + nonce |
| desktop | `components/inbox/InboxDrawer.vue` | +BUDGET_WARN 分支（修死端） |
| desktop（P3 可选） | `session/ws/streaming-ws-handler.ts`（两处 +code）、`useStreamWS.ts`（+分支）、`ExecutionErrorBanner.vue`（+可选 props）、`ChatPanel.vue`（+监听与传参） | 横幅跳转 |
| admin / mao-cli / agent-cli / android / sdk | 无 | 零改动 |

预估：P1 约 1.5-2 人日（后端 + 契约 + spec）、P2 约 1.5-2 人日（Tab + 跳转 + 测试）、P3 约 1-1.5 人日（归因复用 + 可选横幅）。合计 4-5.5 人日。三阶段各自可独立上线 / 独立回滚（P1 无前端消费也可先合；P3 整体可选）。

## 7. 冲突与风险详表

| # | 冲突 / 风险 | 应对 |
|---|---|---|
| C1 | **单位口径混用**：admin 的 `limitValue`（微单位）与 `periodSpend`（成本单位）不对称曾差点造出"进度条恒 0%"（`BudgetView.vue:209-218` 注释为证）；用户面若照抄该结构会重蹈 | 决策 4：VO 两侧同单位（服务端 `displaySpend` 统一换算）；契约注释写明；spec 断言 `limitValue` 为成本单位量级 |
| C2 | **周期语义混淆**：抽屉有 9 档统计周期选择器，预算恒月度——用户切"近 7 天"后若预算数字跟着变会产生"预算按周算"的误解 | 决策 7：预算 Tab 不消费 `range`；Tab 内固定展示「月度周期 · yyyy-MM · 服务器本地时区」与重置日；实现注释锁定 |
| C3 | **GLOBAL 额度敏感性**：全局预算额度对全体登录用户可见，是否泄露管理意图 | 决策 2 + 评审确认项：默认可见（额度不是秘密，"知道天花板"优于黑盒拦截）；VO 不含 `createdBy` 等管理字段；若评审否决则降级为只显示"已启用全局预算"状态条（前端一处条件渲染） |
| C4 | **越权读取**：他人 USER 预算行不可见 | repo SQL 强制 `scope='USER' AND scope_id = 本人`；路由 spec 用两个不同 userId 断言隔离；AGENT 行 v1 不返回（决策 3） |
| C5 | **查询性能**：GLOBAL 行为全表 SUM（`idx_llm_call_created` 范围扫描，`budget.repository.ts:95-98`） | 与 `checkAdmission` 同款查询、已随 0.0.243 上线验证；单请求 1-2 条 SUM；不加缓存（决策 8） |
| C6 | **时区口径**：周期按服务器本地时区，用户可能在别的时区 | 与 admin 预算页既有口径一致（`BudgetView.vue:8`）；`period` / `resetAt` 服务端算好原样展示，前端零换算；UI 明示"服务器本地时区" |
| C7 | **多档叠加**：GLOBAL + USER（+未来 AGENT）同时命中的展示序 | 服务端返回序与 `checkAdmission` 同序（GLOBAL → USER → AGENT，`scopeOrder`）；展示层再把 BLOCKED 置顶（Tab 内稳定排序 computed，同档次内不丢服务端序） |
| C8 | **跳转事件重复同值失效**：连续两次派发 `{ tab: 'budget' }`，Vue watch 浅比较不触发第二次 | UsageBell 持 `nonce` 自增，`openRequest` 每次新对象；存量无 detail 派发不受影响 |
| C9 | **收件箱改动回归**：`handleItemClick` 是全部 kind 的公共入口 | 新分支插在 DAILY_DIGEST 之后、sessionId 警告之前，只拦截 `BUDGET_WARN` 一个 kind；其余路径逐字节不变；补"其余 kind 不受影响"的回归断言 |
| C10 | **Tab 懒渲染与刷新令牌**：el-tab-pane 默认懒渲染且不销毁，预算 Tab 挂载时机与 `refreshKey` 的衔接 | 定稿 (a)：Tab 内 `onMounted` + `watch(refreshKey)`，切走再切回不自动重拉（与明细 Tab 现有模式一致，刷新按钮兜底）；备选 (b)：Drawer 以 `v-if` 控制重挂载（切回即刷新，但丢 Tab 内滚动与展开态），不采用 |
| C11 | **失败降级**：端点 500 时 Tab 白屏或误导 | 决策 9：整请求失败；Tab 错误态 + 重试按钮；拦截器 toast 既有；不做部分数据展示 |
| C12 | **空态语义**：无预算用户看到空列表可能误解为"功能坏了" | 专属空态文案（"当前没有生效的预算限制" + 管理员配置引导），与 0.0.347 readiness 空态分流同思路 |
| C13 | **契约漂移**：VO 字段前后端不一致 | VO 单一事实源在 contracts；desktop 经 vite alias 直接消费类型；后端 service 方法返回值标注契约类型，编译期对齐 |
| C14 | **三端一致性**：Web / Electron / 安卓 Capacitor 同源远程加载 | 本方案纯 REST + 桌面组件，无 Electron 分支、无原生依赖；抽屉移动端适配既有（`UsageDrawer.vue:193-245`） |
| C15 | **测试基线**：vitest 只收 `src/**/*.test.ts`（`.spec.ts` 不跑）；无 `@vue/test-utils` | 纯函数进 `budget-status.test.ts`；组件按 `UsageDetailTab.test.ts` 的源码/AST 断言套路；E2E 不新建（种子改动大，列人工冒烟：见 §8） |

**开放问题**（不阻塞评审，实施时定）：

1. P3 横幅跳转做不做（默认不做也完整；做则按 5.7 的"不动 store"方案）。
2. 「本期消耗按 Agent」放预算 Tab 底部还是并入 P3 观察项后再加。
3. mao-cli 用户面命令（如 `budget me`）是否排入后续独立小任务。

## 8. 测试要点

**后端**（vitest，`budget.routes.spec.ts` / `budget.service.spec.ts` 既有 harness 扩充）：

- service `myBudgets`：GLOBAL + 本人 USER 双行返回与排序（GLOBAL 在前）；他人 USER 行不返回（repo mock 按 SQL 语义，service 层断言入参 userId）；disabled 行不返回；COST 行的 `periodSpend` / `limitValue` 均为成本单位（微单位 fixture 除 1e6 后相等）；越线状态派生（BLOCK+越线 → BLOCKED、WARN+越线 → WARNED、未越线 → NORMAL，边界值取 `spend === limitValue` 恰越线）；`period` / `resetAt` 格式与跨月（mock 时钟 12 月 → 次年 1 月）。
- 路由：未登录（preHandler 不注入 userId）→ 401；登录 → 200 且 `myBudgets` 以当前 userId 调用；**不加权限码**——无 `budget:read` 的普通 userId 同样 200（与 admin 端点 403 行为对照，防回归有人给 me 端点加门）。
- 回归：admin CRUD 既有用例全绿（本方案不改其路径）。

**desktop**（vitest）：

- `budget-status.test.ts`：`budgetSpendPercent`（0 / 边界 100 封顶 / 小数一位）、`budgetProgressColor`（BLOCK 越线红、WARN 越线橙、≥80 橙、正常绿）、`budgetStatusLabel`、`formatBudgetValue`（COST 走 formatCost、TOKENS 走 formatNumber）。
- `UsageBudgetTab`：空态渲染、错误态重试调用、卡片渲染（进度条百分比与状态标签取自 VO）；`refreshKey` 变化重拉（mock api 计数）。
- `InboxDrawer` BUDGET_WARN 分支：点击派发 `open_usage_drawer` 且 `detail.tab === 'budget'`、抽屉关闭；其余 kind（TASK_COMPLETED 等）仍走原路径（回归）。
- `UsageBell`：带 detail 事件切 Tab（nonce 递增生效）、不带 detail 事件不改 Tab（存量行为）。

**人工冒烟**（不进 E2E，理由 C15）：管理员在 admin 建 GLOBAL WARN + 某用户 USER BLOCK → 该用户桌面「预算」Tab 显示两卡、状态正确；触发一次越线 → 收件箱 BUDGET_WARN 点击跳转预算 Tab；任务被 BLOCK 时横幅文案不变（P3 未做时）。

## 9. 验收标准

1. 用户打开用量抽屉「预算」Tab：可见 GLOBAL 与本人 USER 预算的额度、当期消耗、状态、周期与重置时间；无预算时显示友好空态而非报错或空白。
2. 收件箱 BUDGET_WARN 条目点击跳转预算 Tab——「该通知没有关联会话」死端消除，其余 kind 点击行为不变。
3. 单位口径自洽：COST 上限与消耗同口径（进度条数值正确，无 1e6 偏差类缺陷）。
4. 越权不可见：任一用户看不到他人 USER 预算与 AGENT 预算（路由 spec 断言 + 冒烟）。
5. 后端 diff 仅新增（一个路由、两个 service 成员、一个 repo 方法、一个契约文件、index 一行导出）：`checkAdmission` / `settleWarn` / `noticeQueueBlocked` / admin CRUD / admin 页面 / mao-cli / agent-cli 零改动（评审可逐行核对）；零迁移。
6. 桌面既有三个 Tab、周期选择器、刷新行为零变化；drawer 打开态与存量事件派发方（摘要"查看用量"）行为不变。
7. WARN 档越线用户的完整体验闭环：提醒进收件箱（既有）→ 点击见额度全貌（本方案）。

## 10. 迁移与回滚

- **迁移**：零。不建表、不加列、不改索引（消耗 SUM 复用 `idx_llm_call_user_created` / `idx_llm_call_created`，V138/V001 既有）；`usage_budget` 只读。
- **回滚**：纯增量设计，三阶段各自独立可回退——P1 撤端点 + 契约文件（desktop 无消费时无连带）；P2 撤 Tab 与两个分支（事件 detail 为可选字段，旧派发方不受影响）；P3 整体可选。无数据、无状态机、无缓存需要清理。

## 11. 排期注意

1. **CHANGELOG**：实施任务同批写顶部 `## x.y.z (日期)` 新块（当前最新 0.0.353，本方案开 **0.0.354**）——「后端」节记「新增 `GET /v1/me/budgets`（对本人生效的用量预算只读端点）」；「前端」节记「用量抽屉新增『预算』Tab + 收件箱预算提醒可跳转」；按 `./scripts/changelog-extract.sh` 口径走。
2. **三处同改清单**：本方案不新增内置工具、不新增 LLM 调用场景、不新增收件箱 kind（BUDGET_WARN 既有），**不触发** AGENTS.md 的既有「三处同改」规范；契约为新增文件，不动既有联合类型。
3. **相邻收敛点**：零触碰——不动 `task-terminal.service.ts` / AgentLoop / prompt-engine / WS 相位逻辑（P3 可选项仅在 error 分支加 window 事件派发，与 `side_session_rejected` 先例同型）。
4. **文档同步**：`skills/mao-cli/reference/desktop.md` 用量抽屉节补「预算」Tab（三 Tab → 四 Tab）；`reference/budget.md` 补一段用户面可见性说明（该文档管理向，注明普通用户入口在桌面用量抽屉）；`README.md`「治理」行月度用量预算补一句用户可见；提案台账（`docs/proposals/README.md` 第十七批该条目）在本文档评审通过后标「已细化 / 已转入实施」并回链。
5. **与同批另外两提案的关系**：互不依赖、可并行；三者共享的只有「零迁移、不碰执行内核」的排期属性，无代码交集。
