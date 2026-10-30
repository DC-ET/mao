# 代码审查报告：工作区总览与生命周期管理（第 1 轮）

- 日期：2026-10-30
- 审查范围：worktree `feat/workspace-overview`（`/Users/yangjiayi/AiProjects/mao/.worktrees/wsp`）全部未提交改动（15 个修改文件 + 4 个新增文件），技术方案 `docs/plan/2026-10-29-workspace-overview-lifecycle-technical-design.md`
- 审查方式：逐文件通读 diff + 临时 vitest 用例实测验证（后端 1 个临时 spec、桌面 4 个临时 test，验证后均已删除，未留在仓库）；未修改任何业务代码
- 验证环境：后端 `cd backend-ts && MAO_TEST_TMP_DIR=/Users/yangjiayi/AiProjects/mao/.tmp-t npm test` → 444 passed | 1 skipped（5221 用例）；桌面 `npx vue-tsc -b --force` 通过（仅本次临时测试文件产生过类型报错，删除后干净）

## 结论

发现 4 个已验证的 bug（1 个后端高严重度、3 个桌面中/中低严重度）。其余核查方向（删除守卫链分支顺序、符号链接防御、LIKE ESCAPE 转义、聚合口径与日期类型、信封语义与 HTTP 映射、前缀归并边界、enrichment 代际守卫、in-flight 去重竞态）均未发现问题，验证过程见文末附录。

## Bug 清单

### BUG-1（高）：TTL 过期的大小缓存条目永远不会重算，大小列无限期停在「统计中…」

- 位置：`backend-ts/src/file/workspace-overview.service.ts:154`（`scheduleSizeCompute` 入队过滤）与 `:168`（`runSizeQueue` worker 判重跳过）
- 引入方式：本次新增的大小统计后台队列 + TTL 缓存
- 现象：
  - `scheduleSizeCompute` 的入队条件把**过期条目**视为未命中（`cached == null || now - cached.at >= SIZE_TTL_MS`），注释也写明「过期（TTL 外）的旧值也视为未命中：只展示 pending 直到重算完成」；
  - 但 `runSizeQueue` 的 worker 判重用的是 `if (this.sizeCache.get(key) != null || this.sizeInFlight.has(key)) continue;`——过期条目**仍在 Map 里（非 null）**，于是「入队即被跳过」，`sizeInFlight` 始终为空，重算永远不会发生；
  - 过期条目没有其他清除路径：只有 `refresh(userId, path)` / `refresh(userId)`（顶部刷新，会 delete 缓存键）和 `deleteWorkspace` 会删条目，没有任何 TTL 清扫。
- 业务影响（高）：首次计算完成 10 分钟后，任何一次 `listOverview`（首屏、pending 3s 重查、切页签 `onActivated` 重载）对**所有**目录都返回 `sizeState: 'pending'`，且因没有 in-flight 任务也不会自愈；桌面行显示「统计中…」无限期——`pending` 行没有行内重试按钮（只有 `timeout`/`failed` 有），用户唯一恢复手段是点顶部「刷新」。即「TTL 10 分钟缓存」实际退化成了「10 分钟后大小列永久失效，直到手动刷新」。
- 复现（已用临时 vitest 验证，失败信息 `expected 'pending' to be 'ready'`，验证后已删除）：

