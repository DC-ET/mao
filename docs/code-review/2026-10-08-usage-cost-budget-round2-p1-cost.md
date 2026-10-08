# usage-cost-budget P1 成本核算 · Round 2 审查（2026-10-08）

- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/usage-cost-budget`，分支 `feat/usage-cost-budget`，提交 `be2a56d4 feat(usage): 用量成本核算与预算管控（P1 计价/P2 预算/P3 压缩模型独立配置）`。
- 审查范围（本轮仅 P1 成本核算）：
  - 后端：`backend-ts/src/usage/cost-micros.ts`、`usage/llm-call.service.ts`、`usage/llm-call.repository.ts`、`usage/recording-llm-adapter.ts`、`usage/recording-llm-chat-client.ts`、`model/model.service.ts`、`model/model.repository.ts`、`model/model.routes.ts`、`admin/admin-analytics.service.ts`、`harness/deps.ts` 的 `llmModelToConfig` 价格下发、`db/migration/V135__usage_cost_price.sql`。
  - 前端：`admin/src/views/analytics/**`（OverviewTab / TrendsTab / ModelTab / UserTab / AgentTab、chart-options.ts、types.ts、composables）、`admin/src/utils/llmCallLabels.ts`、`admin/src/views/llm-call/LlmCallView.vue`、`admin/src/views/model/ModelFormDialog.vue`。
  - 桌面/安卓：grep 确认 `desktop/src`、`android` 无任何成本展示（`成本`/`costMicros`/`totalCost` 零命中），收件箱 BUDGET_WARN 相关属 P2，不在本轮范围。
  - 测试：`cost-micros.spec.ts`、`llm-call.service.spec.ts`、`model.service.spec.ts`、`admin-analytics.service.spec.ts`。
- 方法：通读实现 + 测试；重跑在范围内的 4 个 spec（75 passed）；对计价公式写 30 万组随机用例与 BigInt 精确有理数运算对拍（`/tmp/costprobe/p2.ts`）；用本机 MySQL 8.0.46（sql_mode 含 STRICT_TRANS_TABLES）建 scratch 库 `cost_probe`，按真实表结构（V113 + V135 列）灌数后直接跑 `AdminAnalyticsDbStore` 的 5 处聚合 SQL 与 `LlmCallRepository.insert` / `LlmCallService.record` 全链路（`/tmp/costprobe/sql.ts`、`/tmp/costprobe/e2e.ts`）；`el-input-number` 的清空语义按仓内 element-plus 2.14.0 源码核对。探针均在 /tmp，scratch 库已 DROP，未改动任何被审源码/spec。
- 结论：**发现 1 个功能性 BUG（低）**，P1 计价主链路（公式口径、NULL/0 语义、快照主路径与兜底缓存一致性、聚合 SQL、前后端字段/单位对齐、环比）全部正确，详见文末核对清单。

---

## BUG 1（低）：`priceInput`/`priceOutput` 未按 `DECIMAL(12,6)` 的值域/小数位校验，超域价格让模型新增/编辑直接 500，亚微价格被静默取整

**文件:行号**：

- `backend-ts/src/model/model.service.ts:56-62`（`normalizePrice`）
- `backend-ts/db/migration/V135__usage_cost_price.sql:3-5`（`price_input`/`price_output` 为 `DECIMAL(12,6)`，整数位仅 6 位，上限 999999.999999）
- `admin/src/views/model/ModelFormDialog.vue:78-99`（价格输入框 `:max="1000000"`、`:precision="6"`）

**问题描述（含最小复现代码/输入）**：

`normalizePrice` 只拒绝 null / 非有限数 / 负数，不校验 DECIMAL(12,6) 的两位有效范围（量级 ≤ 6 位整数、≤ 6 位小数）：

```ts
// model.service.ts:56
function normalizePrice(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${field} 必须是非负数字`);
  }
  return value;   // ← 1e6、1e12、0.0000004 全部原样放行
}
```

而 `DECIMAL(12,6)` 的整数位只有 6 位。用本机 MySQL 8.0.46（STRICT_TRANS_TABLES）实测同一列：

```
mysql> INSERT INTO t (price_input DECIMAL(12,6)) VALUES (1000000);
ERROR 1264 (22003): Out of range value for column 'price_input' at row 1
mysql> INSERT INTO t (price_input) VALUES (1000000000000);   -- 同样 1264
mysql> INSERT INTO t (price_input) VALUES (0.0000004);      -- 无告警，落库 0.000000
mysql> INSERT INTO t (price_input) VALUES (0.0000005);      -- 无告警，落库 0.000001
mysql> INSERT INTO t (price_input) VALUES (999999.999999); -- OK
```

两条可实跑复现路径：

1. **HTTP / 单元层**：`PUT /v1/models/1` body `{"priceInput": 1000000}`（或 `1000000000000`、`2500000`）→ `updateModel` 的 `normalizePrice` 放行 → `MysqlLlmModelRepository.updateById` → `db.updateById('llm_model', ...)` 抛 `ER_WARN_DATA_OUT_OF_RANGE`（1264）→ 路由无兜底，前端收到 500。仓内等价 vitest 写法：`await expect(service.createModel('n','p','https://x','k','m',0,0,null,'text',null,null,null,1_000_000, 8)).resolves.toBeDefined()`（当前通过，说明 service 层没拦），再接真实仓储 insert 即抛 1264。
2. **管理后台 UI**：模型管理 → 编辑/新增文本模型 → 在「输入价格」输入 `2500000`：`el-input-number` 的 `:max="1000000"` 会把它**钳成 1000000**（恰恰是唯一越界的可输入值），保存即 500；用户看到的是无信息量的服务端错误，而不是「价格需 ≤ 999999.999999」。

附带一个静默数据失真：亚微价格（< 0.0000005）经 DECIMAL 四舍五入后落库为 `0.000000`，即被写成"免费模型"，与管理员填写的意图相反且无任何提示；`normalizePrice` 的注释"最多 6 位小数由 DECIMAL(12,6) 保证"并不成立（是静默取整，不是保证）。

**业务影响**：

- 价格填成 ≥ 1,000,000（含 UI 越界输入被 max 钳位后的值）时，模型新增/编辑接口 500，管理员无法保存该模型；价格列因此成为"能填但不能存"的半开放字段。
- 价格填成 0.0000001~0.0000004 时静默变成 0，模型被记为免费，后续 `cost_micros` 恒 0（"价格为 0 是合法免费模型 → 0"的口径被意外触发），成本核算结果偏低且无从察觉。
- 触发前提是极端/手误价格（正常价 0.001~100 完全不受影响），故定低危；属输入校验缺口而非计价链路错误。

**严重度**：低（功能可用域外的输入校验缺口；修复面一行：`normalizePrice` 内按 `DECIMAL(12,6)` 上限与 6 位小数校验/量化，越界抛 `PARAM_INVALID`，顺带把前端 `:max` 改成 999999.999999 或加校验提示）。

---

## 已逐项核对且未发现问题的点（P1 成本核算）

1. **计价公式（`cost-micros.ts:26-37`）**：与设计 §5.2 逐字一致。30 万组随机输入（价格 0~2 按 6 位小数、prompt ≤ 30 万、cached ⊆ prompt）与 BigInt 精确有理数运算对拍，**0 例偏差**，最大偏差 0 微单位（`/tmp/costprobe/p2.ts`）。`prompt_billable = max(0, prompt − cached×0.5)` 钳制正确；cached=1、prompt=1 → 计 0.5 份（round 得 1 micro）无符号错误；任一价格为 NULL → NULL；双 0 价 → 0；tokens × price 极值（≈2×10¹⁵）仍在 `Number.isSafeInteger` 内。
2. **快照主路径与兜底路径一致性**：真实 MySQL + 真实 `LlmCallService.record` 链路实测——配价模型（2.5/8，usage 1000/400/200）→ `cost_micros=3600`；双 0 价模型 → `0`（非 NULL）；未配价模型 → `NULL`；配置不带价格字段的旧路径（`git-commit-message.service.ts` 的 `toConfig`）经 60s TTL 缓存回查同一模型行 → 同为 `3600`，主/兜底口径一致；模型软删后（`deleted=1`）→ `NULL`（负缓存，60s 内仅 1 次查询）。`LlmCallModelConfig` 与 `LlmModelConfig` 两个接口的价格字段语义一致。
3. **价格下发覆盖面**：`harness/deps.ts:288` 的 `llmModelToConfig` 为 AgentLoop、compaction、session-title、memory-extract、approval、danger-assess、proxy-approve 等全部走中心模型解析的路径下发价格；其余 `LlmModelConfig` 字面量构造点（`git-commit-message.service.ts:242`、`weixin/voice-synthesis.service.ts:70`、`create-app.ts:1384` 飞书摘要、`model.service.ts:256` 连通性测试）因未带价格字段而走兜底缓存，均已核对正确（飞书摘要 config 不带 `id` → 成本 NULL，未把"无 usage"的调用记成 0 成本污染合计）。
4. **5 处聚合 SQL（`admin-analytics.service.ts:344/364/410/425/452`）**：真实 MySQL 实测 `COALESCE(SUM(cost_micros),0)/1000000 AS cost`——3200 微单位 → `0.0032`，单位换算正确；`COALESCE` 对全 NULL 行返回 0；mysql2（`decimalNumbers:true`）返回 JS number，service 层 `toNumber` 又兜住 DECIMAL string 形态（spec 有锚定用例）。COUNT 实为 5 处。
5. **cost 口径一致性（决策 13）**：`trendsScope.periodTotals.totalCost`（sumTrends 逐日累加）、`modelsScope.periodTotals.totalCost`（模型行累加）、`callQuality.cost`、`sessionsScope.callQuality.cost`、`previousTotals.totalCost` 同源同口径，全部只走 `llm_call`，不叠加 message/llm_usage 的 token；环比前窗同过滤条件（同 `excludeConnectivity`、同天数）。
6. **connectivity_test 排除**：`llmCallWhere`（`:314-328`）默认排除，实测排除前后窗口成本 `0.0032` vs `0.0037` 正确；`scene` 列 NOT NULL DEFAULT 'unknown'（V113），`scene != 'connectivity_test'` 不会因 NULL 丢掉行（实测 NULL scene 直接插入即被拒）。
7. **小时粒度**：`DATE_FORMAT(created_at,'%Y-%m-%d %H:00')` 与连接时区 `+08:00` 一致（实测桶值正确），`normalizeBucket`/`buildTrendBucketKeys` 的当前整点封顶逻辑正确（含 endOffset=1 不封顶）。
8. **前后端字段/单位对齐**：`PeriodTotals.totalCost`、`TrendPoint.cost`、`ModelStatRow/UserActivityRow/AgentStatRow.cost`、`CallQualitySummary.cost` 与后端逐字段同名同义；`LlmCallView.formatCostCell(costMicros/1e6)`、CSV 导出 `(costMicros/1e6).toFixed(6)`、NULL → 空串/'-' 均正确；ModelTab/UserTab/AgentTab 的 CSV 列序与表头一致。小数价格 0 → 显示"0"、未配价 → '-'，与"0 合法 / NULL 不计成本"的口径一致。
9. **模型表单与后端 null/0 语义闭环**：el-input-number 2.14.0 的 `valueOnClear` 默认 `null`（源码核对），清空输入框即显式 null → `updateModel` 的 `priceInput !== undefined` 分支清空价格；未提供（undefined）保留原价；`0 ?? null` 保留 0；非文本模型强制置 null。
10. **成本展示无 NaN 路径**：`formatCost(null/undefined/非有限)` → '-'；service 层 `toNumber` 兜住 string/null；TrendsTab 的 `t.cost ?? 0`、`(t.cost || 0) > 0` 判空正确。
11. **测试与构建基线**：`cd backend-ts && npx vitest run src/usage/cost-micros.spec.ts src/usage/llm-call.service.spec.ts src/model/model.service.spec.ts src/admin/admin-analytics.service.spec.ts` → 4 文件 75 用例全绿（本轮重跑确认）；`computeCostMicros`/`snapshotCostMicros`/负缓存/DECIMAL string/环比同口径均有锚定用例，无被削弱的断言。
