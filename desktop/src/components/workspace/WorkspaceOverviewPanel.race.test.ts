// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, type App } from 'vue'
import ElementPlus from 'element-plus'
import WorkspaceOverviewPanel from './WorkspaceOverviewPanel.vue'

/** 审查回归（2026-10-30 第 1 轮 BUG-3 / BUG-4）：pending 重查与删除弹层引用清单的代际守卫 */

const api = vi.hoisted(() => ({
  fetchOverview: vi.fn(),
  fetchReferences: vi.fn(),
  deleteWorkspace: vi.fn(),
  refreshOverview: vi.fn(),
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

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function entry(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    path: `/root/7/${name}`,
    kind: 'temp',
    isGit: false,
    sizeBytes: null,
    sizeState: 'pending',
    activeSessions: 0,
    archivedSessions: 0,
    lastUsedAt: null,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

/** 让出宏任务队列（fake timers 下必须推进计时器才能 flush 微任务）。 */
const flushMicro = () => vi.advanceTimersByTimeAsync(0)
const flushMacro = () => new Promise(r => setTimeout(r, 0))

interface SetupState {
  load: () => Promise<void>
  refreshOne: (row: unknown) => Promise<void>
  /** 注：setupState 里 ref 是解包后暴露的，entries 直接就是数组 */
  entries: Array<Record<string, unknown>>
  openDelete: (e: unknown) => void
  deleteState: {
    visible: boolean
    entry: { name: string } | null
    references: Array<{ id: number }>
    confirmText: string
  }
}

describe('WorkspaceOverviewPanel 竞态回归', () => {
  let host: HTMLDivElement
  let app: App
  let setupState: SetupState

  beforeEach(() => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
    ;(globalThis as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })
    api.fetchOverview.mockReset()
    api.fetchReferences.mockReset()
    api.deleteWorkspace.mockReset()
    api.refreshOverview.mockReset()
    api.refreshOverview.mockResolvedValue(undefined)
    api.deleteWorkspace.mockResolvedValue(undefined)
    api.fetchReferences.mockResolvedValue([])
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    app.unmount()
    host.remove()
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  async function mount(flush: () => Promise<unknown> = flushMacro): Promise<void> {
    app = createApp(WorkspaceOverviewPanel as never)
    app.use(ElementPlus)
    const vm = app.mount(host) as unknown as { $: { setupState: SetupState } }
    setupState = vm.$.setupState
    await flush()
  }

  it('BUG-3：重查在途时用户点刷新，先发的重查响应不得覆盖刷新后的列表', async () => {
    vi.useFakeTimers()
    const inFlight: Array<(value: unknown) => void> = []
    api.fetchOverview.mockImplementation(() => new Promise(resolve => inFlight.push(resolve as never)))

    await mount(flushMicro)
    // 挂载 load()：目录 42 未就绪 → 触发 3s 重查
    expect(inFlight).toHaveLength(1)
    inFlight[0]!({ entries: [entry('42')], error: null })
    await flushMicro()

    // t=3000：重查计时器触发 → fetch#2 发出（在途，暂不 resolve）
    await vi.advanceTimersByTimeAsync(3000)
    expect(inFlight).toHaveLength(2)

    // t=3100：用户点顶部「刷新」→ load() → fetch#3 带回已算出的大小
    const refreshBtn = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('刷新'))!
    refreshBtn.click()
    await flushMicro()
    expect(inFlight).toHaveLength(3)
    inFlight[2]!({ entries: [entry('42', { sizeState: 'ready', sizeBytes: 4096 })], error: null })
    await flushMicro()
    expect(host.textContent).toContain('4.0 KB')

    // t=3200：先发的重查 fetch#2 才回来（旧数据）：必须被代际守卫丢弃
    inFlight[1]!({ entries: [entry('42')], error: null })
    await flushMicro()
    expect(host.textContent).toContain('4.0 KB')
    expect(host.textContent).not.toContain('统计中')
  })

  it('BUG-3：删除成功后，在途重查响应不得把已删目录加回表格', async () => {
    vi.useFakeTimers()
    const inFlight: Array<(value: unknown) => void> = []
    api.fetchOverview.mockImplementation(() => new Promise(resolve => inFlight.push(resolve as never)))

    await mount(flushMicro)
    inFlight[0]!({ entries: [entry('aaa')], error: null })
    await flushMicro()

    // 重查在途
    await vi.advanceTimersByTimeAsync(3000)
    expect(inFlight).toHaveLength(2)

    // 删除 aaa：confirmDelete → load() 作废在途重查，拉取删除后的列表
    setupState.openDelete(entry('aaa'))
    setupState.deleteState.confirmText = 'aaa'
    await flushMicro()
    const dialog = document.querySelector('.el-dialog')!
    const confirmBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === '删除')!
    confirmBtn.click()
    await flushMicro()
    await flushMicro()
    // 删除后的列表请求（fetch#3）返回空表
    expect(inFlight).toHaveLength(3)
    inFlight[2]!({ entries: [], error: null })
    await flushMicro()
    expect(host.textContent).not.toContain('aaa')

    // 先发的重查响应后到（仍含 aaa）：不得复活已删目录
    inFlight[1]!({ entries: [entry('aaa')], error: null })
    await flushMicro()
    expect(host.textContent).not.toContain('aaa')
  })

  it('BUG-4：先打开目录的引用请求后返回，不得覆盖后打开目录的清单', async () => {
    api.fetchOverview.mockResolvedValue({ entries: [entry('aaa'), entry('bbb')], error: null })
    const refsA = deferred<Array<{ id: number; title: string | null; phase: string | null }>>()
    const refsB = deferred<Array<{ id: number; title: string | null; phase: string | null }>>()
    api.fetchReferences.mockImplementationOnce(() => refsA.promise)
    api.fetchReferences.mockImplementationOnce(() => refsB.promise)

    await mount()

    setupState.openDelete(entry('aaa'))
    expect(api.fetchReferences).toHaveBeenCalledWith('/root/7/aaa')

    // 关闭后再打开 B：references(B) 在途，A 的请求不会取消
    setupState.deleteState.visible = false
    setupState.openDelete(entry('bbb'))
    expect(api.fetchReferences).toHaveBeenCalledWith('/root/7/bbb')

    // B 先回来（无引用），A 后回来（有活跃会话）
    refsB.resolve([])
    await flushMacro()
    refsA.resolve([{ id: 5, title: 'A 的会话', phase: 'RUNNING' }])
    await flushMacro()

    // B 的弹层必须保持无引用（确认按钮可点）
    expect(setupState.deleteState.entry?.name).toBe('bbb')
    expect(setupState.deleteState.references).toEqual([])
  })

  it('BUG-5：并发 load 中先发的旧响应后到，不得覆盖更新的列表', async () => {
    // onMounted + onActivated 在 KeepAlive 首挂时叠加触发两个并发 load
    api.fetchOverview.mockResolvedValueOnce({ entries: [entry('aaa')], error: null })
    await mount()

    const stale = deferred<{ entries: unknown[]; error: null }>()
    const fresh = deferred<{ entries: unknown[]; error: null }>()
    api.fetchOverview.mockImplementationOnce(() => stale.promise)
    api.fetchOverview.mockImplementationOnce(() => fresh.promise)
    // 切走再切回页签：onActivated 再发起一次 load（两个 load 并发在途）
    const first = setupState.load()
    const second = setupState.load()
    await flushMacro()

    // 新 load 先返回（aaa 已删除），旧 load 后返回（仍含 aaa）
    fresh.resolve({ entries: [], error: null })
    await flushMacro()
    stale.resolve({ entries: [entry('aaa')], error: null })
    await flushMacro()
    await Promise.all([first, second])

    expect(host.textContent).not.toContain('aaa')
  })

  it('BUG-6：行内刷新后在途 load 的旧快照不得覆盖 pending，重算后的大小要能显示', async () => {
    vi.useFakeTimers()
    api.fetchOverview.mockResolvedValue({ entries: [entry('aaa', { sizeState: 'ready', sizeBytes: 1024 })], error: null })
    await mount(flushMicro)
    expect(host.textContent).toContain('1.0 KB')

    // 切页签触发的 load 在途（暂不 resolve）
    const staleLoad = deferred<{ entries: unknown[]; error: null }>()
    api.fetchOverview.mockImplementationOnce(() => staleLoad.promise)
    const pendingLoad = setupState.load()
    await flushMicro()

    // 行内「重新统计」：POST 成功后置 pending 并排 3s 重查
    const requery = deferred<{ entries: unknown[]; error: null }>()
    api.fetchOverview.mockImplementationOnce(() => requery.promise)
    const row = setupState.entries.find(e => e.name === 'aaa')!
    void setupState.refreshOne(row)
    await flushMicro()
    expect(host.textContent).toContain('统计中')

    // 在途 load 的旧快照后到：不得把 pending 覆盖回旧大小，也不得取消重查计时器
    staleLoad.resolve({ entries: [entry('aaa', { sizeState: 'ready', sizeBytes: 1024 })], error: null })
    await flushMicro()
    expect(host.textContent).toContain('统计中')

    // 3s 重查返回服务端重算的新大小
    await vi.advanceTimersByTimeAsync(3000)
    requery.resolve({ entries: [entry('aaa', { sizeState: 'ready', sizeBytes: 4096 })], error: null })
    await flushMicro()
    expect(host.textContent).toContain('4.0 KB')
    await pendingLoad
  })
})
