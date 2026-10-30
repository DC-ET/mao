# 代码审查报告：工作区总览与生命周期管理（第 4 轮 · 最终确认）

- 日期：2026-10-30
- 复审对象：worktree `feat/workspace-overview` 分支 commit `8fdc5a51` + `e08d9e84` + `4bcc9e92` + `63fb48c0`（BUG-6 修复）
- 审查方式：通读 63fb48c0 diff 与四个 commit 合成后的最终代码；对 refreshAll（POST→load 两步）/ confirmDelete→load / onActivated 重载 / refreshOne × 在途 load 的最坏时序做交互矩阵分析；临时组件探针用例实测（3 个文件、7 例，含 Element Plus loading 遮罩 DOM/CSS 走查，验证后均已删除）；未修改任何业务代码
- 验证环境：桌面 `npx vitest run` → 156 files / 1504 passed；`npm run build`（vue-tsc -b && vite build）exit 0。后端自第 1-2 轮核验后未再改动。

## 结论

BUG-6 修复的**方向正确**：`refreshOne` 在 POST 成功后 `loadGeneration++`，对「POST 先回、在途 load 后回」这一种落地顺序，pending 不再被旧快照覆盖、重查计时器不再被取消（已提交回归用例 5 例全绿可证）。但该修复**只覆盖了重叠窗口的一种落地顺序**，且在覆盖它的同时引入了一个新缺陷（loading 永不收敛）。本轮新发现 **1 个低危 bug（BUG-7）**，均附可复现测试。第 2/3 轮附录观察项经重新走查**仍不构成 bug**（附录 3）。

## Bug 清单

### BUG-7（低）：`refreshOne` 参与代际的方式不完整——重叠窗口内要么 loading 永久不收敛，要么重试仍被吞掉

- 位置：`desktop/src/components/workspace/WorkspaceOverviewPanel.vue:256-267`（`refreshOne` 的 `loadGeneration++`）与 `:214-217`（`load()` 的 `finally` 代际检查）的组合
- 引入方式：63fb48c0 修复 BUG-6 时引入（修复前 `refreshOne` 不 bump 代际，不存在 loading 归属问题）
- 根因：`refreshOne` 的 bump 发生在 **POST 响应之后**，而 bump 的语义是「作废全部在途 load」——包括作废它们 `finally` 里 `if (generation === loadGeneration) loading.value = false` 的收敛权。于是存在一个重叠窗口（行内重试的 POST 往返期间又发起/落地了一个 load），按两者响应落地顺序分出两种坏结果：

**(a) load 后于 POST 落地 → `loading` 永不收敛，表格永久遮罩（63fb48c0 引入的回归）**

- 时序：用户点行内「重新统计」→ POST 在途 → 窗口内顶部「刷新」（refreshAll）的 POST 先回、其 `load()` 发出并在途 → 重试 POST 回 → `loadGeneration++` 作废该 load → load 响应到达时走 early-return，`finally` 被代际挡住不收敛 loading → 之后 3s 重查照常落地新大小，但 `loading` 再无任何写入者（唯一写者就是 `load()` 的 finally）→ **遮罩一直在，行内「删除 / 用于新任务 / 重新统计」全部点不动**，直到用户点到表格外部的「刷新」或切走再切回页签才恢复。
- 修复前行为：不 bump，在途 load 正常落地并收敛 loading（代价是 BUG-6 的吞掉）——即本项是修复引入的回归。

**(b) load 先于 POST 落地 → 重试效果仍被吞掉（修复未覆盖的顺序，修复前后同样存在）**

- 时序：窗口内 load 先落地 → `entries.value` 被新对象整体替换 → 重试 POST 才回 → bump 无事可作废 → `row.sizeState = 'pending'` 写的是已脱离 `entries` 的旧行对象（界面无变化）→ `schedulePendingRequery()` 看到 entries 里没有 pending → **不排 3s 重查** → 服务端已重算成功，新大小永不显示，直到下次刷新 / 切页签 / 再点一次重试。

