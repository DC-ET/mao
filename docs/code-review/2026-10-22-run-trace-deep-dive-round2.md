# 运行轨迹深度下钻 — round 1 修复复审（round 2）

- 日期：2026-10-22
- 范围：worktree `/opt/mao-data/workspace/2/projects/mao/.worktrees/run-trace-deep-dive`（分支 `feat/run-trace-deep-dive`，HEAD `37e01eba`）的未提交改动
- 设计依据：`docs/plan/2026-10-22-run-trace-deep-dive-technical-design.md`
- 上一轮报告：`docs/code-review/2026-10-22-run-trace-deep-dive-round1.md`
- 结论：**有条件可合并**，1 个重要问题（BUG F）；5 个 round 1 问题中 4 个已正确修复，1 个（BUG C）只修了一半
- 验证方式：临时测试（`desktop/src/__tmpverify2__/`）复现，全部实测运行；报告完成后清理，未修改任何产品代码

## 总体结论

| 级别 | 数量 | 编号 |
|---|---|---|
| 阻塞 | 0 | — |
| 重要 | 1 | BUG F（多 run 同时展开时行锚点 id 跨 run 重复，定位指到第一个 run 的行、跨 run 串高亮） |
| 建议 | 2 | BUG G（同一工具两段都调用时 tooltip label 相同，展示歧义）、`TimeBandNode.key` 注释陈旧 |

round 1 修复逐条核实：

| round 1 编号 | 本轮核实结论 |
|---|---|
| BUG A（tooltip 不显示） | **已修复且正确**。`RunTraceTimeBand.vue:119-124` 同步期捕获 `host` / `clientX`，回调只读捕获值。既有 `run-trace-time-band.test.ts` 第 4 例（`currentTarget: null` + `advanceTimersByTimeAsync(150)`）通过 |
| BUG B（抽屉 target 切换不重载） | **已修复且交互正确**。`watch(recordKey)`（`RunTraceRecordDrawer.vue:139-147`）+ `loadSeq`（`:112-137`）两个机制配合无副作用：过期响应被丢弃且不污染缓存 key、不留「加载中」，缓存命中同步路径也正确收尾 `loading`。见下文「BUG B 修复专项验证」 |
| BUG C（编辑重发 key / 锚点重复） | **同 run 内已修复，跨 run 维度遗漏 → BUG F**。段维度（`segment.kind`）已加到 key 与行锚点，但 run 维度缺失，且 `expandedRuns` 是 `Set`、无互斥无上限，多 run 可同时展开 |
| BUG D（删除会话不清 traceRecords） | **已修复且影响面正确**。`purgeSessionRuntime` 已接 `trace.clearTraceRecords(sid)`；全仓库该回调仅 `stores/session/list.ts`（deleteSession 内）一处调用，切会话不清缓存，修复精准 |
| BUG E（locateNode 冒号截断） | **已修复**。`key.indexOf(':')` 切分（`RunTracePanel.vue:539-543`）兼容三段 key 与含冒号 toolCallId；5 种 key 形态全部自洽（`locate-selfcheck.test.ts`，5 passed） |

基线复跑（全绿）：

```
backend-ts: vitest run src/session/run-trace-record.service.spec.ts src/session/run-trace.service.spec.ts
            src/session/session.repository.spec.ts src/session/session.routes.spec.ts
            src/usage/llm-call.repository.spec.ts
→ Test Files 5 passed / Tests 104 passed

desktop:    vitest run src/components/center/run-trace-time-band.test.ts
            src/components/center/run-trace-record-drawer.test.ts
            src/components/center/run-trace-panel-session.test.ts
            src/utils/trace-display.test.ts src/utils/trace-export.test.ts
            src/stores/session.test.ts
→ Test Files 6 passed / Tests 127 passed

desktop: vue-tsc -b --force → 产品代码 0 错误
```

---

## BUG F（重要）— 多 run 同时展开时行锚点 id 跨 run 重复，定位指到第一个 run 的行

**位置**：

- `desktop/src/components/center/RunTracePanel.vue:523-525`（`rowAnchorId`，只有 sessionId + kind + key 三个维度）
- `desktop/src/components/center/RunTracePanel.vue:537-551`（`locateNode`，`document.getElementById(anchor)`）
- 三个 `:id` 调用点：`:121`（round 行）、`:151` / `:171`（tool 行，轮内 / 未挂轮）、`:193`（side 行）
- `desktop/src/components/center/RunTracePanel.vue:323`（`expandedRuns = ref<Set<number>>(new Set())`）、`:577-582`（`toggleRun`）

