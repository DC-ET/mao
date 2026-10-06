# 用量成本核算与预算管控技术方案：模型价格 → 成本落账 → 预算闸门

- 状态：技术方案，待实施（2026-10-06 评审修订：BLOCK 通道与入口覆盖见 §5.7、成本口径见 §5.4、种子 SQL 见 §5.5，修正决策补录 §10.11-13）
- 日期：2026-10-06
- 提案来源：[docs/proposals/2026-10-06-usage-cost-budget.md](../proposals/2026-10-06-usage-cost-budget.md)

## 1. 需求背景

1. **有量没钱**：`llm_call`（V113）已记录 prompt/completion/cached tokens、耗时、重试与全维度（user/session/agent/model/scene，且 `idx_llm_call_*_created` 组合索引齐全），管理后台 `/v1/admin/analytics/*` 七个 scope 聚合齐备（`admin-analytics.service.ts`）。但 `llm_model` 无价格列、`llm_call` 无成本列，全库无"钱"的概念。
2. **失控面变大**：开放 API（`open-run.service.ts`，限流仅 60/min）与 Webhook 触发器（`webhook-trigger.service.ts`）让外部系统可编程触发运行。现有护栏只有 Webhook 连续 5 次失败自动停用（`TRIGGER_DISABLE_AFTER_FAILURES`）与固定窗口限流，费用维度无任何闸门。
3. **最贵的辅助链路没有独立模型**：`session-compaction-orchestrator.ts` 直接传 `context.modelConfig`（主模型跑压缩摘要，token 量最大），而标题 / commit message / 评险 / 记忆抽取均已支持独立配模型（`settings.service.ts` 的 `session.titleModelId`、`git.commitMessageModelId`、`approval.modelId`、`memory.extractionModelId`）。

## 2. 需求描述

### 2.1 目标（全部要做）

1. 模型价格可配（输入 / 输出 per 1M tokens），`llm_call` 落成本快照，用量分析各 scope 与调用流水可看钱。
2. 预算管控：GLOBAL / USER / AGENT 三种 scope 的月度预算（金额或 token），WARN 超线进收件箱提醒、BLOCK 超线拒绝**新**任务，两档独立配置。
3. `compaction.modelId` 独立配置，缺省回退会话主模型。

### 2.2 非目标（明确不做）

- 不做计费 / 账单 / 充值 / 多币种换算（金额单位 = 管理员填价格时的统一口径，文档与 UI 明示）。
- 不做实时限流框架与运行中任务的打断（预算只在新任务入口检查；运行中任务跑完为止）。
- 不做团队共享池（多用户合用额度）。
- 不做 `llm_usage`（V073 旧表）的迁移——成本只基于 `llm_call`。

## 3. 范围界定：做 / 不做清单

### 3.1 做什么

| 层 | 内容 |
|---|---|
| backend-ts | V135（`llm_model` 价格列 + `llm_call.cost_micros` + agent 维度索引）、V136（`usage_budget` 表 + `budget:*` 权限码 + `compaction.modelId` 种子）；成本快照计算（RecordingLlmAdapter 落库链）；`AdminAnalyticsService` 各 scope 增加成本聚合；`BudgetService` + 任务入口检查（WS 手动发送与编辑重发、WS 队列消费、open run、定时任务，见 §5.7）；WARN 经 InboxService 新 kind `BUDGET_WARN`；`CompactionModelResolver` |
| admin | 用量分析 6 Tab 成本列 / 成本趋势线；llm-call 明细加成本列 + CSV 导出列；模型表单加价格字段（ModelFormDialog）；预算管理新页 BudgetView + 路由 + 菜单 |
| desktop | 无改动（BLOCK 的 WS 错误沿用现有发送失败 toast 通道；WARN 走收件箱，InboxDrawer 的 KIND_META 加一项） |
| 文档 | CHANGELOG 发版条目；skills/mao-cli admin 章节补价格与预算说明 |