```ts
// backend-ts/src/file/workspace-overview.review.spec.ts（临时，验证后删除）
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../testing/tmp-dir.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { WorkspaceOverviewService } from './workspace-overview.service.js';

type UsageMap = Map<string, { total: number; active: number; archived: number; lastUsedAt: string | null }>;

function makeService(root: string, usage: UsageMap = new Map()) {
  const repo = {
    aggregateWorkspaceUsage: vi.fn(async () => usage),
    listActiveWorkspaceReferences: vi.fn(async () => [] as Array<{ id: number; title: string | null; phase: string | null }>),
  };
  const service = new WorkspaceOverviewService(new PathSandbox(root), repo as never);
  return { service, repo };
}

async function waitSizeQueue(service: WorkspaceOverviewService): Promise<void> {
  const inflight = (service as unknown as { sizeInFlight: Map<string, Promise<void>> }).sizeInFlight;
  while (inflight.size > 0) {
    await Promise.all([...inflight.values()]);
  }
}

/** 与服务内 SIZE_TTL_MS 同值（10 分钟），仅测试内使用。 */
const SIZE_TTL_MS = 10 * 60 * 1000;

describe('BUG-1 TTL 过期条目不会重新计算', () => {
  it('缓存超过 TTL 后 listOverview 再次触发后台重算并最终 ready', async () => {
    const root = useTmpDir('ws-ov-bug1-');
    const userRoot = join(root, '7');
    mkdirSync(join(userRoot, '42'), { recursive: true });
    writeFileSync(join(userRoot, '42', 'a.txt'), 'x'.repeat(5));
    const { service } = makeService(root);
    // 首轮：pending → 后台算 → ready
    await service.listOverview(7);
    await waitSizeQueue(service);
    const first = await service.listOverview(7);
    expect(first.entries[0]!.sizeState).toBe('ready');
    expect(first.entries[0]!.sizeBytes).toBe(5);

    // 10 分钟后再次打开总览：TTL 外的旧值必须视为未命中并重新入队计算
    const cache = (service as unknown as { sizeCache: Map<string, { bytes: number; state: string; at: number }> }).sizeCache;
    const key = `7:${join(userRoot, '42')}`;
    cache.get(key)!.at = Date.now() - SIZE_TTL_MS - 60_000;
    // 目录内容变化，重算应得到新大小
    writeFileSync(join(userRoot, '42', 'b.txt'), 'y'.repeat(20));

    const second = await service.listOverview(7);
    expect(second.entries[0]!.sizeState).toBe('pending');
    await waitSizeQueue(service);
    const third = await service.listOverview(7);
    expect(third.entries[0]!.sizeState).toBe('ready');   // 实际：仍为 'pending'（worker 以 cache != null 跳过）
    expect(third.entries[0]!.sizeBytes).toBe(25);
  });
});
```

- 建议核对方向（供修复参考，未改动代码）：两处判重口径对齐——worker 只跳过**新鲜**条目（`now - cached.at < SIZE_TTL_MS` 才 continue），或 `scheduleSizeCompute` 在入队前先 `sizeCache.delete` 过期键。

### BUG-2（中高）：「用于新任务」对临时 / 其他目录的工作区预填全程被丢弃，点下去拿到的是全新临时工作区

- 位置：
  - `desktop/src/views/task/TaskView.vue:372-379`（`handleUseForNewTask` 对非 project 目录传 `workspace: entry.path`）
  - `desktop/src/views/task/TaskView.vue:1112`、`:1126`（`newTaskWorkspace.value = mode === 'LOCAL' ? (…workspace…) : ''`，CLOUD 下清空）
  - `desktop/src/views/task/TaskView.vue:214`（watch 同步 `workspace.value = newTaskMode.value === 'LOCAL' ? newTaskWorkspace.value : ''`）
  - `desktop/src/composables/useChat.ts:402`（建会话实参 `executionMode.value === 'LOCAL' ? workspace.value || undefined : undefined`）
  - `desktop/src/stores/session/list.ts:535-537`（payload 的 CLOUD 分支只写 `workspaceMode`/`cloudProjectKey`/git 字段，**不写 `workspace`**）
- 引入方式：本次新增的总览行操作「用于新任务」
- 现象：
  - CHANGELOG 0.0.382 与代码注释都写明「临时 / 其他目录**直接预填工作区路径**」，后端也确实支持该形态（`POST /v1/sessions` 的 CLOUD + 本人根下绝对 workspace：`session.routes.spec.ts:708` 已有固化用例，`session.service.ts:150-156` 直接沿用该 workspace、不再建新目录）；
  - 但桌面 CLOUD 新建链路上 `workspace` 在**四处**被丢弃：进入新建态即清空 `newTaskWorkspace` → watch 同步出的 `workspace.value` 为 '' → `useChat` 建会话第三参传 `undefined` → store payload 的 CLOUD 分支不写 `workspace`。整条链路没有任何一处把选中目录带给后端。
