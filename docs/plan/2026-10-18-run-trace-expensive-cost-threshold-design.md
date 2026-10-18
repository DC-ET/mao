# 运行轨迹「贵」改为按成本判定技术方案

- 状态：待实施（2026-10-18 设计）
- 日期：2026-10-18
- 上游方案：[docs/plan/2026-10-09-run-trace-technical-design.md](2026-10-09-run-trace-technical-design.md)（本方案只改其中「慢 / 贵阈值」一项，其余口径不变）
- 涉及版本条目：`## 0.0.305`（未建则新建，写入 CHANGELOG 顶部）

## 1. 需求背景

轨迹面板的「贵」徽标现在只看 token 量：`promptTokens + completionTokens >= expensiveTokens`（默认 50000）。这个口径有两个实际问题：

1. **与「贵」的字面含义不符**。用户问「贵」的标准是什么时，期待的是花了多少钱，而不是上下文有多大。token 高但单价极低的模型（如 `deepseek-v4.1-flash`）会被连续打标，成本只有 0.012 却显示「贵」，信号被稀释成噪声。
2. **长会话必然全标**。上下文随轮次累积，第 10 轮的输入天然大于第 1 轮。到 50 万 token 时每一轮都过阈值，徽标失去区分度（用户实测 550k tokens / 成本 0.014 的轮次同样被标「贵」）。

模型价格已经在链路上配齐：`llm_call.cost_micros`（V138）落库，VO 已透传为 `costMicros`，面板每行已显示「成本 0.012」，总览已显示「总成本」。改成成本判定**不需要新增表、新增查询或新增计算**，只是把同一个数字与阈值比较。

用户已明确两条边界，本方案据此收敛：

- **未配置价格的调用一律不算贵**（不设 token 回退口径，不做两套阈值）。
- **便宜就是便宜**：没到阈值就不标，不需要为便宜模型保留告警。

## 2. 需求描述

### 2.1 目标

1. 「贵」判定改为**单轮成本**：`costMicros >= 阈值`。`costMicros` 为 null（该轮模型未配价）时不算贵。
2. 阈值单位从 token 数改为**价格填写口径的金额**（与 `formatCost` 展示、CSV `成本` 列、管理后台用量分析同一单位），默认值见 §5.2。
3. 输入框、localStorage、query 参数、路由钳制、徽标、文档、CHANGELOG 同批改完，不留 token 口径残留。
4. 慢阈值、run 汇总、CSV/JSON 导出数据结构、admin 三个榜**全部不变**。本次只动「贵」一个判定。

### 2.2 非目标

- **不做 token 回退**。未配价不标「贵」，不加「或 token 超阈值也标」的并联口径。
- **不做 run 级「贵」**。仍是轮级判定、run 徽标由任一轮聚合而来（`runAttentionBadges` 现有逻辑不动）。
- **不改 admin「最贵的轮」榜**。它已按 `cost_micros DESC` 排序并过滤 `cost_micros IS NOT NULL`，与新口径天然一致，无需改动。
- **不改 CSV/JSON 导出的列与值**。`expensive` 是后端算好的布尔，徽标语义变了但数据结构与导出口径不变。
- **不做预算告警、不做按模型单价分组**。
- **不改成本计算本身**（`sumCostMicros`、`cost_micros` 落库口径）。

## 3. 范围界定

### 3.1 做什么

| 层 | 文件 | 改动 |
|---|---|---|
| backend-ts | `src/session/run-trace.service.ts` | `RunTraceQuery.expensiveTokens` → `expensiveCost` / `expensiveCostMicros`；`toRoundVO` 判定改为 `call.costMicros != null && call.costMicros >= query.expensiveCostMicros` |
| backend-ts | `src/session/session.routes.ts` | query 参数名与钳制范围改为金额口径 |
| backend-ts | `src/session/session-vo.ts` | 注释口径同步（VO 字段名不变） |
| backend-ts | `src/session/run-trace.service.spec.ts`、`session.routes.spec.ts` | 阈值边界、未配价不标、钳制范围用例改写 |
| desktop | `src/types/trace.ts` | `TraceThresholds.expensiveTokens` → `expensiveCost`，默认值改金额 |
| desktop | `src/stores/session/trace.ts` | localStorage key 换版（见 §5.4），读取逻辑改字段名 |
| desktop | `src/components/center/RunTracePanel.vue` | 输入框单位、clamp 常量、query 传参、tooltip 文案 |
| desktop | `src/components/center/run-trace-panel-session.test.ts` | store mock 的阈值字段名与默认值 |
| desktop | `src/utils/trace-display.test.ts`、`trace-export.test.ts` | fixture 字段名 |
| 文档 | `skills/mao-cli/reference/desktop.md` | 「阈值」小节口径 |
| 文档 | `CHANGELOG.md` | 新增条目 |