```ts
/** 行锚点 id 带 sessionId：多个轨迹 Tab 并存时不串锚 */
function rowAnchorId(kind: 'round' | 'tool' | 'side', key: string | number): string {
  return `trace-${props.sessionId}-${kind}-${key}`
}
```

**问题描述**：BUG C 的修复只给 key 补了「段维度」（`segment.kind`），没补「run 维度」。而 `expandedRuns` 是 `Set<number>`，多个 run 可同时展开且互不排斥、无数量上限。此时同一 sessionId 下，run 11 与 run 12 的 `round current:1` / `tool current:call_x` / `side 0` 三类行 id 完全相同。

**为什么是 bug**：

- 触发条件：展开两个（或多个）run（各点一次 run 摘要行），然后点**第二个** run 条带上的任一色条。
- 错误结果 1（HTML 合法性）：同一 sessionId 下出现重复 DOM id。HTML 规范要求 id 在文档内唯一，Vue 的 v-for `:key` 用的是别的口径（`round` 用 `${segment.kind}-${round.seq}`、`tool` 用 `toolKey(tool)`），不冲突，所以控制台不会告警，问题完全静默。
- 错误结果 2（功能）：`document.getElementById` 按文档序返回**第一个**匹配 → 滚动定位与 1.2s 行高亮都落在**第一个 run 的对应行**。用户点 run 12 的色条，看到 run 11 的行被高亮。这正是 round 1 BUG C 想修的那类「定位指错行」，只是触发条件从「同 run 两段撞」变成「跨 run」——同一类缺陷漏了第二个维度。
- 错误结果 3（高亮串扰）：`activeBandKey` 是面板级单 ref（`:529`），每个展开 run 的条带都通过 `:active-key="activeBandKey"` 拿到同一个值（`:116`），且条带节点 key 本身不含 runId。于是点击任一条色条，**所有展开 run 的同名色条一起高亮**（`active-band.test.ts` 实测：run11 与 run12 各 2 条 `bar-active`）。用户无法从高亮判断自己点的是哪个 run 的哪条。
- 与设计文档的关系：§5.5「点击色条展开该 run 并滚动定位到对应行」在多 run 展开场景被破坏，属于本次功能的既有设计目标，不是新需求。

**验证测试**（3 个临时文件，全部真实挂载组件实测）

1. `desktop/src/__tmpverify2__/multi-run-e2e.test.ts`（真实挂载 `RunTracePanel.vue`，两个 run 各展开，条带 stub emit `round:current:1`；`document.getElementById` 按真实浏览器语义实现——重复 id 返回文档序第一个，并记录命中行的所属 run）

关键片段：

```ts
store = { ...makeStore(), getTraceRuns: () => [makeRun(11), makeRun(12)] }
// 两个 run 都展开
;(summaries[0]!.props.onClick as () => void)()
;(summaries[1]!.props.onClick as () => void)()
await flush()
const bands = byClass(root, 'time-band-stub')
expect(bands).toHaveLength(2)
;(bands[1]!.props.onClick as () => void)()      // 点第二个 run 的色条
await flush()
expect(locatedRows).toEqual([{ id: 'trace-11-round-current:1', run: '11' }])
expect(new Set(ids).size).toBe(ids.length)      // id 必须唯一
```

实测输出（exit=1，断言失败即证据）：

```
tool row ids  = ["trace-11-tool-current:call_x","trace-11-tool-current:call_x"]
side row ids  = ["trace-11-side-0","trace-11-side-0"]
round row ids = ["trace-11-round-current:1","trace-11-round-current:1"]
unique ids    = 1 of 2
getElementById calls = ["trace-11-round-current:1"]
located rows  = [{"id":"trace-11-round-current:1","run":"11"}]   ← 点的是 run 12 的色条
× 两个 run 都展开时 round 行 id 重复，点击第二个 run 的色条定位到第一个 run 的行
  → expected 1 to be 2 // Object.is equality
```

2. `desktop/src/__tmpverify2__/multi-run-anchor.test.ts`（静态层：`rowAnchorId` 是纯函数，直接证两个 run 产出同 id）

```
run11 anchor = trace-11-round-current:1  run12 anchor = trace-11-round-current:1
× expected 'trace-11-round-current:1' not to be 'trace-11-round-current:1'
tool anchors = trace-11-tool-current:call_x trace-11-tool-current:call_x
× expected 'trace-11-tool-current:call_x' not to be 'trace-11-tool-current:call_x'
```

3. `desktop/src/__tmpverify2__/active-band.test.ts`（跨 run 高亮串扰，1 passed 记录事实）