- 业务影响（中高）：用户在「我的工作区」对临时 / 其他目录点「用于新任务」，得到的是一个全新的 `{userRoot}/{新会话id}` 临时工作区——选中目录被静默忽略，与按钮承诺的行为相反且无任何提示。项目目录（`kind='project'`，走 `cloudProjectKey` 通道）不受影响。
- 复现（已用临时 vitest 验证 store 层 payload，失败信息 `expected undefined to be '/root/7/123'`，验证后已删除；上游三处清点见上）：

```ts
// desktop/src/stores/workspace-overview-bug2.test.ts（临时，验证后删除）
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionStore } from './session'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { get: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), post: vi.fn() },
}))

const mockPost = vi.mocked(api.post)

describe('BUG-2 CLOUD 新建会话丢弃显式 workspace', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockPost.mockReset()
  })

  it('CLOUD 建会话带入已选工作区绝对路径', async () => {
    const store = useSessionStore()
    mockPost.mockResolvedValue({
      data: { id: 9, agentId: 1, executionMode: 'CLOUD', workspace: '/root/7/123' },
    } as never)

    await store.createSession('1', 'CLOUD', '/root/7/123')

    expect(mockPost).toHaveBeenCalledTimes(1)
    const [url, payload] = mockPost.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/sessions')
    expect(payload.workspace).toBe('/root/7/123')   // 实际：undefined
  })
})
```

- 建议核对方向（供修复参考，未改动代码）：要么把显式 workspace 一路带到 `POST /v1/sessions`（store payload 的 CLOUD 分支、`useChat.ts:402` 实参、`enterNewTaskMode` 对 CLOUD 保留 `newTaskWorkspace`），要么对 temp / other 行隐藏或禁用该按钮——二选一，别让按钮承诺一个做不到的行为。

### BUG-3（中）：pending 3s 重查的过期响应会覆盖更新的列表数据（刷新被回滚、已删目录复活）

- 位置：`desktop/src/components/workspace/WorkspaceOverviewPanel.vue:209-221`（`schedulePendingRequery` 的回调只在**触发时**校验 `generation`，`await` 之后落地前没有再校验）
- 引入方式：本次新增的 pending 一次性 3s 重查
- 现象：
  - 定时器触发时校验 `generation !== requeryGeneration` 才发请求，但请求在途期间用户点「刷新」（`refreshAll → load()`）或删除目录（`confirmDelete → load()`）都会写入新数据并把 `requeryGeneration` +1；
  - 先发的重查响应后到时无条件执行 `entries.value = result.entries ?? []`，把更新的数据覆盖掉。
- 业务影响（中）：
  1. 点「刷新」后刚由后台重算出的新大小被覆盖回「统计中…」，要再等一次重查 / 刷新才恢复；
  2. 更明显的是删除成功后：在途重查响应把**已删目录加回表格**，且该回调不会重新 `schedulePendingRequery`——这行会一直留着直到用户手动刷新 / 切页签，再点删除只会拿到 400「目录不存在（可能已被删除）」。
- 复现（已用临时组件用例实测，驱动真实组件，验证后已删除）：

