# LLM 输出速度展示技术方案

> 状态：可行，已确认（D1–D9，待实施）
> 日期：2026-10-27
> 覆盖端：backend-ts、desktop、admin；contracts / agent-cli / 安卓原生壳零改动
> 迁移：无（速度是纯派生量，读取时计算，不落库、不加列、不回填）

在「我的用量」抽屉和「用量分析」页把 LLM 输出速度（吞吐量 tok/s）展示出来。分两档：A 档是两个明细表各加一列（纯前端派生，零后端改动）；B 档是总览卡、趋势图、模型均值、会话分位（后端加解码聚合，依然是读取时计算）。

---

## 0. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| D1 | 速度口径 | **输出 tokens ÷ 解码耗时**，解码耗时 = `duration_ms − first_token_ms`。与 desktop 运行轨迹既有口径逐字节一致（`trace-display.ts` 的 `decodingMs` / `throughput`），不引入第二种算法 |
| D2 | 存储 | **不新增列、不回填、不写存储过程**。`llm_call` 自 V113 建表即有 `completion_tokens` / `duration_ms` / `first_token_ms`，全部历史行可派生。若改存 `output_tps` 列，历史全 NULL 还要回填，纯属自找麻烦。trace-display 注释里「同一数字两处真相」的教训照办 |
| D3 | 非流式调用 | **显示「—」，不用总耗时兜底**。`first_token_ms` 仅流式有值（`recording-llm-adapter.ts` 非流式分支不传），用 `duration_ms` 兜底会把 prefill 算进去，数字变慢且与流式行不可比 |
| D4 | 聚合口径 | **加权平均**：`Σ可解码行输出 tokens ÷ Σ可解码行解码秒`。不是各行 tps 的算术平均（短行会被放大）。分子分母都只计「可解码行」：`first_token_ms` 非空、不晚于结束、输出 > 0 |
| D5 | 重试 | **不剔除**。`duration_ms` 是含适配器重试的墙钟（V113 注释与 repository 注释双证），重试过的行速度被低估。单行无法区分重试段，接受低估，tooltip 注明口径 |
| D6 | 取消 / 失败行 | **照常计入**。取消行取消前确实产生了输出，`completion_tokens` 是部分量，解码差仍是合理近似；失败行 `completion_tokens` 通常为 0，自然不进分子 |
| D7 | admin 吞吐分位 | **复用既有 latency percentile 模式**（`countLlmCallLatency` + `selectLlmCallLatencyAtOffset`，`ORDER BY … LIMIT offset`），把列参数泛化为 metric（列 / 表达式）。不加新索引——与 `duration_ms` 分位同等成本，窗口查询本就全表扫 |
| D8 | 共享实现位置 | desktop 抽 `utils/throughput.ts`，`trace-display.ts` 改为转发（导出不变，既有测试不破）；admin 是独立工程不能共享，新建 `admin/src/utils/throughput.ts` 同口径实现，两文件注释互指。这是仓库既有模式（`llmCallLabels.ts` 两端各一份） |
| D9 | C 档不做 | 聊天气泡实时速度（前端计时是含工具步骤的墙钟）、流式实时速度（逐 chunk 时间戳没落库）、旧 `llm_usage` 表（无任何计时列，已被 llm_call 取代）都不做 |

---

## 1. 背景与目标

今天只有 desktop 运行轨迹面板展示速度（每轮「吞吐量 X tok/s」）。「我的用量」抽屉和 admin「用量分析」只展示 token 与耗时的绝对值——用户能看出一次调用花了多久、出了多少 token，看不出**快不快**，也没法横向比较模型。

目标：

1. **A 档**：desktop 用量抽屉明细表、admin 调用流水各加一列「吞吐」，与同表的首字 / 耗时列并列。纯前端按 trace-display 同款公式从已有字段派生，历史数据天然全覆盖。
2. **B 档**：desktop 用量抽屉总览加「平均速度」卡、趋势加「输出速度」折线；admin 模型明细表加「吞吐均值」列、会话调用质量卡加「吞吐 p50 / p95」。聚合值由后端在读取时算（SQL 加两个 CASE SUM），前端 / VO 只多两个数字字段。

不做：

- 新接口、新路由、新契约类型、新迁移、`llm_call` 加列。
- 聊天气泡内显示速度、流式输出中的实时速度（见 D9）。
- 改 `recording-llm-adapter.ts` 的采集逻辑——本方案只消费已有字段，不动写入侧。