```
run11 bar-active = 2  run12 bar-active = 2
```

**修复方向**（不在本次执行）：行锚点 id 带 runId，同时让「当前定位」带 runId，两者必须同源：

- `rowAnchorId` 增参 runId：`trace-${sessionId}-run${runId}-${kind}-${key}`，四个 `:id` 调用点（`:121 / :151 / :171 / :193`）把所在 run 的 `run.runId` 传进去。
- `activeBandKey` 改为 `${runId}|${key}` 或对象 `{ runId, key }`，条带 `:active-key` 只与同 runId 的 key 比较。
- `locateNode` 需要知道 runId：条带 emit 时带上 runId（`RunTraceTimeBand` 的 `locate` 事件 payload 改成 `{ runId, key }`，或 emit `run${runId}:${kind}:${key}` 与行锚点同口径），`locateNode` 从 payload 解析出 runId 后调 `rowAnchorId(runId, kind, key)`。注意 `indexOf(':')` 的切分要同步适配新 key 形态（勿退回 `split(':')`）。

---

## BUG G（建议）— 同一工具在两段都被调用时 tooltip label 相同

**位置**：`desktop/src/utils/trace-display.ts:189`（`toolNode` 的 `label: toolDisplayNameForBand(tool.name)`，不含段维度）

**问题描述**：BUG C 修复后，同一 `toolCallId` 在 `before_edit` 与 `current` 各出现一次时会画 2 条色条（key 带段维度，正确），但两条 tooltip 的 label 都是「read_file」，用户分不清哪条属于哪一段。

**为什么只是建议而非 bug**：两条色条在时间轴上的位置不同（一条在前、一条在后），配合 run 的编辑上下文仍可分辨；且 round 行的 label 带 `#${seq}`，两段 round 的 tooltip 同样无法区分段，但此场景更少见。属展示歧义，不影响定位与数据正确性。

**验证测试**（`desktop/src/__tmpverify2__/dup-tool.test.ts`，1 passed，记录事实）：

```
bar count = 2
✓ 同一 toolCallId 在两段各画一条色条（key 带段维度），tooltip label 相同
```

**修复方向**（可选）：`label` 带段维度，如 `#${round.seq}` 之于 round 的写法——工具节点可显示为 `read_file（编辑前）` / `read_file（当前）`；实现上 `toolNode` 需知道 `segment.kind`（已有入参）与段的中文名映射。

---

## 建议：`TimeBandNode.key` 注释与实现不符

**位置**：`desktop/src/utils/trace-display.ts:135`

```ts
export interface TimeBandNode {
  /** 定位 key：round 用 `round:${seq}`，工具用 `tool:${toolCallId ?? name}`，旁路用 `side:${index}` */
  key: string
```

注释仍写 round 1 修复前的口径（`round:${seq}`），实际已是 `round:${segment.kind}:${seq}`（`:152`）。纯注释陈旧，不影响行为；同文件 `:141-145` 的函数注释已正确描述段维度，唯独接口注释漏改。修 BUG F 时顺手同步即可。

---

## BUG B 修复专项验证（watch(recordKey) 与 loadSeq 的交互）

用户重点关注项，3 个场景 + 2 个附带场景全部符合预期：

- `src/__tmpverify2__/drawer-seq.test.ts`（3 passed）
  1. **旧请求后返回**：A 请求未回时切到 B，再让 A 迟回 → 内容是 B、缓存只有 `tool:B`。A 的迟到响应被 `seq !== loadSeq` 丢弃，**不会把 B 的 key 污染成 A 的内容**（`setTraceRecord` 在 seq 检查之后，这点很关键）。
  2. **旧请求后返回不留「加载中」**：`finally` 里 `if (seq === loadSeq) loading.value = false`，过期分支直接 return 不动 loading，由新一轮 load 自己置位/收尾，不会出现 loading 永久卡在 true。
  3. **tool→call 都命中缓存**：0 请求、无 loading、渲染 `meta:101`。watch 先 `record.value = null` 再 `load()`，缓存同步命中路径里也补了 `loading.value = false`，不留「加载中…」。
- `src/__tmpverify2__/drawer-reopen.test.ts`（2 passed）：Esc 关闭后重开同一 key → 缓存命中不重复请求、tab 复位到「参数」（`activeTab` 不复位则重开停在上一 tab，此处 watch 因 recordKey 未变不触发，但 `v-if` 重建了实例所以 tab 是初值「参数」——两种路径都得到正确结果）；抽屉开着时重复 open 同 key → watch 不触发、不重载，合理。
- `src/__tmpverify2__/drawer-sid.test.ts`（1 passed）：同实例只改 sessionId（recordKey 不变）→ 不重载、不发新请求。已确认该场景不可达：`CenterTabContainer.vue:31-35` 给 `RunTracePanel` 的 key 是 `trace-${activeTab.traceSessionId ?? props.sessionId}`，sessionId 变即换新面板实例，抽屉随之重建。不列为 bug。