### 3.2 不做什么

- 不加数据库迁移。
- 不动 `llm_call` 落库、不动 `sumCostMicros`、不动 admin analytics。
- 不动「慢」的任何逻辑。
- 不给「贵」加 tooltip 解释文案（保持与「慢」一致的最小改动；输入框 title 已说明含义）。
- 不迁移用户历史阈值偏好（见 §5.4 换 key 方案）。

## 4. 技术选型与关键决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 判定量 | 单轮 `cost_micros`，不看 token |
| D2 | 未配价 | 一律不算贵，不回退 token |
| D3 | 阈值单位 | 价格填写口径的金额（即 `costMicros / 1e6` 后的数），不用 micros 存 |
| D4 | 阈值命名 | `expensiveCost`，与旧名 `expensiveTokens` 显式区分，避免 localStorage 混读 |
| D5 | localStorage | 换 key，不做值迁移 |
| D6 | 默认值 | 0.5（价格口径），上限 1000 |
| D7 | 徽标与聚合逻辑 | `runAttentionBadges` / 轮级徽标不改，只换布尔来源 |
| D8 | admin 最贵榜 | 不改（已是成本口径） |

## 5. 详细设计

### 5.1 后端判定（`run-trace.service.ts`）

**接口字段**：`RunTraceQuery` 的 `expensiveTokens: number` 改为 `expensiveCost: number`，注释写清单位与未配价语义：

```ts
export interface RunTraceQuery {
  beforeRunId: number | null;
  limit: number;
  slowMs: number;
  /** 单轮成本达到该值（价格填写口径）记「贵」；未配价（cost_micros 为 null）一律不算贵 */
  expensiveCost: number;
}
```

**判定**（`toRoundVO`，当前在 `backend-ts/src/session/run-trace.service.ts:372-374`）：

```ts
    slow: durationMs >= query.slowMs,
    // 贵看单轮成本，与模型价格配置联动；未配价的行不计贵（用户明确：便宜就是便宜）
    expensive: call.costMicros != null && call.costMicros >= query.expensiveCostMicros,
```

`expensiveCostMicros` 由**路由**在钳制时一次性换算，服务端只做整数比较，不在 `toRoundVO` 里做浮点乘。换算公式：

```
expensiveCostMicros = Math.round(expensiveCost * 1_000_000)
```

理由：`cost_micros` 是整数微元，`toRoundVO` 每条轮次要跑一次，把浮点乘法留在路由单次执行，服务端循环内只比整数，避免 `0.1 * 1e6` 这类浮点误差在边界上抖动。

`toRoundVO` 的签名随之多一个参数（或在 `RunTraceQuery` 里同时带两个字段）。推荐后者：`RunTraceQuery` 增加 `expensiveCostMicros`，路由负责填，服务端直接读，`toRoundVO` 签名不变。

```ts
export interface RunTraceQuery {
  beforeRunId: number | null;
  limit: number;
  slowMs: number;
  /** 展示参数：价格填写口径的金额阈值（前端输入框与文档说明用） */
  expensiveCost: number;
  /** 同一阈值的 micros 形式，判定用；由路由换算，服务端只比整数 */
  expensiveCostMicros: number;
}
```

**不变的逻辑**：`toRoundVO` 里 `promptTokens` / `completionTokens` / `cachedTokens` / `cacheCreationTokens` 的取值与 0.0.304 的缓存口径修复（CHANGELOG:22）完全保留，不要顺手改回四类相加。

### 5.2 路由钳制（`session.routes.ts`）

当前在 `backend-ts/src/session/session.routes.ts:538-539`：

```ts
    const slowMs = clamp(queryOptInt(request, 'slowMs') ?? 60_000, 1_000, 3_600_000);
    const expensiveTokens = clamp(queryOptInt(request, 'expensiveTokens') ?? 50_000, 1_000, 10_000_000);
```

改为：