---

## 2. 现状代码事实（实施前已核对）

行号为 2026-10-27 工作区读到的位置，实施时以符号为准，行号会漂。

### 2.1 采集侧：三个字段建表即有

| 事项 | 现状 | 位置 |
|---|---|---|
| 建表 | `llm_call`（V113）含 `completion_tokens`、`first_token_ms INT NULL`、`duration_ms INT NOT NULL DEFAULT 0` | `db/migration/V113__llm_call.sql` |
| 首字打点 | 流式首个含输出的 chunk（content / reasoningContent / toolCalls 任一非空）时记 `firstTokenMs`；**非流式不传（NULL）** | `usage/recording-llm-adapter.ts` 约 128 行 |
| 总耗时 | `Date.now() - started`，含适配器内部重试的墙钟 | 同上约 166 行 |
| 写入时机 | `finally` 块，调用 / 流结束之后；失败、取消也写一行 | 同上约 158–172 行 |
| 精度 | `created_at` 自 V142 起为 `DATETIME(3)`，语义是调用**结束**时刻（本方案不用它算速度，无影响） | `db/migration/V142__millisecond_created_at.sql` |

### 2.2 展示侧现状

| 界面 | 已展示 | 缺什么 | 位置 |
|---|---|---|---|
| desktop 运行轨迹 | 每轮：总耗时、解码耗时、**吞吐量 tok/s**、首字、tokens、成本 | 无（本方案的口径来源） | `components/center/RunTracePanel.vue` 约 133–140 行 |
| desktop 用量抽屉·明细 | 时间 / 场景 / 模型 / 入 Token / 缓存 / 出 Token / 首字 / 耗时 / 结果 / 会话 | 吞吐列 | `components/usage/UsageRecordTable.vue` |
| desktop 用量抽屉·总览 | 调用次数 / 总 Token / 成本 / 成功率 / 缓存命中率五卡 + 三饼图 | 平均速度卡 | `components/usage/UsageOverviewTab.vue` |
| desktop 用量抽屉·趋势 | Token / 请求数+命中率 / 成本三折线 | 输出速度折线 | `components/usage/UsageTrendTab.vue` |
| admin 调用流水 | 全字段表（含首字 / 总耗时列）+ 详情弹窗 + 移动端卡片 + CSV | 吞吐列 / 行 / 列 | `views/llm-call/LlmCallView.vue` |
| admin 用量分析·模型 | 首 token 均值 / 耗时均值列 + CSV | 吞吐均值 | `views/analytics/tabs/ModelTab.vue` |
| admin 用量分析·会话 | 首 token p50/p95、总耗时 p50/p95 | 吞吐 p50/p95 | `views/analytics/tabs/SessionTab.vue` |

### 2.3 既有口径（trace-display，本方案统一沿用它）

`desktop/src/utils/trace-display.ts` 约 107–120、166–169 行：

```ts
export function decodingMs(round): number | null {
  if (round.firstTokenMs == null) return null
  if (round.firstTokenMs > round.durationMs) return null   // 时钟异常不出负数
  return round.durationMs - round.firstTokenMs
}
export function throughput(round): number | null {
  const decode = decodingMs(round)
  if (decode == null || decode <= 0) return null           // 不出 Infinity
  if (round.completionTokens <= 0) return null             // 不出 0 误导
  return round.completionTokens / (decode / 1000)
}
export function formatThroughput(round): string {
  const value = throughput(round)
  return value == null ? '—' : `${value.toFixed(1)} tok/s`
}
```

该文件注释明确「解码耗时与吞吐量是纯派生量，不进 VO」——本方案把同一原则推到用量与分析场景。

### 2.4 明细表现成数据已齐

两个明细表的行对象里，算吞吐的三个字段**已经在页面上**（出 Token 列 = `completionTokens`、首字列 = `firstTokenMs`、耗时列 = `durationMs`），接口返回体（`LlmCallListItem` / `MyLlmCallRecord`）也全含——A 档不需要动后端一行代码。聚合接口（`/me/summary`、`/me/trends`、`/admin/analytics/*`）目前没有任何耗时 / 解码维度，B 档要补的仅此而已。

---

## 3. 统一口径与共享实现

### 3.1 desktop：新建 `utils/throughput.ts`，trace-display 转发

新文件承载四个纯函数，入参收敛为最小结构类型（`number | null` 字段，用量行与轨迹行都能传）：

