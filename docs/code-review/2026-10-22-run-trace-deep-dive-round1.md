# 运行轨迹深度下钻 — 未提交改动代码审查（round 1）

- 日期：2026-10-22
- 范围：worktree `/opt/mao-data/workspace/2/projects/mao/.worktrees/run-trace-deep-dive`（分支 `feat/run-trace-deep-dive`）的未提交改动
- 设计依据：`docs/plan/2026-10-22-run-trace-deep-dive-technical-design.md`
- 结论：**不可合并**，4 个阻塞 / 重要问题（阻塞 2、重要 2、建议 1）
- 验证方式：全部用临时测试（`desktop/src/__tmpverify__/`、`backend-ts/src/__tmpverify__/`、`/tmp/verify/`）复现，报告完成后清理

## 总体结论

| 级别 | 数量 | 编号 |
|---|---|---|
| 阻塞 | 2 | BUG A（条带 tooltip 全程不显示）、BUG B（轮次抽屉跳工具抽屉内容陈旧） |
| 重要 | 2 | BUG C（编辑重发时轮次 key / 锚点重复，定位指错行）、BUG D（traceRecords 缓存删除会话不失效） |
| 建议 | 1 | BUG E（locateNode 对含 `:` 的 toolCallId 截断，未确认触发路径） |

功能主体（VO 增量、半开窗配对、越权校验、LIKE 转义、CSV 19 列、派生量边界）经单测与针对性复核**未发现问题**，详见文末「已排查未发现问题的点」。

基线（先跑过，全绿）：

```
backend-ts: vitest run src/session/run-trace-record.service.spec.ts src/session/run-trace.service.spec.ts
            src/session/session.repository.spec.ts src/session/session.routes.spec.ts
            src/usage/llm-call.repository.spec.ts
→ Test Files 5 passed / Tests 104 passed

desktop:    vitest run src/utils/trace-display.test.ts src/utils/trace-export.test.ts
            src/components/center/run-trace-panel-session.test.ts
→ Test Files 3 passed / Tests 62 passed
```

---

## BUG A（阻塞）— 时间条带 tooltip 永不显示

**位置**：`desktop/src/components/center/RunTraceTimeBand.vue:119-121`（`showTip` 的 setTimeout 回调）

```ts
tipTimer = window.setTimeout(() => {
  if (node.startedAtMs == null || node.durationMs == null) return
  const host = (event.currentTarget as SVGElement).ownerSVGElement?.parentElement  // ← 异步读 currentTarget
  const rect = host?.getBoundingClientRect()
  ...
```

**问题描述**：`showTip` 在同步期只清了 timer，把 `event.currentTarget` 的读取整体推迟到 300ms 的 `setTimeout` 回调。DOM 规范规定事件派发结束后 `currentTarget` 被重置为 `null`，回调执行时 `null.ownerSVGElement` 抛 `TypeError`，`tip.value` 永不赋值。

**为什么是 bug**：

- 触发条件：鼠标在任一条色条上停留超过 300ms（即正常悬停查看起止时刻的路径，100% 触发）。
- 错误结果：tooltip 全程不显示。设计文档 §5.5 明确要求 tooltip 展示「起 估算 HH:mm:ss.SSS / 止 估算 / 耗时 X」，D4 还要求「估算口径必须对用户可见」——本条把 §5.5 的可交互核心整个丢空，只剩色条本身。
- 附带：抛出的 TypeError 未被捕获，会成为 Vue 应用级未处理错误。

**验证测试**（两个文件，均通过并复现失败）：

1. `backend-ts/src/__tmpverify__/current-target.test.ts`（jsdom 环境，证明 DOM 规范语义：同步期 `currentTarget` = `<rect>`，异步回调里 = `null`）

```ts
// @vitest-environment jsdom
const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
svg.appendChild(rect)
let seen: unknown = 'unset'
rect.addEventListener('mouseenter', (e) => {
  seen = e.currentTarget            // 同步期：<rect>
  setTimeout(() => { seen = e.currentTarget }, 0)  // 异步期：null
})
rect.dispatchEvent(new MouseEvent('mouseenter'))
expect(seen).toBe(rect)
await new Promise((r) => setTimeout(r, 0))
expect(seen).toBeNull()
```

2. `desktop/src/__tmpverify__/timeband-tip2.test.ts`（`compileScript`+`compile`+自绘渲染器挂载**真实** `RunTraceTimeBand.vue`，断言回调抛错且 tooltip 不渲染）