```ts
    const slowMs = clamp(queryOptInt(request, 'slowMs') ?? 60_000, 1_000, 3_600_000);
    // 贵阈值是价格填写口径的金额，允许小数；queryOptInt 只取整数，这里改用浮点解析
    const expensiveCost = clampCost(queryOptFloat(request, 'expensiveCost') ?? DEFAULT_EXPENSIVE_COST);
    const expensiveCostMicros = Math.round(expensiveCost * 1_000_000);
```

要点：

- `queryOptInt` 只返回整数（`backend-ts/src/common/request.ts:25-32`），`expensiveCost=0.5` 会被 `Number('0.5')` 正常解析成 0.5，但函数名与语义不再匹配。新增 `queryOptFloat`（同文件，`Number.isFinite` 判定，`undefined` 表示缺省/非法）或直接复用 `queryOptInt` 并改名为 `queryOptNum`。**推荐新增 `queryOptFloat`**，避免动 `queryOptInt` 的其他调用点。
- 钳制范围：`COST_MIN = 0.001`，`COST_MAX = 1000`。上限 1000 对应一次调用花一千块，足以覆盖任何单轮；下限 0.001 对应千分之一元，与 `formatCost` 的三位小数精度对齐。
- `Math.round(cost * 1e6)` 前先 clamp，防止 `1000.0000004` 之类的越界值。

**默认值定义**：`DEFAULT_EXPENSIVE_COST = 0.5`，与 `DEFAULT_TRACE_THRESHOLDS.expensiveCost` 保持一致，两侧各自定义（后端不 import 前端常量，与现有 `slowMs` 默认值的做法一致）。

默认值取 0.5 的依据：用户截图里 545k tokens 的一轮成本 0.012，0.5 约为其 40 倍，能把这类长会话低价轮全部排除；同时一个正常使用中档模型的单轮（几十万 token × 单价每百万几元）通常也在 0.5 以下，只有真正异常的大轮才会触发。若上线后反馈偏松/偏紧，调默认值即可，逻辑不动。

### 5.3 桌面阈值存储（`stores/session/trace.ts`）

**换 key**：`THRESHOLDS_KEY` 从 `'mao:trace-thresholds'` 改为 `'mao:trace-thresholds:v2'`。

理由：旧 key 里存的是 `{ slowMs, expensiveTokens }`，`expensiveTokens` 是 50000 这样的整数。若沿用同 key，老用户下次打开会被读成 `expensiveCost = 50000`，clamp 到上限 1000，于是「所有轮都贵」——正好是本次要消除的现象。换 key 让老用户回到默认 0.5，`slowMs` 也回到 60s（可接受的一次性重置，`slowMs` 默认值本就够用）。

**读取逻辑**：

```ts
const THRESHOLDS_KEY = 'mao:trace-thresholds:v2'

function loadThresholds(): TraceThresholds {
  try {
    const raw = localStorage.getItem(THRESHOLDS_KEY)
    if (!raw) return { ...DEFAULT_TRACE_THRESHOLDS }
    const parsed = JSON.parse(raw) as Partial<TraceThresholds>
    const slowMs = typeof parsed.slowMs === 'number' && parsed.slowMs > 0
      ? parsed.slowMs
      : DEFAULT_TRACE_THRESHOLDS.slowMs
    const expensiveCost = typeof parsed.expensiveCost === 'number' && parsed.expensiveCost > 0
      ? parsed.expensiveCost
      : DEFAULT_TRACE_THRESHOLDS.expensiveCost
    return { slowMs, expensiveCost }
  } catch {
    return { ...DEFAULT_TRACE_THRESHOLDS }
  }
}
```

注意 `expensiveCost` 可能是 `0.0005` 这种小数，`> 0` 判定对小数成立，不要误写成 `Number.isInteger`。`safeSetItem` 与 `watch` 持久化逻辑不变（字段名变了，JSON 结构自然跟着变）。

### 5.4 类型定义（`types/trace.ts`）

```ts
/** 慢 / 贵阈值：展示参数，桌面记 localStorage（不新建偏好表）。
 *  贵按单轮成本（价格填写口径）判定，未配价的轮不算贵。 */
export interface TraceThresholds {
  slowMs: number
  expensiveCost: number
}

export const DEFAULT_TRACE_THRESHOLDS: TraceThresholds = { slowMs: 60_000, expensiveCost: 0.5 }
```

### 5.5 面板输入框（`RunTracePanel.vue`）