### 3.2 不做什么（与"做"同等明确）

- 不新增 Playwright 用例（全部 Vitest）。
- 不动 `LlmCallRow` 既有列语义，只增量加 `cost_micros`。
- 不做预算的按小时 / 日粒度（period 仅 MONTHLY，列上留扩展位）。
- 不做成本告警的 IM 通道推送（飞书 / 钉钉任务通知不覆盖预算事件，只进站内收件箱）。

## 4. 技术选型

零新增依赖。成本以 **`cost_micros BIGINT`**（成本单位 × 10⁶ 的整数）落库，避免浮点累加误差；价格列 `DECIMAL(12,6)`。价格快照随模型解析链下发（模型行本就要在 `buildContext` 解析），落库侧不新增查询；兜底走 `LlmCallService.record` 内 60s TTL 的模型价格缓存。

## 5. 详细设计

### 5.1 V135 迁移

```sql
ALTER TABLE `llm_model`
    ADD COLUMN `price_input`  DECIMAL(12,6) NULL COMMENT '每百万输入 token 价格（成本单位；NULL=不计成本）',
    ADD COLUMN `price_output` DECIMAL(12,6) NULL COMMENT '每百万输出 token 价格（成本单位；NULL=不计成本）';

ALTER TABLE `llm_call`
    ADD COLUMN `cost_micros` BIGINT NULL COMMENT '本次调用成本快照 = 价格×tokens（成本单位×1e6 整数）；价格未配置时为 NULL',
    ADD INDEX `idx_llm_call_agent_created` (`agent_id`, `created_at`);
```

- `idx_llm_call_agent_created`：预算按 AGENT scope 查当期消耗必需（现有索引只覆盖 user/session/model/scene）。
- 历史数据不回填（改价快照原则，见 §10 决策 1；`cost_micros` 对旧行保持 NULL）。

### 5.2 成本口径（计价公式）

设 `pi = price_input`、`po = price_output`（per 1M tokens）：

```
prompt_billable = max(0, prompt_tokens − cached_tokens × 0.5)   -- 缓存命中按 5 折计价；下限钳制防异常供应商（cached > prompt）产生负成本污染 SUM
cost = (prompt_billable × pi + completion_tokens × po) / 1,000,000
cost_micros = round(cost × 1,000,000)
```

- 前提假设（文档明示）：`cached_tokens ⊆ prompt_tokens`（OpenAI / Anthropic 主流口径）。若某供应商口径不符，价格按"含缓存折算价"填写。
- 价格列 DECIMAL 经 mysql2 读出为 string，计价前 parseFloat；`cost_micros = round(tokens × price)` 整数域最大约 2×10¹⁵（< 2⁵³），JS Number 精度安全，以大数单测锚定。
- **任一价格为 NULL → `cost_micros = NULL`**（本地模型 / 未填价模型不计成本），聚合 SUM 自动忽略 NULL 行。
- 失败调用（success=0）若产生了 token（上游计费）照常计价；totalTokens=0 的失败行成本为 0。

### 5.3 成本快照写入链

- **主路径**：模型解析链（`HarnessService.buildContext` → 模型解析，及各辅助场景的模型读取）把 `priceInput/priceOutput` 随 `LlmModelConfig` 下发；`RecordingLlmAdapter`（`recording-llm-adapter.ts`）在 `finally` 落库时按配置快照计算 `costMicros` 传入 `LlmCallService.record`。改价只影响后续调用。
- **覆盖面**：AgentLoop 与 LLM 调用全部在云端（desktop/Electron 无直连 LLM 代码；LOCAL 仅指工具执行经 LocalToolExecutor WS 委托桌面），成本落账与预算天然覆盖 CLOUD + LOCAL 全部会话。
- **类型改动面**：`LlmCallService.record` 入参类型 `LlmCallModelConfig`（`llm-call.service.ts`）与 `LlmModelConfig` 是两个独立接口，价格字段需两边同步新增（结构化类型兼容传参，主/兜底双路径一致性由单测锚定）。
- **兜底路径**：`LlmModelConfig` 无价格字段时（旧调用路径遗漏），`LlmCallService.record` 按 `modelId` 查 `ModelRepository`（60s TTL 内存缓存，含"模型不存在"负缓存），仍取不到 → NULL。
- 模型被软删（`deleted=1`）后其价格不可再解析，兜底缓存过期后新调用成本为 NULL——可接受，`model_name/provider` 冗余快照仅用于展示不用于计价。