```ts
const event = { clientX: 40, currentTarget: null as unknown }   // 真实浏览器语义
;(bars[0]!.props.onMouseenter as (e: unknown) => void)(event)
const thrown = await vi.advanceTimersByTimeAsync(400).then(() => null, (e) => e)
expect(String(thrown)).toContain("Cannot read properties of null (reading 'ownerSVGElement')")
expect(findAll(root, 'band-tip')).toHaveLength(0)
// 实测输出：
// × 悬停 300ms 后 tooltip 应显示估算起止与耗时
//   AssertionError: expected 'TypeError: Cannot read properties of null (reading ...' to contain ...
//   → find(root,'band-tip') 长度 0
```

**修复方向**（不在本次执行）：同步期捕获宿主元素再进 setTimeout，例如把 `showTip` 的入参从 `MouseEvent` 改为 `SVGElement`（模板 `@mouseenter="showTip(node, $event.currentTarget as SVGElement)"`），或同步期读一次 `const host = event.currentTarget?.ownerSVGElement?.parentElement ?? null` 后只用捕获值。

---

## BUG B（阻塞）— 轮次抽屉跳转到工具抽屉不重新拉取，内容陈旧

**位置**：

- `desktop/src/components/center/RunTraceRecordDrawer.vue:139-141`（`onMounted(() => { void load(); window.addEventListener(...) })`，**无 `watch(props.target)`**）
- `desktop/src/components/center/RunTracePanel.vue:274-280`（`<RunTraceRecordDrawer v-if="drawerTarget != null" :target="drawerTarget" @open-tool="openToolRecord" />`，**无 `:key`**）

**问题描述**：抽屉只在 `onMounted` 里 `load()` 一次。`openToolRecord(toolCallId)` 只改 `drawerTarget.value`，而 `v-if` 未销毁抽屉实例（target 从非 null 变成另一个非 null 值）、父组件也没给 `:key` 强制重建，于是组件实例被复用，`record` 仍是上一份 call 记录。

**为什么是 bug**：

- 触发条件：打开轮次抽屉 → 点「本轮工具（N）」里任意一行（设计文档 §5.6 明确要求的跳转路径）。
- 错误结果：抽屉标题变成「工具调用详情」（`title` 是 computed，跟着 target 变），但**内容仍是上一份 call 记录**，不发出 `/trace/records/tool/:toolCallId` 请求。用户看到的是「轮次元信息表格」冒充「工具参数/结果」，比空白更难排查。设计文档 §5.6 原文：「`emit('open-tool', toolCallId)` → 父组件切 key 重新拉取」——本实现既没切 key，抽屉也不 watch target。
- 附带：缓存命中路径同样失效——第二次打开另一个 target 时直接命中上一条 key 的缓存（`recordKey` 虽跟着 target 变，但 `load()` 不重跑，等于用旧记录配新 key 的标题）。

**验证测试**（3 个文件，均复现失败）：

1. `desktop/src/__tmpverify__/drawer-e2e.test.ts`（真实组件端到端：挂载 → 轮次抽屉渲染 → 切 target → 断言请求与内容）

```ts
expect(requests).toEqual(['/sessions/11/trace/records/call/101'])
expect(text(root)).toContain('轮次详情 #101')
expect(text(root)).toContain('本轮工具（1）')

targetRef.value = { kind: 'tool', toolCallId: 'tc1' }   // 等价父组件 openToolRecord
await flush()
// 实测：
// requests = ["/sessions/11/trace/records/call/101"]     ← 没有 tool 请求
// after text = " 工具调用详情 ×     本轮工具（1）   读取文件 a.ts"  ← 标题是工具，内容是轮次
expect(requests).toContain('/sessions/11/trace/records/tool/tc1')   // × failed
expect(text(root)).toContain('工具调用详情')
```

2. `desktop/src/__tmpverify__/drawer-target.test.ts`（静态断言：源码无 watch props.target）

```
hasWatch = false loadsOnMount = true
× target 变化时要重新 load（watch / 无 watch）
```

3. `desktop/src/__tmpverify__/drawer-jump2.test.ts`（静态断言：面板挂载块无 `:key`）

```
mount block:
<RunTraceRecordDrawer
      v-if="drawerTarget != null"
      :session-id="props.sessionId"
      :target="drawerTarget"
      @close="drawerTarget = null"
drawer watches props.target = false
× 面板复用同一抽屉实例（无 :key），target 变化不触发重新 load
```