**模板**（当前 `desktop/src/components/center/RunTracePanel.vue:21-34`）：

```html
        <label class="threshold-field" title="模型调用成本达到该值记「贵」；模型未配置价格时不算贵">
          <span>贵 ≥</span>
          <el-input-number
            v-model="expensiveCostInput"
            :min="0.001"
            :max="1000"
            :precision="3"
            :step="0.1"
            :controls="false"
            size="small"
            @change="applyThresholds"
          />
          <span>元</span>
        </label>
```

- `:precision="3"` 让 `el-input-number` 保留三位小数（与 `formatCost` 精度一致）。不加 `precision` 时组件会按 step 推小数位，`0.5` 能显示但 `0.001` 可能被抹掉。
- `:step="0.1"` 保持键盘上下键的可用步进；`:controls="false"` 维持现状。
- 单位文案从 `tokens` 改为 `元`。tooltip 从「四类 token 之和达到该值记『贵』」改为「模型调用成本达到该值记『贵』；模型未配置价格时不算贵」。

**脚本常量与 clamp**（当前 `RunTracePanel.vue:263-264`、`286-297`、`308`）：

```ts
const SLOW_MS_MIN = 1_000
const SLOW_MS_MAX = 3_600_000
const COST_MIN = 0.001
const COST_MAX = 1000
```

`clamp` 函数当前是 `Math.min(max, Math.min(max, Math.round(value)))` 形式（整数语义），需要改为保留小数：

```ts
function clampCost(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
```

`slowMs` 继续用整数 `clamp`（保留 `Math.round`），两条路径分开，避免互相影响。

`applyThresholds`：

```ts
function applyThresholds() {
  sessionStore.setTraceThresholds({
    slowMs: clamp(slowMsInput.value, SLOW_MS_MIN, SLOW_MS_MAX),
    expensiveCost: clampCost(expensiveCostInput.value, COST_MIN, COST_MAX),
  })
  void reload()
}
```

`fetchTracePage` 的 params 从 `expensiveTokens` 改为 `expensiveCost`（`RunTracePanel.vue:308` 附近）。

`expensiveTokensInput` 重命名为 `expensiveCostInput`，watch 分支同步。

**成本展示复用**：面板已有 `formatCost(costMicros)`（`RunTracePanel.vue:429-432`，`costMicros / 1_000_000` 后三位小数）。输入框填的就是这个数，用户看到每行「成本 0.012」后填 0.5，认知一致。不要在输入框旁再显示换算后的 micros。

### 5.6 徽标与聚合

`runAttentionBadges`（`desktop/src/utils/trace-display.ts:30`）与轮级徽标（`RunTracePanel.vue:130`）**不改**：

```ts
if (rounds.some((r) => r.expensive)) badges.push({ label: '贵', tone: 'info' })
```

布尔值来自后端，语义换了但聚合逻辑一致：run 徽标 = 任一轮贵。`runSeverity` 的 `info` 分级也不变。

### 5.7 导出与 VO

- `session-vo.ts` 的 `TraceRoundVO.expensive` 注释补一句「成本口径，未配价为 false」。字段名与类型不变，CSV/JSON 导出零改动。
- `trace-export.ts` 不动：它的 `costCell` 已按 `costMicros / 1e6` 六位小数输出，与输入框单位天然对齐。

### 5.8 admin

`admin-analytics.service.ts` 的 `selectRunTraceMostExpensiveRounds` 已按 `cost_micros DESC` 且过滤 `cost_micros IS NOT NULL`（`admin-analytics.service.ts:596-625` 的 `runTraceRoundQuery`），与新的「贵」口径同源，**不改**。`RunTraceTab.vue` 的「只统计已配置价格的调用」提示语在新口径下正好也是桌面「贵」的语义，保留。

## 6. 分阶段实施

单阶段，无分期的必要（改动集中在 6 个文件、无 DDL、无数据迁移）。

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | 后端：`queryOptFloat` + 路由钳制 + `RunTraceQuery` + `toRoundVO` 判定 | `backend-ts` 单测 |
| 2 | 后端：改 `run-trace.service.spec.ts` 阈值用例、`session.routes.spec.ts` 透传用例 | `backend-ts` 单测 |
| 3 | 前端：`types/trace.ts` + `stores/session/trace.ts` + `RunTracePanel.vue` | `desktop` build |
| 4 | 前端：三个测试文件 fixture 字段名 | `desktop` 单测 |
| 5 | 文档：`skills/mao-cli/reference/desktop.md` + `CHANGELOG.md` | 人工核对 |

