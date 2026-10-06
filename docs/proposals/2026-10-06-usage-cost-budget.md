# 提案：用量成本核算与预算管控 —— 给用量分析加上"钱"与"闸门"

- 状态：已转入实施（2026-10-06；技术方案见 [docs/plan/2026-10-06-usage-cost-budget-technical-design.md](../plan/2026-10-06-usage-cost-budget-technical-design.md)）
- 日期：2026-10-06
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

1. **有量没钱**：`llm_call` 表（`llm-call.repository.ts`）已记录 prompt/completion/cached/total tokens、耗时、重试与维度（user / session / agent / model / scene），管理后台用量分析六个 Tab 齐全。但全库没有 price / cost / 费用概念——管理员面对十几个模型配置，回答不了"这个月哪个 Agent 烧了多少钱"。
2. **失控面刚刚变大**：开放 API + 入站 Webhook 刚上线，外部系统第一次可以编程触发运行。Webhook 风暴、调用方循环触发等故障的爆炸半径从"用户手动多点了几次"变成"无人值守持续烧 Key"。现有护栏只有 Webhook 连续失败自动停用，费用维度没有任何闸门。
3. **最贵的辅助链路没有独立模型**：标题、commit message、评险（approval.modelId）、记忆抽取（memory.extractionModelId）都已支持独立配模型，唯独压缩（`session-compaction-orchestrator.ts` 直接传主模型）——压缩恰恰是长任务里 token 量最大的辅助调用，用主模型跑摘要是最贵的组合。

## 2. 目标 / 非目标

**目标**

1. 模型价格可配（输入 / 输出 per 1M tokens），`llm_call` 落成本，用量分析全维度可看钱。
2. 预算管控：按用户 / Agent 维度设周期预算（金额或 token），软预算超额提醒（进任务收件箱）、硬预算超额拒新任务，两档可选。
3. 压缩模型独立配置（`compaction.modelId`，缺省回退主模型），补齐辅助调用路由的最后一块。

**非目标**

- 不做计费 / 账单 / 充值（自托管无商业闭环）。
- 不做实时限流框架（预算是周期粒度 + 简单累计，不引组件）。
- 不做多币种 / 汇率。

## 3. 技术方案

### 3.1 价格与成本（P1）

- `llm_model` 增加 `price_input` / `price_output`（per 1M tokens，NULL = 不计成本，如本地模型）。
- `llm_call` 增加 `cost_micros BIGINT`：**写入时按当时价格快照计算**，改价不影响历史账目。
- 用量分析总览 / 趋势 / 模型 / 用户 / Agent 各 Tab 增加成本维度；LLM 调用明细 CSV 导出带 cost 列。

### 3.2 预算管控（P2）

- 表 `usage_budget`（scope: USER | AGENT | GLOBAL, scope_id, period: MONTHLY, limit_cost / limit_tokens, action: WARN | BLOCK）。
- 检查点在任务执行起点（HarnessService 入口）：BLOCK 仅拒**新**任务，运行中任务不打断；拒时返回明确错误码与已用量说明。
- WARN 越线时经任务收件箱通知（notification 域已有任务事件类型，新增预算事件）；同一周期同一预算只提醒一次。
- Webhook / API Token 触发的任务被 BLOCK 时：触发方收到明确 4xx，出站事件订阅照常投递失败事件（复用现有重试退避）。

### 3.3 压缩模型配置（P3）

- settings 增加 `compaction.modelId`（admin 模型选择，缺省空 = 主模型）；场景已记 `scene=compaction`，成本归属天然清晰。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 价格字段 + cost 快照 + 用量分析成本维度 + CSV | 小 |
| P2 | 预算表 + 执行点检查 + WARN 收件箱通知 + admin 配置页 | 中 |
| P3 | 压缩模型独立配置 | 小 |

## 5. 风险与开放问题

- **写时快照 vs 读时计算**：选写时快照，代价是改价后新旧账目口径不同——在 admin 价格编辑处明示"仅影响后续调用"。
- **BLOCK 误伤**：预算设小了会挡住关键任务。缓解：BLOCK 前一档必须先经过 WARN；BLOCK 报错文案携带"跳过本预算"的管理员开关（仅 GLOBAL scope 可豁免）。
- **缓存 token 计价**：不同供应商缓存价差异大，P1 先按"缓存输入按 price_input 折半"简化，文档写明口径，后续按需加独立字段。
- **开放问题**：预算是否需要团队共享池（多用户合用一个额度）——先不做，单用户 / 单 Agent 粒度已覆盖治理诉求。

## 6. 测试要点

- price 为 NULL 不产生成本；改价后历史 `cost_micros` 不变。
- 预算 WARN 通知同周期恰好一次；BLOCK 拒新保旧（运行中任务完成不受影响）。
- Webhook 触发被 BLOCK 的 4xx 语义与出站事件投递。
- 用量分析各 Tab 成本聚合与明细 CSV 数值一致。
- `compaction.modelId` 失效回退主模型（与 approval-model-resolver 同款语义）。
