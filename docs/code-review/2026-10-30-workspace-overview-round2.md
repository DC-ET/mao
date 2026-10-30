# 代码审查报告：工作区总览与生命周期管理（第 2 轮 · 修复复审）

- 日期：2026-10-30
- 复审对象：worktree `feat/workspace-overview` 分支 commit `8fdc5a51`（0.0.382 全量）+ `e08d9e84`（复用意图标记修复），并以第 1 轮报告 4 个 bug 的修复为主线，重新全量检查本需求代码
- 审查方式：逐 commit 通读 diff + 临时 vitest 用例实测（后端 1 个临时 spec、桌面 1 个临时组件用例，验证后均已删除，未留在仓库）；未修改任何业务代码
- 验证环境：后端 `cd backend-ts && MAO_TEST_TMP_DIR=/Users/yangjiayi/AiProjects/mao/.tmp-t npm test` → 444 passed | 1 skipped（5223 用例）；桌面 `npx vitest run` → 1502 passed（唯一失败项为本轮临时 BUG-5 复现用例，删除后全绿）；`backend-ts npm run build`（tsc）与 `desktop npx vue-tsc -b --force` 均通过

## 结论

第 1 轮 4 个 bug 的修复**均正确且未引入新问题**（逐项验证见附录 1-4）。本轮新发现 **1 个 bug（BUG-5，中低严重度）**：`WorkspaceOverviewPanel.load()` 自身没有响应代际守卫，先发的 load 后返回会覆盖更新的列表——正是复审要求重点核查的「onActivated 重载路径」上的覆盖漏洞（BUG-3 的修复只覆盖了 pending 重查回调，没有覆盖 load 本身）。另有两个低严重度观察项（让位不同步路由、isSameNewTaskRoute 子集匹配），均为既有语义的边缘延伸，按「不计 bug」列入附录 5-6。

## Bug 清单

### BUG-5（中低）：`load()` 没有响应代际守卫，先发的 load 后到会覆盖更新的列表（已删目录复活）

- 位置：`desktop/src/components/workspace/WorkspaceOverviewPanel.vue:197-211`（`load()` 直接写 `entries.value`，无代际/序号校验）与 `:290-291`（`onMounted(load)` + `onActivated(load)` 两个入口可叠加）
- 引入方式：本需求新增的总览面板；第 2 轮 BUG-3 修复给「pending 重查回调」加了代际守卫、并在 `load()` 开头调 `invalidatePendingRequery()` 作废在途重查，但 `load()` 自身的响应落地仍是无序的——后者正是本次复审要求核查的「onActivated 重载路径」
- 现象：
  - `load()` 被 `onMounted` 和 `onActivated` 同时触发（实测：KeepAlive 内首次挂载 Vue 会**同时**触发 `onMounted` 与 `onActivated`，挂载即有 2 个并发 load），页签切走再切回又触发一次。多个 load 并发在途时，**最后落地的响应赢，而不是最后发出的请求赢**；
  - 典型时序：挂载 load#1 在途（网络慢）→ 用户切走再切回页签，`onActivated` 发起 load#3 → load#3 先返回新列表 → load#1 后返回旧列表，把新列表覆盖回旧值。
- 业务影响（中低）：切回「我的工作区」页签（或删除成功后 `confirmDelete → load()` 与一次 onActivated load 叠加）时，表格可能停在一份旧快照——**刚删除的工作区行复活**；由于复活的行的 `sizeState` 通常是 `ready`（非 pending），`schedulePendingRequery()` 不会排新重查，旧列表会一直显示到用户下次手动刷新 / 再次切页签；此时对复推行点「删除」只会拿到 400「目录不存在（可能已被删除）」。
- 复现（已用临时组件用例实测，驱动真实组件 + KeepAlive 包裹，失败信息 `expected '...' not to contain 'aaa'`，验证后已删除）：