```ts
export interface ThroughputInput {
  durationMs: number | null
  firstTokenMs: number | null
  completionTokens: number | null
}
export function decodingMs(row: ThroughputInput): number | null   // 逻辑从 trace-display 原样搬
export function throughput(row: ThroughputInput): number | null
export function formatThroughput(row: ThroughputInput): string    // '—' / 'X.X tok/s'
/** 加权平均：Σ输出 ÷ Σ解码秒；任一总量为 0（窗口内无可解码行）时 null */
export function avgThroughput(t: { decodeTokens: number; decodeMs: number }): number | null
```

`trace-display.ts` 的 `decodingMs` / `throughput` / `formatThroughput` 改为从新文件 import 后 re-export（保留原导出名与签名语义，`trace-display.test.ts` 不动也能过）。单测随实现搬到 `throughput.test.ts`，trace-display 原有用例一并迁走。

### 3.2 admin：新建 `admin/src/utils/throughput.ts`

跨工程不能共享代码，按仓库既有模式（`llmCallLabels.ts` 两端各一份）复制同口径实现，文件头注释互指：「与 desktop `src/utils/throughput.ts` 同口径，改一处必须同步另一处」。admin 只需要 `throughput` / `formatThroughput`（表格与分位展示），`avgThroughput` 由后端算好直接给数。

---

## 4. A 档：明细表加「吞吐」列

### 4.1 desktop 用量抽屉·明细

`UsageRecordTable.vue` 在「耗时」列后插一列：

```vue
<el-table-column label="吞吐" width="80" align="right">
  <template #default="{ row }">{{ formatThroughput(row) }}</template>
</el-table-column>
```

script 加 `import { formatThroughput } from '../../utils/throughput'`。非流式行（`firstTokenMs` 为 null）显示「—」，与运行轨迹一致。不改 `UsageDetailTab.vue` / 筛选 / 分页。

### 4.2 admin 调用流水（`LlmCallView.vue`）

| 位置 | 改动 |
|---|---|
| 表格 | 「总耗时」列后加「吞吐」列（`width="90" align="right"`，不挂 `hide-on-mobile`，与首字 / 总耗时两列同样窄屏保留）：`{{ formatThroughput(row) }}` |
| 详情弹窗 | 「总耗时」项后加「吞吐量」项，同 `formatThroughput(currentRecord)` |
| 移动端卡片 | 「耗时」行后加「吞吐」行 |
| CSV 导出 | header 在 `耗时(ms)` 后加 `吞吐(tok/s)`；值 `tps == null ? '' : tps.toFixed(1)`（用 `throughput(row)` 取数，与展示函数同源） |

---

## 5. B 档：聚合展示

### 5.1 后端：`/me/summary` 与 `/me/trends` 加解码聚合

**SQL 模式**（两处聚合共用，`llm-call.repository.ts`）：在 `aggregateSummary` 与 `aggregateTrend` 的 SELECT 里各加两项——

```sql
COALESCE(SUM(CASE WHEN first_token_ms IS NOT NULL AND first_token_ms <= duration_ms AND completion_tokens > 0
                  THEN completion_tokens ELSE 0 END), 0) AS decodeTokens,
COALESCE(SUM(CASE WHEN first_token_ms IS NOT NULL AND first_token_ms <= duration_ms
                  THEN duration_ms - first_token_ms ELSE 0 END), 0) AS decodeMs
```

条件与 `decodingMs` / `throughput` 逐条对齐（D4）：不可解码行两列都不计，天然不影响加权平均。`decodeMs` 单位 ms，与 `duration_ms` 列一致。

**波及点**：

| 文件 | 改动 |
|---|---|
| `usage/llm-call.repository.ts` | `LlmCallSummaryRow`、`LlmCallTrendRow` 各加 `decodeTokens: number` / `decodeMs: number`（注释写明是可解码行口径、吞吐均值的分子分母）；两个聚合方法与映射函数补字段 |
| `usage/llm-call.service.ts` | `ZERO_TREND_BUCKET` 常量加两个 0（`fillTrendBuckets` 的展开式零填充自动覆盖，无数据桶也有完整字段） |
| `desktop/src/api/index.ts` | `UsageTotals`、`UsageTrendBucket` 加同名两字段（`number`，后端补零后非空） |