### 5.4 用量分析成本聚合

- **成本唯一口径 = `llm_call`**（决策 13）：message 表无成本列（User/Agent/Model Tab 的 token 来自 message 表），overview 兼容路径 token 仍来自 V073 `llm_usage`——成本列与页面既有 token 列来源不同，UI 不暗示"成本 = token × 单价"的直觉换算，单位口径文案照旧注明。
- `AdminAnalyticsService`（`admin-analytics.service.ts`）在 llm_call 聚合 SELECT 增列 `COALESCE(SUM(cost_micros),0)/1000000 AS cost`；User/Agent/Model Tab 的成本在 service 层与既有 message/llm_usage 结果合并（新增 `selectCallCostByAgent/User/Model` 三个查询），不是单条 SQL"加一列"的改动量。`PeriodTotals` 加 `totalCost`，`ModelStatRow/UserActivityRow/AgentStatRow` 加 `cost`，`TrendPoint` 加 `cost`（前端折线加一条）。
- 趋势/总览注意既有口径注释：`llm_call` 与 chat+background 为包含关系（不可叠加，见该文件 1187 行注释），成本挂在 llm_call 侧聚合，scope 相加时不得重复累计。
- 沿用 `excludeConnectivity` 口径：connectivity_test 场景不计入成本聚合（连通性测试是管理员动作，且高频低成本会污染趋势）。
- admin `types.ts` 对应 Row 接口加字段；`ModelTab/UserTab/AgentTab` 的 el-table 加"成本"列，OverviewTab 加总额卡片；所有成本展示统一注明单位口径（"与模型价格填写单位一致"）。
- `LlmCallView.vue` 明细表加"成本"列；CSV header 插入 `成本`（紧跟"输出 Token"后），导出值 = `cost_micros/1e6` 保留 6 位小数，NULL 输出空串。
- 顺手修正：`admin/src/utils/llmCallLabels.ts` 补缺失的 `proxy_approve` 场景标签。

### 5.5 V136 迁移与预算模型