```ts
// desktop/src/components/workspace/load-order.test.ts（临时，验证后删除）
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, defineComponent, ref, type App } from 'vue'
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

const Dummy = defineComponent({ template: '<div class="dummy-tab" />' })
const Wrapper = defineComponent({
  components: { WorkspaceOverviewPanel, Dummy },
  setup() {
    const showPanel = ref(true)
    const setShowPanel = (v: boolean) => { showPanel.value = v }
    return { showPanel, setShowPanel }
  },
  template: '<keep-alive><WorkspaceOverviewPanel v-if="showPanel" /><Dummy v-else /></keep-alive>',
})

function entry(name: string) {
  return {
    name, path: `/root/7/${name}`, kind: 'temp', isGit: false,
    sizeBytes: 1024, sizeState: 'ready', activeSessions: 0, archivedSessions: 0, lastUsedAt: null,
  }
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('load() 响应乱序（onMounted + onActivated / 页签切回）', () => {
  let host: HTMLDivElement
  let app: App
  let setShowPanel: (v: boolean) => void

  beforeEach(() => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
    ;(globalThis as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    api.fetchOverview.mockReset(); api.fetchReferences.mockReset()
    api.deleteWorkspace.mockReset(); api.refreshOverview.mockReset()
    api.refreshOverview.mockResolvedValue(undefined)
    api.fetchReferences.mockResolvedValue([])
    host = document.createElement('div')
    document.body.appendChild(host)
  })
  afterEach(() => { app.unmount(); host.remove(); document.body.innerHTML = '' })

  function mount() {
    app = createApp(Wrapper as never)
    app.use(ElementPlus)
    const vm = app.mount(host) as never
    setShowPanel = (vm as unknown as { $: { setupState: { setShowPanel: (v: boolean) => void } } }).$.setupState.setShowPanel
  }

  it('先发的 load 后返回，会覆盖后发的 load 的新列表', async () => {
    const pending: Array<(v: unknown) => void> = []
    api.fetchOverview.mockImplementation(() => new Promise(resolve => pending.push(resolve as never)))
    mount()

    // 挂载即两个 load 在途：onMounted(load) + onActivated(load)（KeepAlive 首次挂载也触发 activated）
    expect(pending).toHaveLength(2)

    // 用户切走页签再切回：onActivated → 第三个 load 在途
    setShowPanel(false)
    await flush()
    setShowPanel(true)
    await flush()
    expect(pending).toHaveLength(3)

    // 最新的 load#3 先回来：aaa 已被删除，只剩 bbb
    pending[2]!({ entries: [entry('bbb')], error: null })
    await flush()
    expect(host.textContent).not.toContain('aaa')

    // 最先发起的 load#1 后回来（旧列表仍含 aaa）
    pending[0]!({ entries: [entry('aaa'), entry('bbb')], error: null })
    await flush()

    // 期望：保持最新列表（无 aaa）；实际：被先发的旧响应覆盖，aaa 复活
    expect(host.textContent).not.toContain('aaa')   // 实际失败：表格重新出现 aaa
  })
})
```

- 建议核对方向（供修复参考，未改动代码）：给 `load()` 加自己的代际计数（进入时捕获、`await` 之后写 `entries.value` 前比对，过期响应直接丢弃），与重查回调同一范式；`onMounted` / `onActivated` 同时触发导致的挂载双请求也可顺势收敛（首屏只发一次）。

## 附录 1：第 1 轮 4 个 bug 修复的逐项核验（均正确）

1. **BUG-1（TTL 过期不重算）**：`runSizeQueue` worker 改为「只跳过新鲜缓存（`Date.now() - at < SIZE_TTL_MS`）或在途任务」，与 `scheduleSizeCompute` 的入队口径一致；仓库内回归用例「TTL 过期后再次打开总览会重算并得到新大小」实跑通过。并发放大问题实测无：临时用例让两个并发 `listOverview` 同时发现同一过期条目，`computeSize` 恰好被调用 1 次（`sizeInFlight` 的注册发生在 worker 同步段、先于任何 await，第二个 `scheduleSizeCompute` 的过滤必然看到在途标记），验证后已删除。`refresh(userId, path)` 新增的 `resolveWithinUserRoot` scope 校验与删除守卫共用，仓库内用例覆盖越界拒绝（`/root/8/42`、`/etc`）与本人根内放行；路由未捕获该 BusinessException，经统一 `handleError` 落 200 + fail 信封，桌面拦截器 toast，行为符合既有约定。
2. **BUG-2（CLOUD 显式 workspace 被丢弃）**：全链路已通——`enterNewTaskMode` 经 `newTaskWorkspacePrefill(mode, defaults)` 预填（CLOUD 仅带 `reuseWorkspace` 标记时）→ ChatPanel `handleSend` 把 `newTaskWorkspace` 写进 useChat 的 `workspace` → `useChat.ts` 第三参不再按模式丢弃 → `list.ts` CLOUD 分支在非 git 模式写 `payload.workspace` → 后端 `createSession` 对 CLOUD + 显式 workspace 直接沿用（`assertOwnedSessionWorkspace` 校验本人根）。git 模式互斥不传（否则后端跳过 clone）、LOCAL 行为不回退，均有仓库内 store payload 用例覆盖。`useChat` 的 `environmentInfo` 仅在 LOCAL + Electron 下探测，不会用本地机器去 stat 服务器路径。UI 上 docked 配置区对「有 workspace 无 cloudProjectKey」显示只读「复用」条目，centered / 移动端的 `WorkspaceChip.displayLabel` 展示目录名，三种布局一致。
3. **BUG-3（pending 重查过期响应覆盖）**：`load()` 开头 `invalidatePendingRequery()` 作废在途重查 + 重查回调 `await` 后落地前再校代际；仓库内 2 个组件级竞态回归用例（刷新不回滚、已删目录不复活）实跑通过。
4. **BUG-4（删除弹层引用串目录）**：`loadReferences` 增加 per-dialog 代际守卫，弹层重开即作废旧响应；仓库内组件级回归用例实跑通过。