**修复方向**（不在本次执行）：二选一或同时做——(a) 父组件挂载处加 `:key="drawerTarget.kind === 'tool' ? \`tool:${drawerTarget.toolCallId}\` : \`call:${drawerTarget.llmCallId}\`"`（设计文档本来的写法）；(b) 抽屉内 `watch(() => props.target, () => { record.value = null; activeTab.value = '参数'; void load() })`。推荐 (b)，它同时覆盖「缓存命中后 tab 状态不重置」的问题。

---

## BUG C（重要）— 编辑重发时轮次节点 key 与行锚点 id 重复

**位置**：

- `desktop/src/utils/trace-display.ts:152`（`key: \`round:${round.seq}\``，遍历 `run.segments` 时 `before_edit` 与 `current` 两段的 `seq` 都从 1 起）
- `desktop/src/components/center/RunTracePanel.vue:121`（`:id="rowAnchorId('round', round.seq)"` → `trace-${sessionId}-round-${seq}`）

**问题描述**：用户编辑重发（`anchor.updatedAt > anchor.createdAt`）时 run 有 `before_edit` + `current` 两段，两段各自 `seq` 从 1 编号，而 key 与锚点 id 都只用 `seq`。

**为什么是 bug**：

- 触发条件：任一被编辑重发过的 run 展开（`run.segments` 含 `before_edit`）。
- 错误结果 1：条带 `v-for :key="node.key"` 出现重复 key（Vue 渲染错乱 / 控制台告警，两条色条的高亮 `activeKey` 会同时命中）。
- 错误结果 2：行锚点 DOM id 重复。`locateNode` 用 `document.getElementById(anchor)` 只能取到**编辑前段**那一行 → 点击条带定位到错误的轮次行，直接破坏设计文档 §5.5「点击色条展开该 run 并滚动定位到对应行」。
- 附带：`tool:${toolCallId ?? name}` 的 key 在两段间同样可能撞（同一工具在编辑前后都被调用时 id 不同所以不撞，但历史行 `toolCallId == null` 时按 name 定位，两段同名工具会撞）。

**验证测试**：`desktop/src/__tmpverify__/node-keys.test.ts`（vitest exit=1，2 个断言都失败）

```ts
const r = run({
  segments: [
    { kind: 'before_edit', rounds: [round(1, { startedAtMs: 0 }), round(2, { startedAtMs: 5000 })], unplacedTools: [] },
    { kind: 'current',     rounds: [round(1, { startedAtMs: 10_000 }), round(2, { startedAtMs: 15_000 }), round(3, { startedAtMs: 20_000 })], unplacedTools: [] },
  ],
})
const keys = runTimeNodes(r).filter((n) => n.kind === 'round').map((n) => n.key)
expect(new Set(keys).size).toBe(keys.length)
// 实测：expected 3 to be 5（['round:1','round:2','round:1','round:2','round:3']）

const seqs = r.segments.flatMap((s) => s.rounds.map((x) => x.seq))
const ids = seqs.map((s) => rowAnchorId('11', 'round', s))
expect(new Set(ids).size).toBe(ids.length)
// 实测：expected 1 to be 2（两条 round 行同一个 trace-11-round-1）
```

**修复方向**（不在本次执行）：key 与锚点带段维度。`trace-display.ts` 的 `runTimeNodes` 输出 `key: \`round:${segment.kind}:${round.seq}\``（注意这会让 `locateNode` 的 `split(':')` 变成三段，需同步改成 `split(':')` 后 `slice(1).join(':')` 或类似），面板侧 `rowAnchorId('round', \`${segment.kind}-${round.seq}\`)`。

---

## BUG D（重要）— `traceRecords` 缓存在删除会话后不失效

**位置**：

- `desktop/src/stores/session/trace.ts:134-138`（`clearTraceRecords(sessionId)` 已实现并导出）
- `desktop/src/stores/session/list.ts:605-632`（`deleteSession` 只调 `purgeSessionRuntime(sid)`，即 `messages.ts:923` 的 messageRuntime 清理，不碰 trace 模块）

**问题描述**：`clearTraceRecords` 全仓库无调用方（`grep` 确认只在 `trace.ts` 内部定义与导出）；删除会话走 `purgeSessionRuntime`，它清 message/todo/activity/approval 等 15 个缓存，唯独不含 `traceRecords`。只有登出 / 401 走 `auth.ts:71` 的 `useSessionStore().reset()` 才会清（`reset()` 里有 `traceRecords.value = new Map()`）。

**为什么是 bug**：