```sql
CREATE TABLE IF NOT EXISTS `usage_budget` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `scope`       VARCHAR(16)  NOT NULL COMMENT 'GLOBAL/USER/AGENT',
    `scope_id`    BIGINT       NULL COMMENT 'USER/AGENT 时的目标 id；GLOBAL 为 NULL',
    `period`      VARCHAR(16)  NOT NULL DEFAULT 'MONTHLY',
    `limit_type`  VARCHAR(16)  NOT NULL COMMENT 'COST（微单位整数）/ TOKENS',
    `limit_value` BIGINT       NOT NULL COMMENT 'COST: cost_micros 口径；TOKENS: total_tokens 累计',
    `action`      VARCHAR(8)   NOT NULL COMMENT 'WARN/BLOCK',
    `enabled`     TINYINT      NOT NULL DEFAULT 1,
    `created_by`  BIGINT       NOT NULL,
    `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY `idx_budget_scope` (`scope`, `scope_id`, `enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用量预算（周期消耗上限）';
```

- 同一 scope 允许多行（典型配置：WARN 行 80% + BLOCK 行 100%）；GLOBAL 行至多一条由 service 校验。
- 权限码按 V121 目录模式注册 `budget:read` / `budget:write`，授 role 1（管理员）。
- `compaction.modelId` 种子（`system_setting` 仅 5 个业务列，与 V097 同款写法；类目沿用 V097 的 `运行参数`）：

```sql
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('compaction.modelId', '', '运行参数', '上下文压缩摘要使用的模型；留空则使用会话模型', 1);
```

### 5.6 当期消耗查询（BudgetService）

- 周期起点：服务器本地时区当月 1 日 00:00。
- `getPeriodSpend(scope, scopeId)`：对 `llm_call` 按 scope 维度 SUM——USER 走 `idx_llm_call_user_created`，AGENT 走新增 `idx_llm_call_agent_created`，GLOBAL 全表（`idx_llm_call_created` 范围扫描）。COST 求和 `cost_micros`（NULL 不计），TOKENS 求和 `total_tokens`。
- USER scope 口径：`llm_call.user_id` 对群聊场景为 executionUserId，USER 预算把该用户代执行的群聊消耗一并计入本人（文档与 UI 明示）。
- 不做物化汇总表：月内数据量在现有索引下单次聚合可接受（与 analytics 同量级）；admission 检查每次执行一次 SUM，如实施后实测 >100ms 再引入 5 分钟 TTL 缓存（列入观察项，不预做）。观察项同时覆盖 WARN 结算（每任务终态一次，§5.8）与留队 BLOCK 消息的重复重查（§5.7）。

### 5.7 BLOCK 检查点（只拦新任务）

> WS 侧关键前提（评审修正）：`dispatch` 外层 catch 只 `console.error`（`streaming-ws-handler.ts:326`），**抛 `BusinessException` 前端无感知**。WS 各检查点必须显式 `registry.send(userId, wsEvent('error', ...))`（message 携带 scope/当期消耗/上限）；异常冒泡只适用于 REST 信封（open run）。

| 入口 | 位置 | 拦截行为 |
|---|---|---|
| WS 手动发送 / 编辑重发 | `handleSendMessage`（`requireOwnedSession` 之后、busy 入队/占位判定之前）+ `handleEditAndResend`（占位之后、`editMessageAndTruncate` 之前；edit_and_resend 是独立执行入口，不经过 handleSendMessage，评审修正补入） | 显式 error 事件 → 前端 toast；早退并释放已持占位（edit_and_resend 路径），消息不落库、不入队、原消息不被截断 |
| WS 队列消费 | `autoConsumeQueue`（`dequeue` 取出队头之后、来源绑定登记/落库之前） | 显式 error 事件 + 收件箱提醒一次（去重），随后复用 `compensate` 链路：释放占位 + `enqueueHead` 原位回补（语义 = 留在队列）；用户调整预算或手动移除。不得直接抛 `BusinessException` 依赖外层 catch |
| 开放 API / Webhook | `OpenRunService.run`（`withSessionLock` 之前） | 抛 `BusinessException(BUDGET_EXCEEDED)` → Result 信封 code≠0；Webhook 直跑路径 `handleDirectOutcome` 计 FAILED（与连续失败自动停用护栏正向联动，见决策 6） |
| 定时任务 | `executeTask` 锁内直跑分支（busy 入队判定之后、`updatePhase('RUNNING')` 与 USER 消息落库之前） | 本轮执行标记 FAILED（reason=BUDGET_EXCEEDED），走现有早退 FAILED 记录路径；**不得放在 `liveExecution` 调用前**（该位置消息已落库、phase 已 RUNNING，被拒需回滚孤儿数据）；busy 入队分支不检查——排队消息由 autoConsumeQueue 消费时再查（同 WS 排队语义） |

- 检查顺序：enabled 行中 BLOCK 行按 GLOBAL → USER(session.userId) → AGENT(session.agentId) 逐一比对当期消耗；命中即拒。子代理 / 边路 / 崩溃恢复不单独检查（跟随父会话的准入结论）。
- 新错误码：`error-code.ts` 3xxx 段新增 `BUDGET_EXCEEDED`（编号顺延，实施时以实际水位为准），message 携带 scope、当期消耗、上限。
- 留队 BLOCK 消息每次任务终态触发 autoConsumeQueue 都会重查一次消耗：功能正确，查询频率并入 §5.6 观察项。

### 5.8 WARN 结算（任务终态）

- 挂点：`task-terminal.service.ts` `finishExecution`（已排除 SUBAGENT/SIDE_TASK/CANCELLED 的 `recordInbox` 同位置附近，fire-and-forget）。
- 逻辑：任务终态后取 enabled 的 WARN 行，多行（GLOBAL+USER+AGENT）合并为一次周期消耗查询，比对 `getPeriodSpend` ≥ `limit_value`；越线时 `InboxService.record` 新 kind **`BUDGET_WARN`**，`dedup_key = {userId}:BUDGET_WARN:{budgetId}:{yyyy-MM}`（同周期同预算恰好提醒一次，`insertIgnore` 幂等）。完整改动面：`@mao/contracts` 的 `InboxKind` 类型 + 后端 `inbox/types.ts` 的 `isInboxKind` 白名单 + 偏好开关默认开 + desktop `InboxDrawer.vue` `KIND_META` 一项（`label: '预算提醒', icon: '¥'`）。结算频率 = 每任务终态一次，与 admission 同量级，并入 §5.6 观察项。

### 5.9 admin 预算管理页

- 后端路由（`budget:read`/`budget:write`）：`GET /v1/admin/budgets`（列表 + 当期消耗/占比）、`POST /v1/admin/budgets`、`PUT /v1/admin/budgets/:id`、`DELETE /v1/admin/budgets/:id`（软删 enabled=0 或物理删，物理删即可——无历史引用）。
- admin 新视图 `views/budget/BudgetView.vue`：预算行表格（scope/目标名/类型/上限/动作/当期消耗进度条/启停）+ 新增对话框（scope 联动目标选择器：USER 用 `/v1/admin/users` 搜索、AGENT 用 `/v1/agents`）；路由 `meta.permission: 'budget:read'` + SideMenu 菜单项（admin 现无"治理"分组，按 SideMenu 现有分组结构新建一级分组或挂现有分组，实施时定）。写操作按钮用 `hasPermission('budget:write')` 门控（参照 SystemSettingsView 的读写分工）。
- 容错：`usage_budget` 无外键，USER/AGENT 目标被删后预算行仍在——检查时目标 `findById` 为空则跳过该行，列表展示"已删除"。
- 模型价格编辑：`ModelFormDialog.vue` 加两个数字输入（per 1M，可空）；`ModelVO`/`CreateModelRequest`/`model.service.ts` 的 `createModel/updateModel` 与 `model.repository.ts` insert/update 字段 map 同步加列。

### 5.10 P3：压缩模型独立配置

- 仿 `ApprovalModelResolver`（`approval-model-resolver.ts`）新建 `CompactionModelResolver`：读 settings `compaction.modelId` → 校验存在且启用且 `model_type='text'` → 失效（未配 / 已删 / 停用）回退 `context.modelConfig`；每次压缩即时解析。
- 消费点：`session-compaction-orchestrator.ts` 将 `compactSession` 的 modelConfig 入参从 `context.modelConfig` 改为 resolver 结果；`scene=compaction` 不变，成本归属天然清晰（压缩模型填了低价即直接省钱）。

## 6. 实施步骤

### P1：成本落账（backend + admin）

1. V135；`LlmModelConfig` 价格下发 + `RecordingLlmAdapter` 快照计算 + `LlmCallService.record` 兜底缓存；单测计价公式（含缓存 5 折 / NULL 价格 / 失败调用）。
2. `AdminAnalyticsService` 各 scope 成本聚合 + admin types/Tab/CSV/明细列；`llmCallLabels.ts` 补 `proxy_approve`。
3. `ModelFormDialog` 价格字段 + CRUD 链路。

### P2：预算管控（backend + admin + desktop 一行）

1. V136（usage_budget + 权限码 + compaction.modelId 种子）；`BudgetService`（消耗查询 + admission 检查 + WARN 结算）。
2. 三处入口接线（§5.7）+ `BUDGET_EXCEEDED` 错误码；`BUDGET_WARN` 收件箱 kind 前后端各一行。
3. admin BudgetView + 路由 + 菜单。

### P3：压缩模型（backend + admin 零改动）

1. `CompactionModelResolver` + orchestrator 接线；回退语义单测。

## 7. 测试方案（全部 Vitest）

- 计价：`prompt=1000, cached=400, completion=200, pi=2, po=8` → `cost_micros = round((1000−200)×2 + 200×8) = 3200`；任一价格 NULL → NULL；totalTokens=0 失败行 → 0；cached > prompt 异常行钳制后成本不为负；大数精度（tokens × price ≈ 2×10¹⁵）无浮点漂移。
- 快照：改价后新调用用新价、历史 `cost_micros` 不变；模型软删后兜底 → NULL；`LlmModelConfig` 缺价格字段走兜底缓存（TTL 内仅查一次）。
- 聚合：`AdminAnalyticsService` 成本列与手工 SUM 一致；connectivity_test 被排除；CSV 含成本列且 NULL → 空串。
- 预算：GLOBAL/USER/AGENT 三 scope 命中矩阵；BLOCK 入口矩阵（WS 手动发送/编辑重发收到显式 error 事件且消息未落库未入队、autoConsumeQueue 释放占位并原位回补不重复、open run 信封 code、定时任务 FAILED 且不落 USER 消息 phase 不进 RUNNING）；**运行中任务不被打断**（BLOCK 后在途执行正常终态）；排队消息 BLOCK 留队 + 收件箱去重一次；WARN 同周期同预算仅一条收件箱（跨周期重置）；enabled=0 立即失效；子代理不重复检查。
- 权限：`budget:read/write` 越权 403；USER 角色不可见 BudgetView。
- CompactionModelResolver：未配 / 已删 / 停用 / model_type 非文本四种回退；`scene=compaction` 的 llm_call 落到新模型 id。

## 8. 风险与对策

- **写时快照的口径迁移成本**：一旦上线，历史成本不可随价格修正重算。对策：文档明示；管理后台价格编辑处提示"仅影响后续调用"。
- **cached ⊆ prompt 假设不成立的供应商**：按"含缓存折算价"填写价格（文档写明换算方法），不改公式。
- **BLOCK 误伤**：BLOCK 与 WARN 是独立行，管理员可只配 WARN；open run 的错误 message 携带 scope/消耗/上限便于调用方自诊；GLOBAL BLOCK 提供管理员"停用预算行"的紧急出口（就是删行/停用，无额外豁免机制）。
- **admission SUM 性能**：GLOBAL scope 全表月度聚合最重。对策：索引范围扫描 + 观察项（>100ms 引入 TTL 缓存，见 §5.6）。
- **Webhook 连败停用联动**：预算 BLOCK 计 FAILED 会加速触发器自动停用——这是期望行为（止损优先），文档标注；被误停的触发器重新 enable 时连败计数清零（现有语义）。

## 9. 落地清单

- [ ] V135 / V136 迁移
- [ ] 价格下发 + 成本快照写入（主路径 + 兜底缓存）
- [ ] 用量分析 6 Tab / 明细 / CSV 成本列 + `llmCallLabels.ts` 修正
- [ ] 模型表单价格字段（DTO/VO/repository/表单）
- [ ] `BudgetService` + 四类入口 BLOCK（WS 手动发送/编辑重发、WS 队列消费、open run、定时任务）+ `BUDGET_EXCEEDED` 错误码
- [ ] `BUDGET_WARN` 收件箱 kind（`@mao/contracts` InboxKind + 后端 `isInboxKind` 白名单 + 偏好默认开 + InboxDrawer KIND_META）
- [ ] admin BudgetView + `budget:*` 权限码
- [ ] `CompactionModelResolver` + orchestrator 接线
- [ ] CHANGELOG 发版条目 + skills/mao-cli 同步 + proposals 状态更新

## 10. 决策记录（相对提案的修正与确认）

1. **写时快照定价**：`cost_micros` 在调用完成时按当刻价格计算落库；历史不回填、改价不追溯。读时计算无法重现历史价（模型价格行可变），快照是唯一自洽口径。
2. **`cost_micros BIGINT` 整数存储**：微单位避免 DECIMAL 聚合的浮点误差，SUM 与比较全整数；展示层除以 1e6。
3. **缓存 5 折是口径而非精确值**：各供应商缓存折扣不同（OpenAI 50%、Anthropic 90% 等），统一 5 折简化模型，精确需求走"折算价填写"（文档给方法）。
4. **预算检查只在任务准入点**（WS 发送 / open run / 定时任务），不做运行中打断与轮级熔断：mid-run 熔断会留下半完成的文件操作，治理收益低于破坏性成本；子代理跟随父会话准入。
5. **排队消息 BLOCK 留队不丢弃**：用户可能正在调预算；配合一次性收件箱提醒避免静默积压。
6. **Open API/Webhook 的 BLOCK 计入触发失败**：与连败自动停用护栏正向联动，是 runaway 场景的止损闭环；不产生出站事件（任务未启动，无 task.failed 终态可投递）——HTTP 错误信封 + 触发器停用通知（TRIGGER_DISABLED 收件箱）承担反馈。
7. **GLOBAL BLOCK 不设豁免开关**：紧急出口 = 停用预算行（budget:write），行为单一可审计。
8. **价格随 `LlmModelConfig` 下发为主路径**：模型行在 buildContext 已加载，零额外查询；`LlmCallService` 兜底缓存只为覆盖非标准路径，允许双路径并存（结果一致由单测锚定）。
9. **connectivity_test 不计成本聚合**：与现有 `excludeConnectivity` 口径一致，避免管理员连通性测试污染成本趋势。
10. **币种不建模**：`price_*` 只是数字，单位口径由实例管理员统一（README/管理后台文案明示），避免引入汇率设施。
11. **WS BLOCK 走显式 error 事件、不依赖异常冒泡**（评审修正）：dispatch 外层 catch 只 console.error，抛 BusinessException 前端无感知；`edit_and_resend` 是不经过 `handleSendMessage` 的独立执行入口，必须一并接线——WS 侧入口实为"手动发送/编辑重发 + 队列消费"两类。
12. **定时任务检查点在直跑分支 `updatePhase` 之前**（评审修正）：原"`liveExecution` 调用前"位置 USER 消息已落库、phase 已 RUNNING，被拒需回滚孤儿数据；busy 入队分支不检查，与"排队消息消费时再查"的既有语义一致。
13. **成本唯一口径 = `llm_call`**（评审澄清）：页面既有 token 列来自 message 表 / V073 `llm_usage`，与成本列来源不同，UI 不承诺 `成本 = token × 单价` 的直觉换算；趋势聚合注意 llm_call 与 chat+background 的包含关系，scope 相加不重复累计。

## 11. 验收口径

1. admin 模型表单填价后，发起任务 → llm-call 明细与用量分析出现非零成本；改价后历史行成本不变。
2. 配 USER 月度 BLOCK 预算并人为超线：该用户新任务被拒（桌面发送/编辑重发即时收到错误 toast；开放 API 调用返回 code≠0 信封），运行中任务正常完成，收件箱收到提醒。
3. 配 WARN 行：越线后收件箱恰好一条"预算提醒"，同月重复触发不重复提醒。
4. `compaction.modelId` 配置低价模型后，长会话压缩的 llm_call（scene=compaction）落到该模型，压缩功能行为无回归。
5. 全量 `cd backend-ts && npm test` 通过，新增 spec 覆盖 §7 全部用例。
