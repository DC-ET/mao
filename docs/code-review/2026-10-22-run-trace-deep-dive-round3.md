# 运行轨迹深度下钻 — round 2 修复复审（round 3）

- 日期：2026-10-22
- 范围：worktree `/opt/mao-data/workspace/2/projects/mao/.worktrees/run-trace-deep-dive`（分支 `feat/run-trace-deep-dive`，HEAD `37e01eba`）的未提交改动
- 上一轮报告：`docs/code-review/2026-10-22-run-trace-deep-dive-round2.md`
- 结论：**可合并，0 个产品 bug**；1 个测试覆盖问题（BUG F 修复后面板测试 stub 的 prop 名未同步，导致新增的 runId 链路在面板侧零断言）
- 验证方式：临时测试（`desktop/src/__tmpverify3__/`）复现，全部实测运行；报告完成后清理，未修改任何产品代码

## 总体结论

| 级别 | 数量 | 编号 |
|---|---|---|
| 阻塞 | 0 | — |
| 重要 | 0 | — |
| 产品 bug | 0 | BUG F / BUG G / 注释陈旧三处修复均正确且自洽 |
| 测试问题 | 1 | T-1（面板测试 stub prop 名 `activeKey` 未随产品改名为 `activeRunKey`，runId 高亮链路在面板侧无断言） |

round 2 修复逐条核实：

| round 2 编号 | 本轮核实结论 |
|---|---|
| BUG F（行锚点 id 缺 runId 维度） | **已完整修复且四维自洽**。`rowAnchorId(runId, kind, key)` 四个 `:id` 调用点全部传 `run.runId`；`activeBandKey` 改存 `${runId}\|${key}`；`isActive` 按第一个 `\|` 切分后 runId 与 key 双等比较。端到端实测：点第二个 run 的色条 → 定位到 run 12 的行、id 唯一 2 of 2、只有目标色条高亮 |
| BUG G（tooltip label 段歧义） | **已修复**。`toolNode` 的 label 带 `（编辑前）`/`（当前）` 后缀，与面板 `segment-label` 文案同源；既有 spec 断言 `['glob（编辑前）', 'glob（当前）']` |
| `TimeBandNode.key` 注释陈旧 | **已同步**。JSDoc 改为 `round:${段}:${seq}` / `tool:${段}:${toolCallId ?? name}` / `side:${index}`，并说明段维度必要性 |

基线复跑（全绿）：

```
desktop: vitest run（全量）→ Test Files 87 passed / Tests 788 passed
         vue-tsc -b --force → 0 error
backend-ts: vitest run <5 个 trace 相关 spec> → Test Files 5 passed / Tests 104 passed
```

---

## 疑点 1：`isActive` 的 `indexOf('|')` 在 toolCallId 含 `|` 时是否正确

**结论：正确，非 bug。**

`RunTraceTimeBand.vue:90-98`：

```ts
function isActive(node: TimeBandNode): boolean {
  if (props.activeRunKey == null) return false
  const sep = props.activeRunKey.indexOf('|')
  if (sep <= 0) return false
  const runId = props.activeRunKey.slice(0, sep)
  const key = props.activeRunKey.slice(sep + 1)
  return runId === String(props.run.runId) && key === node.key
}
```

用**第一个** `|` 切分，余下整段当 key。runId 是 `number`（DB BIGINT 自增），`String(runId)` 不可能含 `|`，所以第一个 `|` 必然是 runId 与 key 的分界；key 段（`tool:current:call_we|ird:1`）里即使含 `|` 也完整保留。与 `locateNode` 的 `indexOf(':')` 是同一种正确写法。

关于「toolCallId 会不会含 `|`」：仓库内三处 id 生成——`agent-loop.ts:802` 的 `call-${randomUUID()}`、`delegate-tool.ts:86/:387` 的 `legacy_delegate_${Date.now()}`、模型侧真实 id（`call_xxx` / `toolu_xxx`）——都不含 `|`。即当前不可达，但即便含 `|` 也已正确处理（下面有实测）。

**验证测试**（`src/__tmpverify3__/isactive-pipe.test.ts`，2 passed，真实挂载 `RunTraceTimeBand.vue`）：

```ts
const weird = 'call_we|ird:1'
const key = `tool:current:${weird}`
const activeRunKey = `7|${key}`           // 面板 locateNode 的拼接口径
const root = await mountBand(runWithTool(weird), activeRunKey)
expect(byClass(root, 'band-bar')).toHaveLength(1)
expect(String(bars[0]!.props.class)).toContain('bar-active')   // 精确命中
// 别的 runId / 别的 key（少一段竖线）/ null / 无竖线输入 → 一律不高亮
```

实测输出：