- 触发条件：删除一个打开过记录详情抽屉的会话（或删完立刻用同一 sessionId 建新会话——id 是服务端自增，实际是新建 id 不复用，所以主要是「已删除会话的正文缓存在内存里不释放」）。
- 错误结果：该会话的工具参数 / 结果正文（可能含代码、密钥、路径）在删除后仍留在内存 Map 里，直到登出或整页刷新。traceRecords 的注释自称「会话级清理（删除会话 / 登出）：缓存随会话一起丢，不跨会话残留正文」——行为与注释不符。这不是内存泄漏级小事：抽屉正文是用户明确期望「随会话删除而消失」的敏感数据，`purgeSessionRuntime` 的语义就是「集中清理单个会话的全部运行态缓存」，新加的 traceRecords 没接进去属于漏接。

**验证测试**：`desktop/src/__tmpverify__/trace-records-purge.test.ts`（真实 pinia + 真实 `deleteSession`，复现失败）

```ts
setActivePinia(createPinia())
const store = useSessionStore()
store.setTraceRecord('7', 'tool:tc1', toolRecord)
const deleted = await store.deleteSession('7')
// deleteSession returned = true
expect(store.getTraceRecord('7', 'tool:tc1')).toBeNull()
// 实测：× AssertionError: expected { kind: 'tool', data: { …(6) } } to be null
// 对照：同一路径下 store.getTraceRuns('7') 也是 [] —— 但 runs 的清理来自
// setTracePage 的整页替换，不是 deleteSession；records 无人清理。
```

**修复方向**（不在本次执行）：在 `deleteSession` 的清理段加 `clearTraceRecords(sid)`（与 `purgeSessionRuntime(sid)`、`useDraftStore().clearDraftAndMark` 并列），或把 `clearTraceRecords` 接进 `purgeSessionRuntime` 的 trace 侧。

---

## BUG E（建议）— `locateNode` 用 `key.split(':')` 取第二段，toolCallId 含冒号即截断

**位置**：`desktop/src/components/center/RunTracePanel.vue:529-531`

```ts
const [kind, rawKey] = key.split(':')
if (kind == null || rawKey == null) return
const anchor = rowAnchorId(kind as 'round' | 'tool' | 'side', rawKey)
```

**问题描述**：`toolNode` 的 key 是 `tool:${toolCallId ?? name}`（`trace-display.ts:186`），`split(':')` 只取前两段，`toolCallId` 含冒号时后半段被丢掉，锚点对不上 → `document.getElementById` 返回 null → 定位静默失败（`row == null` 直接 return，无提示）。

**为什么是 bug（附触发路径说明）**：`toolCallId` 的来源有三处：`agent-loop.ts:802` 合成占位 id `call-${randomUUID()}`（不含冒号）、`delegate-tool.ts:86` / `:387` 历史兜底 `legacy_delegate_${Date.now()}`（不含冒号）、以及模型侧真实 id（OpenAI/Anthropic 侧通常 `call_xxx` / `toolu_xxx`，不含冒号）。**在仓库内未找到含冒号的 toolCallId 生成处**，所以本条是「潜在」而非「已确认触发」；外部 OpenAI 兼容网关自定义 id 或未来新增的合成 id 一旦含冒号即触发。鉴于 BUG C 的修复会引入 `round:before_edit:1` 三段 key（届时 `split(':')` 必然错），本条建议与 BUG C 一并修。

**验证测试**：`/tmp/verify/locate-node.test.ts`（`cd desktop && ./node_modules/.bin/vitest run /tmp/verify/locate-node.test.ts --root /tmp/verify`，3 passed；第 2 条证明截断）

```ts
it('toolCallId 含冒号时锚点被截断，定位不到行', () => {
  const id = 'legacy_delegate_1:1'
  const anchor = rowAnchorId('11', 'tool', id)
  const { kind, rawKey } = splitKey(toolNodeKey(id, 'delegate'))
  expect(rawKey).toBe('legacy_delegate_1')                    // 冒号后全丢
  expect(rowAnchorId('11', kind, rawKey)).not.toBe(anchor)    // 锚点对不上 → 静默失败
})
```

**修复方向**（不在本次执行）：`const idx = key.indexOf(':'); const kind = key.slice(0, idx); const rawKey = key.slice(idx + 1)`，与 BUG C 的三段 key 兼容。

---

## 已排查但**未发现**问题的点

避免重复劳动，以下都经过针对性测试或逐行复核：