## 附录 2：reuseWorkspace 标记传递链专项核查（未发现断点）

- 往返链：`handleUseForNewTask`（两类目录都带 `reuseWorkspace: true`）→ `buildNewTaskRoute` 写 `query.reuse='1'` → `router.push` 后路由 watcher → `getRouteNewTaskDefaults()` 读 `reuse==='1'` → `resolveNewTaskDefaults` 透传 → `newTaskWorkspacePrefill` 放行；同路由直达（`isSameNewTaskRoute` 为真）时直接传 `defaults` 对象，标记不经过路由也在。两态（push / 直达）均验证过代码路径，无断点。
- 误用面：`getCurrentNewTaskDefaults()`（active 会话 / `lastViewedSession` 回退）、`handleNewTaskFromGroup`、路由直开都不产生该标记，CLOUD 一律不预填——`lastViewedSession` 误复用回归已被 `e08d9e84` 堵住，`newTaskWorkspacePrefill` 的 4 个单测覆盖两类入口；TaskView 路由 watcher 里 `lastViewedSession` 直写分支（`:1482`）本就是 LOCAL 门控，无 CLOUD 泄漏。
- 让位逻辑（ChatPanel 三个 handler）在三种布局下的入口都核对过：docked 的工作区来源下拉、centered / 移动端 chip 抽屉里的 `WorkspaceConfigFields` 模式分段与项目输入、模式单选，均最终汇到 `handleNewTaskWorkspaceModeChange` / `handleNewTaskCloudProjectKeyChange` / `handleNewTaskModeChange`，切换即清 `newTaskWorkspace`；反向误清未发现（进入新建态 / `fetchCloudProjects` 回调都是直接写 ref，不经 handler；同值再选不触发 change）。
- `newTaskWorkspace` 的全部写入点已穷举（TaskView `:1120`/`:1134`/`:1482` + ChatPanel 四个 handler），无遗漏入口；草稿 store 不持久化 workspace，草稿恢复不会复活显式目录。

## 附录 3：其余复查方向（未发现问题）

- `explicitWorkspace` 计算（`ChatNewTaskConfigBar.vue:135-137`）：CLOUD + 有 workspace + 无 cloudProjectKey 才走只读条目；项目目录（带 cloudProjectKey）仍走原下拉/输入链路，后端以路径为准、结果与 `projects/{key}` 一致，无行为分叉。
- 后端大小队列：`computeSize` 三重上限、符号链接跳过、失败降级与第 1 轮一致；`deleteWorkspace` 后删缓存键，删除后目录不再枚举，无可见脏值（仅「同名目录被重建」时会沿用至多 10 分钟的旧大小，属可接受边缘）。
- 既有回归：后端 5223 用例、桌面 1502 用例全绿（含本轮新增的 store payload 4 例、组件竞态 3 例、`newTaskWorkspacePrefill` 4 例），双端构建通过。

## 附录 4：观察项（未计 bug）

1. **让位不同步路由 query**：用户让位（改用「现有」项目）后，路由仍带 `workspace=X&reuse=1`；此时按 F5 / 直接打开该 URL 会按路由重放，显式工作区 X 复活、用户改选被丢弃。会话内导航都会 `router.push` 替换 query，只有刷新 / 直链触达，且路由本就是深链事实源，故未计 bug；如要一致，可在三个让位 handler 里同步 `router.replace` 清掉 `reuse`/`workspace`。
2. **`isSameNewTaskRoute` 子集匹配**：`every` 只检查目标 query 的键，当前路由多出的参数（如陈旧的 `reuse=1`）不参与比较，`navigateToNewTask` 会走「同路由直达」并用 `getRouteNewTaskDefaults()` 读回当前路由——`lastViewedSession` 为 null 时点「新建任务」会把上次复用的显式工作区带进新草稿。该子集语义对 agentId / mode 等参数是既有行为，非本次引入，未计 bug。
3. **挂载双请求**：KeepAlive 内首次挂载 `onMounted` 与 `onActivated` 同时触发，首屏发 2 个相同总览请求（BUG-5 的机制之一）。单独看只是浪费一次请求，随 BUG-5 一并处理即可。