```ts
// desktop/src/components/workspace/pending-requery-race.test.ts（临时，验证后删除）
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import WorkspaceOverviewPanel from './WorkspaceOverviewPanel.vue'

const pendingFetches: Array<(value: unknown) => void> = []
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('element-plus', async () => {
  const actual = await vi.importActual<typeof import('element-plus')>('element-plus')
  return { ...actual, ElMessage: { success: vi.fn(), error: vi.fn() } }
})
vi.mock('../../api', () => ({
  deleteWorkspaceByPath: vi.fn(async () => undefined),
  fetchWorkspaceOverview: fetchMock,
  fetchWorkspaceReferences: vi.fn(async () => []),
  refreshWorkspaceOverview: vi.fn(async () => undefined),
}))

class ResizeObserverStub { observe(): void {} unobserve(): void {} disconnect(): void {} }

function entry(name: string, overrides: Record<string, unknown> = {}) {
  return { name, path: `/root/7/${name}`, kind: 'temp', isGit: false, sizeBytes: null,
    sizeState: 'pending', activeSessions: 0, archivedSessions: 0, lastUsedAt: null, ...overrides }
}
function clickRefresh(host: HTMLElement): HTMLButtonElement {
  const btn = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('刷新'))!
  btn.click()
  return btn
}
/** 让出宏任务队列（fake timers 下必须推进计时器才能 flush 微任务）。 */
function nextTick() { return vi.advanceTimersByTimeAsync(0) }

describe('BUG-3 pending 3s 重查的过期响应会覆盖更新的数据', () => {
  let host: HTMLDivElement
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
    ;(globalThis as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    vi.useFakeTimers()
    pendingFetches.length = 0
    fetchMock.mockReset()
    fetchMock.mockImplementation(() => new Promise(resolve => pendingFetches.push(resolve as never)))
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(WorkspaceOverviewPanel as never)
    app.use(ElementPlus)
    app.mount(host)
  })
  afterEach(() => { app.unmount(); host.remove(); vi.useRealTimers() })

  it('重查请求在途时用户点刷新，先发的重查响应后到会盖掉刷新后的列表', async () => {
    // t=0: 挂载 load() → fetch#1：目录 42 大小未就绪（pending），触发 3s 重查
    expect(pendingFetches).toHaveLength(1)
    pendingFetches[0]!({ entries: [entry('42')], error: null })
    await nextTick()

    // t=3000: 重查计时器触发 → fetch#2 发出（在途，暂不 resolve）
    await vi.advanceTimersByTimeAsync(3000)
    expect(pendingFetches).toHaveLength(2)

    // t=3100: 用户点顶部「刷新」→ load() → fetch#3 返回刷新后的新数据（42 已算出大小）
    clickRefresh(host)
    await nextTick()
    expect(pendingFetches).toHaveLength(3)
    pendingFetches[2]!({ entries: [entry('42', { sizeState: 'ready', sizeBytes: 4096 })], error: null })
    await nextTick()
    expect(host.textContent).toContain('4.0 KB')

    // t=3200: 先发的重查 fetch#2 才回来（发起于刷新之前，数据是旧的 pending）
    pendingFetches[1]!({ entries: [entry('42')], error: null })
    await nextTick()

    // 期望：表格保持刷新后的 4.0 KB；实际：被过期响应覆盖回「统计中…」
    expect(host.textContent).toContain('4.0 KB')   // 实际失败：文本为「统计中…」
  })
})
```

同一根因的删除影响面（同样实测失败，`expected '...aaa...' not to contain 'aaa'`，临时用例已删除）：挂载后 `aaa` 为 pending → 3s 重查请求在途 → 用户删除 `aaa`（`confirmDelete` 成功、列表已无 `aaa`）→ 在途重查响应（含 `aaa`）后到 → `aaa` 行复活且不再自动重查。

- 建议核对方向（供修复参考，未改动代码）：重查回调 `await` 之后、写 `entries.value` 之前重新校验 `generation`（与 `load()` 用同一代际口径），过期响应直接丢弃。

### BUG-4（中低）：删除弹层活跃引用清单存在覆盖竞态，会展示 / 误用另一个目录的引用

- 位置：`desktop/src/components/workspace/WorkspaceOverviewPanel.vue:242-252`（`openDelete` / `loadReferences` 没有 per-dialog 代际守卫，请求发出后不随弹层关闭 / 重新打开而作废）
- 引入方式：本次新增的删除确认弹层 + references 预拉取
- 现象：打开 A 的删除弹层 → `loadReferences(A)` 在途；用户关闭弹层再打开 B → `loadReferences(B)` 发出；A 的响应后到时直接写 `deleteState.references`，覆盖 B 的清单。
- 业务影响（中低）：B 的弹层挂上 A 的活跃引用 → 确认按钮被**误禁用**（用户删不掉 B，关闭重开才好）；反向时序（A 无引用、B 有引用）则确认按钮被**误启用**，用户点删除才被后端 409 挡住。后端守卫保证不会误删，但弹层展示与门控和当前目录不符，属于误导性交互。
- 复现（已用临时组件用例实测，失败信息 `expected [ { id: 5, … } ] to deeply equal []`，验证后已删除）：