不扩 `aggregateByModel` / `byScene` / `byAgent`（饼图只吃 token 与成本）。路由、权限、VO 外层结构（`MyUsageSummary` / `MyUsageTrends`）不变。

### 5.2 desktop：总览卡 + 趋势折线

**总览**（`UsageOverviewTab.vue`）：`cards` 加第六张，与既有卡片同款式：

```ts
{
  label: '平均速度',
  value: avgThroughput(t) == null ? '—' : `${avgThroughput(t)!.toFixed(1)} tok/s`,
  hint: '输出 tokens ÷ 解码耗时',
}
```

口径注脚挂在卡片下方现有 `cost-note` 那段文字里（补一句：非流式调用不计入速度）。空窗口（`isEmpty`）整页不渲染，无特例。

**趋势**（`UsageTrendTab.vue` + `trend-series.ts` + `trend-options.ts`）：

- `buildTrendSeries` 加 `tps: Array<number | null>`（桶内 `decodeMs > 0` 才算，否则 null 折线断开——与 `hitRates` 同处理）与窗口合计 `avgTps`（`ΣdecodeTokens ÷ ΣdecodeMs`）。
- `TrendSeries` 接口、`trend-series.test.ts` 补用例。
- 新增第四个 trend-block「输出速度趋势」：单折线，`tooltipFormat` 输出一位小数 + ` tok/s`，左轴同名格式化；`TREND_COLORS` 加 `speed: CHART_PALETTE[4]`（`#5ac8fa`，调色板共 10 色未占用）。
- 底部 `trend-summary` 汇总行加一项「平均速度 X tok/s」（`avgTps` 为 null 时不渲染该 span）。

### 5.3 后端：admin-analytics 模型均值与会话分位

**模型均值**（`admin-analytics.service.ts`）：

- `LlmCallModelRow` 加 `decodeTokens` / `decodeMs`（SQL 模式同 §5.1，加在 `selectLlmCallStatsByModel` 现有 `firstTokenMsSum` 一族旁边）。
- models VO 组装处（约 1516–1520 行 `avgFirstTokenMs` / `avgDurationMs` 旁边）加：

```ts
const avgThroughput =
  decodeMsSum > 0 ? Math.round((decodeTokensSum / (decodeMsSum / 1000)) * 10) / 10 : null
```

（一位小数，与桌面展示精度一致；无可解码行时为 null。）

**会话分位**（`latencyPercentiles`，约 1122–1147 行）：把 store 的列参数泛化为 metric——

```ts
type LlmCallLatencyMetric = 'first_token_ms' | 'duration_ms' | 'throughput'
const LATENCY_METRICS = {
  first_token_ms: { expr: 'first_token_ms', where: 'first_token_ms IS NOT NULL AND first_token_ms > 0' },
  duration_ms:    { expr: 'duration_ms',    where: 'duration_ms IS NOT NULL AND duration_ms > 0' },
  throughput:     { expr: 'completion_tokens / ((duration_ms - first_token_ms) / 1000)',
                    where: 'first_token_ms IS NOT NULL AND first_token_ms > 0 AND first_token_ms < duration_ms AND completion_tokens > 0' },
}
```

`AdminAnalyticsStore` 的 `countLlmCallLatency` / `selectLlmCallLatencyAtOffset` 签名由 `column: 'first_token_ms' | 'duration_ms'` 改为 `metric: LlmCallLatencyMetric`，实现处查表取 `expr` / `where` 拼 SQL（`ORDER BY ${expr} ASC LIMIT 1 OFFSET ?`）。`latencyPercentiles` 增补 `throughputP50` / `throughputP95` 两个 pick。sessions VO 的 `callQuality` 加两字段。

### 5.4 admin：ModelTab + SessionTab + 类型

| 文件 | 改动 |
|---|---|
| `views/analytics/types.ts` | `ModelStatRow` 加 `avgThroughput?: number \| null`；`CallQualitySummary` 加 `throughputP50?` / `throughputP95?: number \| null` |
| `views/analytics/tabs/ModelTab.vue` | 「耗时均值」列后加「吞吐均值」列（`width="110" class-name="hide-on-mobile"`，与两均值列同款），值 `${row.avgThroughput == null ? '-' : row.avgThroughput.toFixed(1)} tok/s`；CSV header 加 `吞吐均值(tok/s)`，值同列逻辑 |
| `views/analytics/tabs/SessionTab.vue` | `qualityItems` 在「总耗时 p95」后加「吞吐 p50」「吞吐 p95」两项，值格式化 `null → '-'`，否则一位小数 + ` tok/s`（从 `utils/throughput.ts` 导出数值版 `formatTps`，或本地一行同口径） |