```
node key     = tool:current:call_we|ird:1
activeRunKey = 7|tool:current:call_we|ird:1
bars = 1 active = 1
✓ toolCallId 含竖线时，activeRunKey = `${runId}|${key}` 仍精确命中该色条
✓ toolCallId 含竖线时，别的 runId 或别的 key 都不误高亮
```

## 疑点 1 附：BUG F 修复的端到端链路

**结论：完整自洽，非 bug。**

链路「面板 `@locate` → `locateNode(run.runId, key)` → `rowAnchorId(runId, kind, rawKey)` → `document.getElementById`」与「面板 `:active-run-key="activeBandKey"` → 条带 `isActive`」两条路径都带上了 runId，且口径一致（都来自 `run.runId`）。

**验证测试**（`src/__tmpverify3__/e2e-locate.test.ts`，2 passed，真实挂载 `RunTracePanel.vue`，`document.getElementById` 按真实浏览器语义实现——重复 id 返回文档序第一个，并记录命中行所属 run）：

```ts
store = { ...makeStore(), getTraceRuns: () => [makeRun(11), makeRun(12)] }
;(summaries[0]!.props.onClick as () => void)()   // 展开 run 11
;(summaries[1]!.props.onClick as () => void)()   // 展开 run 12
await flush()
;(bands[1]!.props.onClick as () => void)()       // 点第二个 run 的色条
await flush()
```

实测输出（对比 round 2 的失败输出，本轮全部符合预期）：

```
round row ids = ["trace-11-run11-round-current:1","trace-11-run12-round-current:1"]
unique = 2 of 2
located = [{"id":"trace-11-run12-round-current:1","run":"12"}]     ← 定位到 run 12 的行
after activeRunKey = [{"run":"11","active":"12|round:current:1"},{"run":"12","active":"12|round:current:1"}]
```

round 2 时同一场景的输出是 `unique = 1 of 2` / `located = [{"run":"11"}]`，本轮已修正。

含冒号与竖线的 toolCallId 的锚点也自洽：`tool row id = trace-11-run13-tool-current:call_we|ird:1`，与 `rowAnchorId(13, 'tool', 'current:call_we|ird:1')` 一致；`locateNode` 对该 key 的 `indexOf(':')` 切分得到 kind `tool` / rawKey `current:call_we|ird:1`，锚点对得上。

## 疑点 2：改名 / 签名变更后是否有遗漏调用点或死代码

**产品代码：无遗漏、无死代码。**

全仓库 grep 结果：

- `activeKey` / `active-key` 在产品代码中 0 处残留；`activeRunKey` 仅出现在 `RunTraceTimeBand.vue`（prop 定义 + `isActive`）与 `RunTracePanel.vue:116`（`:active-run-key="activeBandKey"`）。
- `locateNode` 唯一调用点 `RunTracePanel.vue:117`（`@locate="(key: string) => locateNode(run.runId, key)"`），签名 `(runId, key)` 与定义一致。
- `rowAnchorId` 五处（定义 + 四个 `:id`：round / 轮内 tool / 未挂轮 tool / side）全部传 `run.runId`，无遗漏的旧签名调用。
- `isActive` 无其他调用方；`TimeBandNode` 的 `key` / `label` 字段仍被 tooltip 与 v-for 使用，无变成死字段的成员。

**测试代码：发现一处 prop 名未同步 → T-1。**

`desktop/src/components/center/run-trace-panel-session.test.ts:92` 的条带 stub 仍声明旧名：

```ts
vi.mock('./RunTraceTimeBand.vue', () => ({
  default: defineComponent({
    props: { run: { type: Object, required: true }, activeKey: { type: String, default: null } },   // ← 旧名
```

产品模板下发的是 `:active-run-key`，stub 未声明该 prop → 值落到 `$attrs`，`this.activeKey` 恒为 `null`。

**验证测试**（`src/__tmpverify3__/stub-prop-name.test.ts`，1 passed；在 stub 上加 `updated()` 钩子记录 props 与 $attrs）：

```
stub observed = [{"runId":21,"propsActiveKey":null,"attrs":{"active-run-key":"21|round:current:1"}}]
records with props.activeKey non-null = 0
```

即产品链路本身是通的（`$attrs` 里能看到 `21|round:current:1`），但 stub 的 props 观测不到。

---

## T-1（测试问题）— 面板测试 stub 的 prop 名未随产品改名同步，runId 高亮链路在面板侧零断言

**位置**：`desktop/src/components/center/run-trace-panel-session.test.ts:92`

**问题描述**：BUG F 修复引入了「`activeBandKey` 必须带 runId」这一新不变量（多 run 同时展开时只有目标 run 的色条高亮），但面板测试的条带 stub 仍声明 `activeKey`，导致：