**未引入的新问题**：`loadSeq` 是模块级 `let`，与 `recordKey` 的 watch 配合时任一过期响应都无法写 `record` / `error` / `loading` / 缓存，四条写路径都有 seq 门禁，无遗漏。

## BUG E 修复专项验证（indexOf 切分与 side 的兼容）

`src/__tmpverify2__/locate-selfcheck.test.ts`（5 passed）覆盖 5 种 key 形态：

- `round:current:1` → kind `round` / key `current:1` ✓
- `side:0` → kind `side` / key `0`（二段，余下整段当 key，与 `rowAnchorId('side', idx)` 的 number 转字符串一致）✓
- `tool:current:call_x` → kind `tool` / key `current:call_x` ✓
- toolCallId 含冒号（`tool:current:legacy_delegate_1:1`）→ kind `tool` / key `current:legacy_delegate_1:1` ✓（round 1 BUG E 已真正修复）
- `before_edit` 段的 round key ✓

`sep <= 0` 的守卫对空 key / 无冒号输入正确早退；`rawKey === ''` 也早退。无回归。

---

## 已排查但**未发现**问题的点

- **CSV 导出**：`trace-export.ts:11-14` 表头仍为 19 列，provider 在「模型」之后；`trace-export.test.ts` 全绿（含 provider 缺省留空用例）。
- **派生量边界**：`decodingMs`（null / firstTokenMs>durationMs / 等于时返回 0）、`throughput`（decode=0 / completionTokens=0 → null）、`formatThroughput` 四类边界，既有 spec 全覆盖。
- **半开窗配对**：backend 5 个 spec 104 passed 全绿，round 1 的 `pair-window` 结论仍成立。
- **`estimatedStartMs` / `wallClockMs` 口径**：`run-window.ts:27-56`，`wallClockMs` 对 `durationMs == null` 显式兜底用 end，与 `estimatedStartMs`「两侧非空」的区分有注释，非回归。
- **`runTimeNodes` 的 drawable / skipped 计数**：nodes 与 drawable 同出一次 `runTimeNodes`，BUG C 的 key 改动不影响两者数量关系；`dup-tool.test.ts` 顺带确认同工具两段各画一条（2 条色条、不互相覆盖）。
- **泳道几何**：`viewBox="0 0 100 34"`，round y=2 bottom=10 / tool y=13 bottom=21 / side y=24 bottom=32，不溢出。
- **`RunTraceTimeBand` 未清 tipTimer**：`src/__tmpverify2__/band-unmount.test.ts` 验证悬停后组件卸载（run 收起）→ 回调照跑但不抛错（Vue ref 卸载后仍可写），无功能错误，仅潜在无害泄漏，不列为 bug。
- **BUG D 修复影响面**：`purgeSessionRuntime` 仅 deleteSession 一处调用；切会话不清 traceRecords（`src/__tmpverify2__/purge-scope.test.ts` 通过），修复精准无副作用。
- **BUG F 是否影响多 Tab**：`rowAnchorId` 的 sessionId 维度已覆盖多轨迹 Tab 并存；BUG F 只发生在**同一 sessionId 内多 run 同时展开**。若不接受修 id，一个低成本替代方案是把 `toggleRun` 改成互斥展开（一次只展开一个 run），可同时消除 id 重复与跨 run 高亮串扰，但会改变「同时对比两个 run」的可用性，需产品取舍。

## 验证环境备注

- worktree 的 `backend-ts/node_modules`、`desktop/node_modules` 是指向主仓库的软链，全部用 `./node_modules/.bin/vitest`。
- desktop vitest 是 `environment: 'node'`，无 window/document；挂载 SFC 用三件套（`vi.mock('vue', ...useSSRContext)` + `compileScript`/`compile` + `new Function('Vue', compiled.code)(Vue)` + 自绘 nodeOps）。挂抽屉验证 watch 时 Host 必须传**真 ref**（`target.value`），传普通对象不会触发 watch。
- 本报告所有「实测输出」均来自临时测试的真实运行结果；临时测试文件（`desktop/src/__tmpverify2__/`）在报告提交后已清理，未修改任何产品代码。
