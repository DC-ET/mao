// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, type App } from 'vue'
import ElementPlus from 'element-plus'
import WorkspaceOverviewPanel from './WorkspaceOverviewPanel.vue'

/** 审查回归：并发 load 与删除弹层引用清单的代际守卫 */

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
    kind: 'other',
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

const flushMacro = () => new Promise(r => setTimeout(r, 0))

interface SetupState {
  load: () => Promise<void>
  /** 注：setupState 里 ref 是解包后暴露的，entries 直接就是数组、loading 直接是布尔 */
  entries: Array<Record<string, unknown>>
  loading: boolean
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

  it('删除成功后，在途 load 的旧响应不得把已删目录加回表格', async () => {
    const inFlight: Array<(value: unknown) => void> = []
    api.fetchOverview.mockImplementation(() => new Promise(resolve => inFlight.push(resolve as never)))

    await mount()
    inFlight[0]!({ entries: [entry('aaa')], error: null })
    await flushMacro()

    const pending = setupState.load()
    await flushMacro()
    expect(inFlight).toHaveLength(2)

    setupState.openDelete(entry('aaa'))
    setupState.deleteState.confirmText = 'aaa'
    await flushMacro()
    const dialog = document.querySelector('.el-dialog')!
    const confirmBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === '删除')!
    confirmBtn.click()
    await flushMacro()
    await flushMacro()
    expect(inFlight).toHaveLength(3)
    inFlight[2]!({ entries: [], error: null })
    await flushMacro()
    expect(host.textContent).not.toContain('aaa')

    inFlight[1]!({ entries: [entry('aaa')], error: null })
    await flushMacro()
    expect(host.textContent).not.toContain('aaa')
    await pending
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
})