- 窗口可达性（如实说明）：`loading` 为 true 时 el-table 的 loading 遮罩（`.el-loading-mask`，挂在本表格根上、z-index 2000、无 `pointer-events:none`，固定列 z-index 仅 2）会盖住整表，行内按钮在 load 在途期间点不到——所以两个坏结果都要求「重试点击」与「另一个 load 的发起」落在同一个 POST 往返内。本地低延迟下该窗口只有几十毫秒（基本不可达）；远程 Web / 高延迟链路下 POST 往返可达数百毫秒，用户「点刷新后紧接着点某失败行的重试」是可能落入窗口的真实操作。按低危计入。
- 复现（临时探针用例实测通过，即上述行为属实；验证后已删除）：

```ts
// desktop/src/components/workspace/refreshone-window-probe.test.ts（临时，验证后删除）
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, type App } from 'vue'
import ElementPlus from 'element-plus'
import WorkspaceOverviewPanel from './WorkspaceOverviewPanel.vue'

const api = vi.hoisted(() => ({
  fetchOverview: vi.fn(), fetchReferences: vi.fn(), deleteWorkspace: vi.fn(), refreshOverview: vi.fn(),
}))
vi.mock('element-plus', async () => {
  const actual = await vi.importActual<typeof import('element-plus')>('element-plus')
  return { ...actual, ElMessage: { success: vi.fn(), error: vi.fn() } }
})
vi.mock('../../api', () => ({
  deleteWorkspaceByPath: api.deleteWorkspace,
  fetchWorkspaceOverview: api.fetchOverview,
  fetchWorkspaceReferences: api.fetchReferences,
  refreshWorkspaceOverview: api.refreshOverview,
}))
class ResizeObserverStub { observe(): void {} unobserve(): void {} disconnect(): void {} }
function entry(name: string, overrides: Record<string, unknown> = {}) {
  return { name, path: `/root/7/${name}`, kind: 'temp', isGit: false, sizeBytes: null,
    sizeState: 'pending', activeSessions: 0, archivedSessions: 0, lastUsedAt: null, ...overrides }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const flushMicro = () => vi.advanceTimersByTimeAsync(0)

describe('refreshOne × 在途 load 交互窗口探针', () => {
  let host: HTMLDivElement
  let app: App
  let setupState: {
    load: () => Promise<void>; refreshAll: () => Promise<void>; refreshOne: (row: unknown) => Promise<void>
    loading: boolean; refreshing: boolean; entries: Array<Record<string, unknown>>
  }

  beforeEach(() => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
    ;(globalThis as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({
      matches: false, addEventListener() {}, removeEventListener() {},
    })
    api.fetchOverview.mockReset(); api.fetchReferences.mockReset()
    api.deleteWorkspace.mockReset(); api.refreshOverview.mockReset()
    api.fetchReferences.mockResolvedValue([])
    host = document.createElement('div'); document.body.appendChild(host)
  })
  afterEach(() => { app.unmount(); host.remove(); document.body.innerHTML = ''; vi.useRealTimers() })

  async function mount(): Promise<void> {
    app = createApp(WorkspaceOverviewPanel as never)
    app.use(ElementPlus)
    const vm = app.mount(host) as unknown as { $: { setupState: typeof setupState } }
    setupState = vm.$.setupState
    await flushMicro()
  }

  it('(a) 窗口内 load 后于 POST 作废：loading 永不收敛，表格永久遮罩', async () => {
    vi.useFakeTimers()
    api.fetchOverview.mockResolvedValue({ entries: [entry('aaa', { sizeState: 'failed', sizeBytes: 4096 })], error: null })
    api.refreshOverview.mockResolvedValue(undefined)
    await mount()
    expect(host.textContent).toContain('统计失败')

    // 用户点顶部「刷新」：POST 阶段表格尚未遮罩（loading 仍为 false）
    const loadDeferred = deferred<{ entries: unknown[]; error: null }>()
    api.fetchOverview.mockImplementationOnce(() => loadDeferred.promise)
    const all = setupState.refreshAll()
    await flushMicro() // POST 已回，load() 已发出且在途

    // 用户紧接着点行内「重新统计」：POST 成功后 loadGeneration++ 作废在途 load
    const row = setupState.entries.find(e => e.name === 'aaa')!
    void setupState.refreshOne(row)
    await flushMicro()
    expect(host.textContent).toContain('统计中')

    // 在途 load 返回：被代际丢弃，finally 的代际检查挡住 loading 收敛
    loadDeferred.resolve({ entries: [entry('aaa', { sizeState: 'ready', sizeBytes: 8192 })], error: null })
    await flushMicro()
    await all
    expect(setupState.loading).toBe(true)

    // 3s 重查照常跑完、新大小落地，loading 仍不收敛 → 遮罩一直在，行内按钮点不动
    api.fetchOverview.mockResolvedValue({ entries: [entry('aaa', { sizeState: 'ready', sizeBytes: 8192 })], error: null })
    await vi.advanceTimersByTimeAsync(3000)
    expect(host.textContent).toContain('8.0 KB')
    expect(setupState.loading).toBe(true)
    expect(document.querySelector('.el-loading-mask')).not.toBeNull()
  })

  it('(b) 窗口内 load 先于 POST 落地：row 已脱离 entries，重查不排，重算大小仍不显示', async () => {
    vi.useFakeTimers()
    api.fetchOverview.mockResolvedValue({ entries: [entry('aaa', { sizeState: 'failed', sizeBytes: 4096 })], error: null })
    await mount()
    expect(host.textContent).toContain('统计失败')

    // 用户点「刷新」→ POST 立即回 → load() 在途
    const loadDeferred = deferred<{ entries: unknown[]; error: null }>()
    api.fetchOverview.mockImplementationOnce(() => loadDeferred.promise)
    api.refreshOverview.mockImplementationOnce(() => Promise.resolve(undefined))
    const all = setupState.refreshAll()
    await flushMicro()

    // 用户点行内重试 → POST 在途（控制落地顺序）
    const postDeferred = deferred<void>()
    api.refreshOverview.mockImplementationOnce(() => postDeferred.promise)
    const row = setupState.entries.find(e => e.name === 'aaa')!
    void setupState.refreshOne(row)
    await flushMicro()

    // load 先在 POST 期间落地：新对象替换 entries（row 脱离），服务端按旧缓存返回 failed
    loadDeferred.resolve({ entries: [entry('aaa', { sizeState: 'failed', sizeBytes: 4096 })], error: null })
    await flushMicro()
    expect(setupState.loading).toBe(false) // load 自身正常收敛

    // POST 才回来：bump 无事可作废，row 已脱离 → schedulePendingRequery 看不到 pending → 不排重查
    postDeferred.resolve(undefined)
    await flushMicro()
    await all
    expect(host.textContent).toContain('统计失败')

    const callsBefore = api.fetchOverview.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.fetchOverview.mock.calls.length).toBe(callsBefore)
  })
})
```