---

## 6. 历史数据兼容性

**结论：完全兼容，零迁移、零回填。** 速度全部读取时派生，`llm_call` 不需要任何 schema 变更；V113 之后每一行都带齐三个源字段。

| 场景 | 表现 |
|---|---|
| V113–V142 的早期行 | `first_token_ms` / `duration_ms` / `completion_tokens` 建表即有，照常算 |
| 非流式调用（session_title、danger_assess、connectivity_test 等） | `first_token_ms` 为 NULL → 明细显示「—」，聚合不进分子分母（D3、D4） |
| 重试过的调用 | 速度被低估（墙钟含重试），tooltip 注明（D5） |
| 取消 / 失败行 | 部分输出照常计入（D6） |
| 旧 `llm_usage` 表（V073） | 无任何计时列，**无法**派生；该表已被 llm_call 取代、代码里只剩 `llm-usage.service.ts` 残留，不纳入（D9） |

一个反向确认：如果当初选择存 `output_tps` 列，全部历史行都是 NULL、要写回填迁移，且改价 / 改采集逻辑后新旧两套口径还要对齐——派生方案没有这些问题。

---

## 7. 改动文件清单

**backend-ts**

| 文件 | 改动 |
|---|---|
| `src/usage/llm-call.repository.ts` | 两个聚合行类型 + `aggregateSummary` / `aggregateTrend` 加 `decodeTokens` / `decodeMs` |
| `src/usage/llm-call.service.ts` | `ZERO_TREND_BUCKET` 补两字段 |
| `src/admin/admin-analytics.service.ts` | `LlmCallModelRow` 加两字段；models VO 加 `avgThroughput`；latency metric 泛化 + `throughputP50/P95` |

**desktop**

| 文件 | 改动 |
|---|---|
| `src/utils/throughput.ts` | **新建**：`decodingMs` / `throughput` / `formatThroughput` / `avgThroughput` |
| `src/utils/trace-display.ts` | 三个函数改为从 throughput.ts 转发（re-export），用例迁走 |
| `src/api/index.ts` | `UsageTotals` / `UsageTrendBucket` 加两字段 |
| `src/components/usage/UsageRecordTable.vue` | 明细表加「吞吐」列 |
| `src/components/usage/UsageOverviewTab.vue` | 总览加「平均速度」卡 + 口径脚注 |
| `src/components/usage/trend-series.ts` | `tps` 序列 + 窗口 `avgTps` |
| `src/components/usage/trend-options.ts` | `TREND_COLORS.speed` |
| `src/components/usage/UsageTrendTab.vue` | 「输出速度趋势」图 + 汇总行一项 |

**admin**

| 文件 | 改动 |
|---|---|
| `src/utils/throughput.ts` | **新建**：`throughput` / `formatThroughput`（+ `formatTps` 数值版） |
| `src/views/analytics/types.ts` | `ModelStatRow.avgThroughput`、`CallQualitySummary.throughputP50/P95` |
| `src/views/analytics/tabs/ModelTab.vue` | 吞吐均值列 + CSV 列 |
| `src/views/analytics/tabs/SessionTab.vue` | 吞吐 p50/p95 两张卡值 |
| `src/views/llm-call/LlmCallView.vue` | 吞吐列 + 详情项 + 移动端行 + CSV 列 |

不改：`shared/contracts`（无新枚举 / 新契约类型）、`recording-llm-adapter.ts`（采集侧零改动）、任何迁移、任何路由与权限。

---

## 8. 测试计划

**backend-ts（Vitest）**

- `usage/llm-call.repository.spec.ts`：`aggregateSummary` / `aggregateTrend` 新字段——混合流式 / 非流式 / `first_token_ms > duration_ms` 异常行 / 零输出行的 CASE SUM 映射；趋势桶补零行含新字段。
- `usage/llm-call.service.spec.ts`：`fillTrendBuckets` 对 `ZERO_TREND_BUCKET` 新字段的零填充。
- `admin/admin-analytics.service.spec.ts`：models VO `avgThroughput`（有 / 无可解码行两态）；`latencyPercentiles` 吞吐分位——store fake 按 metric 收参，验证 expr / where 拼装与 offset 计算；既有 fake 签名随 metric 泛化更新。
- 全量：`cd backend-ts && npm test > /tmp/x.log 2>&1; echo exit=$?`，grep 摘要。