```ts
// desktop/src/components/workspace/delete-references-race.test.ts（临时，验证后删除）
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp } from 'vue'
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

function entry(name: string) {
  return { name, path: `/root/7/${name}`, kind: 'temp', isGit: false, sizeBytes: 1024,
    sizeState: 'ready', activeSessions: 0, archivedSessions: 0, lastUsedAt: null }
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('BUG-4 删除弹层活跃引用清单存在覆盖竞态', () => {
  let host: HTMLDivElement
  let app: ReturnType<typeof createApp>
  let setupState: {
    openDelete: (e: unknown) => void
    deleteState: { visible: boolean; entry: { name: string } | null; references: Array<{ id: number }> }
  }

  beforeEach(async () => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
    ;(globalThis as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    api.fetchOverview.mockReset(); api.fetchReferences.mockReset()
    api.deleteWorkspace.mockReset(); api.refreshOverview.mockReset()
    api.refreshOverview.mockResolvedValue(undefined)
    api.deleteWorkspace.mockResolvedValue(undefined)
    api.fetchOverview.mockResolvedValue({ entries: [entry('aaa'), entry('bbb')], error: null })
    api.fetchReferences.mockResolvedValue([])
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(WorkspaceOverviewPanel as never)
    app.use(ElementPlus)
    const vm = app.mount(host) as unknown as { $: { setupState: typeof setupState } }
    setupState = vm.$.setupState
    await flush()
  })
  afterEach(() => { app.unmount(); host.remove(); document.body.innerHTML = '' })

  it('先打开的目录引用请求后返回，会覆盖后打开目录的引用清单', async () => {
    const refsA = deferred<Array<{ id: number }>>()
    const refsB = deferred<Array<{ id: number }>>()
    api.fetchReferences.mockImplementationOnce(() => refsA.promise)
    api.fetchReferences.mockImplementationOnce(() => refsB.promise)

    setupState.openDelete(entry('aaa'))
    expect(api.fetchReferences).toHaveBeenCalledWith('/root/7/aaa')

    // 用户关闭弹层后再打开 B → references(B) 在途；A 的请求不会取消
    setupState.deleteState.visible = false
    setupState.openDelete(entry('bbb'))
    expect(api.fetchReferences).toHaveBeenCalledWith('/root/7/bbb')

    // B 的引用先回来（无引用），A 的引用后回来（有活跃会话）
    refsB.resolve([])
    await flush()
    refsA.resolve([{ id: 5, title: 'A 的会话', phase: 'RUNNING' }])
    await flush()

    // 期望：B 的弹层无引用、可删除；实际：B 的弹层挂着 A 的活跃引用，确认按钮被误禁用
    expect(setupState.deleteState.entry?.name).toBe('bbb')
    expect(setupState.deleteState.references).toEqual([])   // 实际：[{ id: 5, … }]
  })
})
```

- 建议核对方向（供修复参考，未改动代码）：`loadReferences` 记录打开时的 `entry.path`（或自增代际），响应落地时与当前 `deleteState.entry` 比对，不匹配即丢弃。

## 附录：已核查且未发现问题的方向

以下各项均通过通读代码 + 临时测试实测确认无误（临时用例共 6 个：后端 1、桌面 5，其中 5 个按预期失败即上述 4 个 bug 的复现、1 个为挂载探针通过后删除）：