- 说明：两例唯一差异是在途 load 与重试 POST 的落地先后，可定位因果；已提交的 BUG-6 回归用例（POST 先回、load 后回且被作废）与例 (a) 的差别仅在例 (a) 额外断言了 `loading` 不收敛。

## 附录 1：三套代际的交互矩阵（按复审要求逐组合核查）

- `loadGeneration` ↔ `requeryGeneration`：独立计数。`load()` 成功落地时 `schedulePendingRequery()` 先 `invalidatePendingRequery()`（requeryGeneration++）作废在途重查响应，再由本次 entries 决定是否重排——无互相取消漏洞；`refreshOne` 的 bump 只影响 load 一侧，对重查的作废走 requeryGeneration，两者不交叉。
- `loadGeneration` ↔ `referencesGeneration`：完全独立（删除弹层引用清单，弹层重开即 +1）。
- `requeryGeneration` ↔ `referencesGeneration`：独立。
- `refreshAll`（POST→load 两步）：POST 与 `load()` 之间是同一微任务链，用户事件（宏任务）无法插入，两步原子连续；唯一风险是其后被 `refreshOne` 的 bump 作废——即 BUG-7(a)，已探针验证。
- `confirmDelete`→`load`：删除弹层 `append-to-body` 且带模态遮罩，弹层打开期间表格行内按钮（含重试）点不到，不存在与 refreshOne 的重叠；弹层关闭后 `load()` 独立完成，代际正常收敛。
- `onActivated` 重载：与普通 `load()` 同构；与 refreshOne 的重叠风险同 BUG-7（需窗口内二次动作）。
- 多入口叠加最坏时序：挂载双 load（onMounted + onActivated）互相作废属无害（数据相同、loading 由最新一代收敛）；「刷新 / 切页签 / 删除后重载」互相叠加时均由最新一代赢，除 BUG-7 窗口外无覆盖漏洞。