- stub 收不到 `activeRunKey`，无法断言「面板下发的值是否形如 `${runId}|${key}`」。
- 现有面板用例（含新增的「多个 run 同时展开时行锚点 id 不跨 run 重复」）只覆盖了 `rowAnchorId` 的 runId 维度，**`activeBandKey` 的 runId 维度在面板侧一条断言都没有**。
- 条带组件自身的用例（`run-trace-time-band.test.ts:246`）验的是「给定 activeRunKey 时高亮是否正确」，属于下游消费侧；上游生产侧（面板怎么拼这个字符串）无人看守。将来若有人把 `activeBandKey` 改回纯 key，`run-trace-time-band.test.ts` 的用例会因 key 与 runId 双等比较而失败——这条其实能兜住。所以风险主要是「面板拼错格式（如漏 `|`、用错分隔符）」时缺少快速定位的断言。

**为什么只是测试问题而非产品 bug**：产品代码实测正确（见上，`$attrs` 里 `active-run-key` = `21|round:current:1`）；且下游 `isActive` 的 runId 双等比较提供了兜底——面板拼错时高亮会静默失效，但定位仍正确（`locateNode` 用的是另一条 `rowAnchorId` 路径，不依赖 `activeBandKey` 格式）。影响是「高亮悄悄不亮」这类体验回退缺少单测拦截。

**修复方向**（不在本次执行）：把 stub 的 props 改为 `activeRunKey: { type: String, default: null }`，并在「点色条 emit locate」用例里补一条断言，例如把 activeRunKey 透传到 stub 根元素的 data 属性后断言其等于 `${run.runId}|round:current:1`（round 2 的临时测试 `e2e-locate.test.ts` 已有可复用写法）。

---

## 已排查但**未发现**问题的点

- **BUG F 的 runId 是否会与 sessionId / kind / key 三维中的任一产生新的歧义**：`rowAnchorId` 输出 `trace-${sessionId}-run${runId}-${kind}-${key}`，runId 前有字面 `-run` 前缀，sessionId 是字符串（轨迹 Tab 的 sessionId），二者不会互相冒充；kind 取值固定 `round|tool|side`，也不会与 runId 段混淆。
- **`activeBandKey` 在 run 收起后是否残留导致串高亮**：`activeBandKey` 是面板级 ref，run 收起后该 run 的条带卸载；重新展开时 `isActive` 仍会比较 `runId` 与 `key`——若用户收起前点过某个 run 的色条，重新展开同一 run 时会看到该色条仍带 `bar-active` 描边。属「上次定位的残留提示」，与 round 1 BUG A 修复前同理，无功能错误（行高亮 `row-located` 有 1.2s 自动移除，色条描边无超时但这只是视觉残留，且指向的确实是用户上次点的那个节点）。不列为 bug。
- **BUG G 的 label 改动是否影响其他消费者**：`TimeBandNode.label` 仅两处消费——条带 tooltip 标题（`RunTraceTimeBand.vue:36`）与既有 spec；`runAttentionBadges` 的「编辑前」徽标是另一条独立逻辑（`trace-display.ts:34`），未受影响。
- **注释同步的准确性**：`trace-display.ts:134-139` 的 JSDoc 与 `:152`（round key）、`:189`（tool key）、`:178`（side key）实现一致；`RunTracePanel.vue:520-527` 的 `rowAnchorId` 注释四维说明与实现一致。
- **round 2 已确认无问题的点抽查**：CSV 19 列（`trace-export.test.ts` 全绿）、`decodingMs` / `throughput` 边界（既有 spec 全覆盖）、半开窗配对（backend 5 spec 104 passed）均无回归。
- **`run-trace-time-band.test.ts:250` 的 `hitBars.every(active)` 断言强度**：`every` 单看无法区分「精确命中」与「全部高亮」，但同一用例的第三个场景（`otherBars.some(active)` 为 false）已排除 isActive 恒真，覆盖充分。

## 验证环境备注

- worktree 的 `desktop/node_modules`、`backend-ts/node_modules` 是指向主仓库的软链，全部用 `./node_modules/.bin/vitest`。
- desktop vitest 是 `environment: 'node'`，无 window/document；挂载 SFC 用三件套（`vi.mock('vue', ...useSSRContext)` + `compileScript`/`compile` + `new Function('Vue', compiled.code)(Vue)` + 自绘 nodeOps）。真实条带组件需额外注入 `window.setTimeout / clearTimeout`；`document.getElementById` 需自绘并按文档序返回第一个匹配。
- 本报告所有「实测输出」均来自临时测试的真实运行结果；临时测试文件（`desktop/src/__tmpverify3__/`）在报告提交后已清理，未修改任何产品代码。