- **CSV 导出（增量 4）**：`trace-export.ts` 表头确为 19 列（`'runId','段','序号','种类','时间','模型','provider','场景','输入 Token','输出 Token','缓存 Token','缓存写 Token','成本','耗时(ms)','状态','错误信息','名称','目标','审批'`），`toolRow` 也是 19 项（第 7 位为空串），provider 位置在「模型」之后正确；`modelRow` 三个调用点（unattributed / run round / side）都已补 `provider`。既有 `trace-export.test.ts` 覆盖并通过。
- **LIKE 转义与 ESCAPE 子句**：`escapeLike`（`message-search.ts:41`）对 `\` `%` `_` 三者都转义；`session.repository.ts:712` 的 `ESCAPE '\\\\'` 经 tsx 实跑确认运行期是 `ESCAPE '\\'`（单个反斜杠字符），与既有 5 处（`:59 / :429 / :854 / :879 / :968`）完全一致；spec 已断言 `params` 为 `['call\\_1']` 与 `['call\\_\\%\\_\\\\1']`。
- **LIKE 模式能否匹配真实 JSON**：真实写入是 `harness-service.ts:166/226` 的 `JSON.stringify(toolCalls)`，`ToolCall` 结构（`chat-request.ts:37`）为 `{ index?, id?, type?, function?, summary?, reasoning? }`。无论 `type` 在 `id` 前还是后、无论单条还是多条调用，`%"id":"<escapedId>"%` 都能匹配（`backend-ts/src/__tmpverify__/like-pattern.test.ts`，3 passed）。
- **半开窗配对与跨轮误配**：`selectBySessionWindow` 用 `created_at >= ? AND created_at < ?`，取窗内最后一条 `scene==='agent'`。针对性验证（`backend-ts/src/__tmpverify__/pair-window.test.ts`，3 passed）：TOOL 消息与下一轮 llm_call 同刻时上界排他正确排除下一轮；本轮调用晚于 TOOL 消息落库时返回 null（不跨窗猜）；`durationMs` 缺失时 `toCallMeta` 兜底 0，前端 `decodingMs`/`throughput` 显示「—」。
- **空态 VO 路径**：`buildToolRecord` 对 `toolCallId === ''` 早退不发查询；`buildCallRecord` 对非正整数早退；路由层对超长 toolCallId（>128，`session.routes.ts:554-557`）与非正整数 llmCallId（`:564-568`，`Number.isSafeInteger` 钳制）都返回空态 VO；spec 已覆盖。
- **越权校验**：`buildCallRecord` 有 `row.sessionId !== sessionId` 双保险（含 `sessionId == null`），spec 有「sessionId 不一致」「sessionId 为 null」两条例。
- **`estimatedStartMs` / `wallClockMs` 口径一致性**：`run-window.ts:33-38` 的 `estimatedStartMs` 要求两侧非空，`wallClockMs` 对 `durationMs == null` 显式兜底用 `end`；`git show HEAD:` 对比确认这是有意保持既有墙钟行为，非回归。
- **`timeBandGeometry`**：分段宽度和 = 总宽（既有 spec 断言）、单点窗口 `effectiveSpan = span > 0 ? span : 1` 不除零、`Math.max(..., 0.5)` 保底宽；`runTimeWindow` 全 null 返回 null → 组件整体不渲染（`RunTraceTimeBand.vue:2` 的 `v-if="timeWindow != null"`）。
- **`decodingMs` / `throughput` 边界**（null / firstTokenMs>durationMs / decode=0 / completionTokens=0）都返回 null，既有 spec 全覆盖。
- **`runTimeNodes` 顺序**：既有 spec 断言 `['round:1','tool:call_unplaced','tool:call_1','round:2','side:0']`，与实现一致（这个顺序本身可留意，但既有测试固化了它，且不影响功能）。
- **路由与注入**：`create-app.ts` 注入了新的 `RunTraceRecordService` 实例；两个新路由都走 `requireSessionOwner`，与既有 `/trace` 同权限模型。
- **抽屉 Esc / 遮罩 / × 三处关闭**：`onMounted`/`onUnmounted` 成对注册注销 `keydown`，遮罩与 × 都 `emit('close')`；父组件 `@close="drawerTarget = null"`。

## 验证环境备注

- worktree 的 `backend-ts/node_modules`、`desktop/node_modules` 是指向主仓库的软链，全部用 `./node_modules/.bin/vitest`。
- desktop vitest 是 `environment: 'node'`，无 window/document；挂载 SFC 必须用 `run-trace-panel-session.test.ts` 的三件套（`vi.mock('vue', ...useSSRContext)` + `compileScript`/`compile` + `new Function('Vue', compiled.code)(Vue)`）。
- 本报告所有「实测输出」均来自上述临时测试的真实运行结果；临时测试文件在报告提交后已清理，未修改任何产品代码。