## 附录 2：loading 遮罩与可达性走查（本轮新增事实）

- `.el-loading-mask` 为 `.el-table` 根的子元素、`z-index:2000`、无 `pointer-events:none`；表内固定列单元格 `z-index: calc(var(--el-table-index) + 1)` 即 2——遮罩盖住整表含操作列。故 `loading` 为 true 期间行内按钮不可点击（jsdom DOM 探针确认遮罩挂载位置与移除时机）。
- 由此：第 3 轮 BUG-6 的原始场景（load 在途时用户点行内重试）经鼠标实际不可达（点击被遮罩挡住），当时用例是以程序化调用绕开遮罩验证的；63fb48c0 对该场景的修复本身无害。而 BUG-7 的两个坏结果只要求「重试点击」与「另一个 load 的发起/落地」落在同一个 POST 往返内，两次点击都发生在遮罩升起之前，是鼠标可达的（窗口宽度 = POST 往返时长）。

## 附录 3：历史附录观察项复核（仍不构成 bug）

1. **让位不同步路由 query（F5 后显式工作区复活）**：新建态任何表单项都不回写路由（`TaskView.vue:205-218` 仅同步 TaskView 自有 ref），Agent / 模型 / 手填项目名在 F5 后同样回退到路由记录值；路由是「入口意图」记录而非表单镜像，语义一致；复活状态发送前在 chip 可见。不计 bug。
2. **`isSameNewTaskRoute` 子集匹配读回陈旧 reuse=1**：子集逻辑为既有代码；正常用户 `lastViewedSession.agentId = String(data.agentId)` 必非空、目标路由必带 `agentId` 而「用于新任务」路由不带 → 子集必失败 → push 干净路由；仅「本页从未加载过任何会话」时目标退化为 `{newTask:'1'}` 才是子集，前提狭窄且状态可见。不计 bug。
3. **挂载双请求**（KeepAlive 首挂 onMounted + onActivated 各发一次 load）：仍为既知观察项，随 BUG-7 处理时可一并收敛，单独不成 bug。

## 附录 4：其余复核项（未发现问题）

- 「我的工作区」中央页签单例（`useCenterTabs.ts:426`）：重复点文件夹入口只激活已有 tab、不重复开；与 onActivated 重载链路吻合。
- 后端 `refresh(userId, path?)`：带 path 走 scope 校验 + 删缓存 + 重算入队；无 path 清本人全部缓存键后 `listOverview` 自动排计算——与面板「刷新」「行内重试」取数链路吻合（四个 commit 合成后无改动）。
- 让位三 handler 清空范围、`newTaskWorkspacePrefill` 两态预填、store payload 的 CLOUD workspace 传递：与第 2、3 轮核验结论一致，无变化。
- 既有回归：`WorkspaceOverviewPanel.race.test.ts` 5 例（BUG-3 ×2、BUG-4、BUG-5、BUG-6）全绿；桌面全量 1504 passed、构建通过。