**desktop（Vitest）**

- `utils/throughput.test.ts`（从 `trace-display.test.ts` 迁入 + 扩充）：`decodingMs` 的 null / 负数保护；`throughput` 的零输出 / 零解码保护；`avgThroughput` 的零分母 null、加权口径（不等分行不取算术平均）。
- `components/usage/trend-series.test.ts`：`tps` 序列 null 断开（无流式调用的桶）、窗口 `avgTps`。
- `components/usage/UsageDetailTab.test.ts`（或新组件用例）：明细表渲染出「吞吐」列，非流式行显示「—」。
- `cd desktop && npm run build`（vue-tsc + vite build，勿用 `npx vue-tsc --noEmit` 单文件假通过）。

**admin（Vitest + 构建）**

- `utils/throughput` 新用例（若抽了独立文件）：与 desktop 同口径的边界。
- `cd admin && npm run build`。

**手动验证（不发 CI）**

1. 桌面用量抽屉：明细表流式行显示具体 tok/s、非流式场景行显示「—」；总览「平均速度」与明细列同口径；趋势图速度线在无非流式桶断开。
2. admin 调用流水：表格 / 详情 / 移动端 / CSV 四处一致；模型页吞吐均值列；会话页吞吐 p50/p95。
3. 与运行轨迹对拍：同一会话同一次调用，轨迹面板的吞吐量与明细表「吞吐」列数字一致（同一公式同一行）。

---

## 9. 文档同步（同任务完成）

| 文档 | 改动 |
|---|---|
| 根 `CHANGELOG.md` | 顶部 `## x.y.z (日期)`（无则新建）「前端（桌面 / Web / 安卓）」+「管理后台」两节记本次展示新增；版本号以发版时为准 |
| `skills/mao-cli/reference/desktop.md` | 「使用记录与我的用量」表格：总览卡列表加「平均速度」、趋势图改四张、明细列加「吞吐」 |
| `skills/mao-cli/reference/analytics.md` | 模型 / 会话 Tab 字段表补吞吐均值与吞吐 p50/p95 |
| `README.md` | 如有用量 / 分析界面字段清单，同步（无则不动） |

`docs/plan/` 本文档即设计与评审记录，不随版本回改。

---

## 10. 风险与回滚

| 风险 | 评估 | 对策 |
|---|---|---|
| 加权平均被误读成「每次都快这个数」 | 中 | 卡片 hint 与 tooltip 固定写「输出 tokens ÷ 解码耗时」；趋势线按桶给真相 |
| 趋势图 null 断线被读成「掉零」 | 低 | 与缓存命中率既有断线行为一致，用户已熟悉该图式 |
| latency metric 泛化波及既有 fake / 调用点 | 中 | 改动集中在一个 store 接口两个方法；`admin-analytics.service.spec.ts` 全量跑过再收工 |
| admin 吞吐分位表达式无索引，大窗口慢 | 低 | 与 `duration_ms` 分位同等成本（本就全表扫 ORDER BY），5 分钟模块缓存兜底；若告警再议 |
| 桌面 / admin 两份实现漂移 | 中 | 两文件头注释互指 + 单测锁定同一组边界用例（两侧 fixture 相同） |

回滚：纯展示 + 读时聚合，无迁移无存储。回滚即还原上述文件重新构建部署；`llm_call` 一行不动，无数据残留。

---

## 11. 验收标准

1. desktop 用量抽屉明细表：流式行「吞吐」列显示 `X.X tok/s`，非流式行「—」；与运行轨迹同一次调用数字一致。
2. desktop 总览第六张卡「平均速度」：空窗口 / 全非流式窗口显示「—」；数值 = `ΣdecodeTokens ÷ ΣdecodeMs`。
3. desktop 趋势页四张图，速度线在无流式调用的桶断开；底部汇总行有「平均速度」。
4. admin 调用流水表格 / 详情 / 移动端 / CSV 四处都有吞吐且一致；模型页有「吞吐均值」列并进 CSV；会话页有「吞吐 p50 / p95」。
5. `backend-ts` 全量测试、`desktop` / `admin` 构建全绿；无新迁移、无 contracts 改动（`git diff --stat` 核对此三项为空）。
6. CHANGELOG 与 mao-cli 两份 reference 同任务更新。