1. **删除守卫链分支顺序**（`workspace-overview.service.ts:251-274`）：越界（非本人根 / 根自身）→ `projects` 容器硬拒 → 结构校验（仅一级目录或 `projects/*` 一级子目录，二级目录拒）→ `missing`。顺序与设计 D4①② 一致，`..` 穿越由 `resolve` 归一后先行拦下；既有 spec 四类断言与实测一致。对「一级普通文件」也能过守卫（`existsSync` 为真即 `rm`）——属本人根内可删内容、UI 不可达，未计 bug。
2. **符号链接防御**：`listOverview` 对 symlink 一律不列不展开（含 `projects` 容器本身是 symlink 时整体跳过）；`computeSize` 用 `readdir` 的 Dirent + 文件 `lstat` 识别后跳过、永不跟随；`rm(recursive, force:false)` 对 symlink 只删链本身（不逃逸出本人根）；`existsSync(join(path,'.git'))` 跟随 `.git` 链接仅为展示。均符合 D4 / §2.1-2。
3. **LIKE ESCAPE 转义**：`listActiveWorkspaceReferences` 用 `escapeLike(path + sep)` + `ESCAPE '\\\\'`（JS 模板字符串产出 SQL 文本 `ESCAPE '\\'`，MySQL 默认模式下解析为单反斜杠），与仓库既有 4 处 `LIKE ... ESCAPE '\\\\'` 惯例一致；`%`/`_`/`\` 三类字符都被转义，路径含通配符不会扩大匹配（spec 参数断言已覆盖）。
4. **聚合口径与日期类型**：`aggregateWorkspaceUsage` 的 `active` 用 `ACTIVE_PHASE_SQL_LIST`（唯一来源 `session-group-key.ts`，与 `isActivePhase` / 桌面 `ACTIVE_PHASES` 同源）、`deleted = 0`、`workspace IS NOT NULL`、`MAX(updated_at)` 与 D7 一致；DB 池 `dateStrings: true`（`db.ts:104`）保证 `lastUsedAt` 是 `YYYY-MM-DD HH:mm:ss` 字符串，JS 侧字符串比较 / `localeCompare` 排序与桌面 `formatDateTime`/`parseDateTime` 兼容，无 Date/字符串混型问题。
5. **前缀归并边界**：`buildEntry` 用 `workspace === path || workspace.startsWith(path + sep)`，嵌套目录（`demo` 与 `demo/sub`）正确归并到 `demo`；数字名=temp、`projects/` 子目录=project、其余=other 三类判定与符号链接跳过均有 spec 覆盖；机器人通道工作区在**全局根**（`{workspaceRoot}/feishu-chat|dingtalk-chat`）不在本人根，天然排除（D2）。
6. **信封语义与 HTTP 映射**：`sendOk(reply)` → `ok(undefined)` 省略 `data`（result.ts:14-16），桌面 `refreshWorkspaceOverview`/`deleteWorkspaceByPath` 不读 data，无空解构；400 / 409 用 HTTP 200 + `fail` 信封，与仓库 BusinessException 既有映射一致；桌面 axios 拦截器 `code !== 0` 即 reject + toast，`confirmDelete` 的 catch 保持弹层打开、`fetchWorkspaceReferences` 的 catch 回落空清单，均按设计落地；`GET references` 的 `sendOk(array)` 正常带 data。
7. **新建任务下拉富化**：`enrichCloudProjectsWithOverview` 有 `generation !== newTaskModeGeneration` 双重校验（await 前后），失败静默回落纯目录名；合并键 `path` 与 `cloud-projects` 端点同构（同为 `resolve(root, userId)` + `join`），能对上；`sizeBytes == null`（pending）时不显示大小、只显示会话数副标题，回落路径无渲染崩溃。
8. **`sizeInFlight` 去重无竞态**：`computeSize` 的首个 await 之前 worker 已同步 `sizeInFlight.set`，并发 `listOverview` 不会重复入队；`refresh(userId, path)` 在已有 in-flight 时跳过重算、由在途 walk 完成后写回新缓存，属可接受语义（最多少量秒的旧值），未计 bug。
9. **`workspace-browse` 缺根文案**：实作用 `BusinessException(PARAM_INVALID, '工作区目录不存在（可能已被删除）')`（设计 §4.1-4 写的是 NOT_FOUND）——文案一致、桌面渲染的是 message，错误码差异不影响用户可见行为，未计 bug。
10. **观察项（未计 bug）**：`aggregateWorkspaceUsage` 的 `active` 只按 phase 不过滤 `status`，一个「归档时仍在 RUNNING」的会话会同时计入「进行中」和「归档」，并按 D4③ 字面口径阻断删除。设计 D4③ 明确只按 `isActivePhase(phase)` 判定（「归档会话引用允许删」的注释语境是相位已终态的归档会话），且需先手动归档运行中会话才触发，属设计口径内的边缘，不计 bug；如要收紧可在两条 SQL 补 `status = 'ACTIVE'`（与 `session.service.ts:1633` 既有口径对齐），请与方案作者确认后定。