## 7. 风险与开放问题

- **未配价模型整段无「贵」**：这是用户明确接受的行为，但要在 CHANGELOG 与文档里写清，否则用户会以为功能坏了。输入框 tooltip 已带说明。
- **默认值 0.5 是拍的数量级**：真实分布要看线上 `cost_micros`。上线后若大量反馈「从没标过贵」，优先调默认值而不是改判定。
- **clamp 上下界与 `formatCost` 精度的关系**：`formatCost` 对 `abs >= 10000` 显示整数、`>= 1000` 显示一位小数。阈值上限设 1000 正好落在三位小数区间，展示不会失真。
- **换 key 导致 `slowMs` 一并重置**：接受。`slowMs` 默认 60s 覆盖绝大多数场景，且这是纯展示参数。
- **浮点边界**：`Math.round(0.5 * 1e6) = 500000` 精确；`0.001 * 1e6 = 1000` 精确（IEEE754 下这两个数都可精确表示）。若后续默认值改成 0.15 之类，`Math.round` 的 rounding 方向可能让边界轮次差 1 micros 而不标，属可接受误差（成本本身也是浮点估算）。
- **`queryOptInt` 改名的影响面**：不动它，新增 `queryOptFloat`，规避。

## 8. 测试要点

**后端**（`run-trace.service.spec.ts`）：

- 改写 `marks slow and expensive at the exact threshold boundaries`（当前 `run-trace.service.spec.ts:787`）：成本恰好等于阈值标记贵，差 1 micros 不标记。
- 新增：`costMicros` 为 null 时 `expensive` 为 false，即使 token 远超旧的 50k（这条是本次口径的核心回归）。
- 改写 `keeps cached tokens inside promptTokens when checking expensive`（当前 `run-trace.service.spec.ts:806`）：该用例断言的是 token 口径，需改为成本口径的等价用例——`costMicros` 达到阈值时标贵，缓存 token 不影响成本判定。
- `slow` 相关断言保持不变。

**后端**（`session.routes.spec.ts`）：

- 改写 `GET /v1/sessions/:id/trace 透传分页锚点并钳制慢 / 贵阈值`（当前 `session.routes.spec.ts:228`）：`expensiveCost=0.5` 透传，`expensiveCost=99999` 被钳到 1000，`expensiveCostMicros` 为 `500000` / `1000000000`。
- 缺省值断言改为 `{ slowMs: 60_000, expensiveCost: 0.5, expensiveCostMicros: 500_000 }`。
- `limit` 下限钳制的用例不变。

**前端**：

- `run-trace-panel-session.test.ts`：store mock 的阈值改 `{ slowMs: 60_000, expensiveCost: 0.5 }`。
- `trace-display.test.ts` / `trace-export.test.ts`：fixture 的 `expensive` 布尔字段名不变（它在 `TraceRound` 上，不涉及阈值字段），只需确认没有引用 `expensiveTokens` 的地方。
- 手动验证：把一个模型的输入框填 0.001（下限），重载后所有已配价轮次都应标「贵」；填 1000（上限）则都不标。

**回归**：

- `desktop` 跑 `npm run build`（`vue-tsc -b && vite build`，不要用 `npx vue-tsc --noEmit`，AGENTS.md 明确它会假通过）。
- `backend-ts` 跑 `npm test`。
- admin 三个榜页面无变化，不需回归。

## 9. 文档同步清单

| 文档 | 位置 | 改什么 |
|---|---|---|
| `CHANGELOG.md` | 顶部 `## 0.0.305`（新建）「后端」+「前端」小节 | 「贵」改按单轮成本判定、未配价不算贵、阈值默认 0.5、localStorage 换 key 导致阈值一次性重置 |
| `skills/mao-cli/reference/desktop.md:39` | 「阈值」小节 | 「贵」口径从 token 改为成本，注明未配价不标 |
| `README.md` | 核心能力表 Harness 行 | 现有文案提「重试 / 慢 / 贵」，无需改（未展开口径） |
| `docs/plan/2026-10-09-run-trace-technical-design.md` | §5.2「慢 / 贵」、§8 决策 11、§9 测试要点 | 标注「已被 2026-10-18 方案修订」并指向本文档（历史设计文档按 AGENTS.md 不 rewrite，只加修订指针） |
