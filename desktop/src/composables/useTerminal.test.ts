import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useTerminal } from './useTerminal'
import { useTerminalModifiers } from './useTerminalModifiers'
import { useSessionStore, type Session } from '../stores/session'

const { apiMock, wsMock, FakeTerminal } = vi.hoisted(() => {
  class FakeTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    element: unknown = null
    textarea: unknown = null
    write = vi.fn()
    focus = vi.fn()
    open = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
    private dataCb: ((data: string) => void) | null = null
    onData = vi.fn((cb: (data: string) => void) => {
      this.dataCb = cb
      return { dispose: () => {} }
    })
    onResize = vi.fn(() => ({ dispose: () => {} }))

    emitData(data: string): void {
      this.dataCb?.(data)
    }
  }
  return {
    FakeTerminal,
    apiMock: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
    wsMock: {
      registerTerminal: vi.fn(),
      unregisterTerminal: vi.fn(),
      attach: vi.fn(),
      detach: vi.fn(),
      sendInput: vi.fn(),
      sendResize: vi.fn(),
      isAttached: vi.fn(() => true),
    },
  }
})

vi.mock('../api', () => ({ api: apiMock }))
vi.mock('./useTerminalWS', () => ({ useTerminalWS: () => wsMock }))
vi.mock('element-plus', () => ({ ElMessage: { warning: vi.fn(), error: vi.fn() } }))
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); dispose = vi.fn() } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss = vi.fn(); dispose = vi.fn() } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {
  onDidChangeResults = vi.fn(() => ({ dispose: () => {} }))
  clearDecorations = vi.fn()
  findNext = vi.fn()
  findPrevious = vi.fn()
} }))

function makeSession(id: string): Session {
  return {
    id,
    agentId: '1',
    agentName: 'Agent',
    title: 'T',
    executionMode: 'CLOUD',
    status: 'ACTIVE',
    createdAt: '',
    updatedAt: '',
    messageCount: 0,
    phase: 'IDLE' as Session['phase'],
    elapsedMs: 0,
    running: false,
  }
}

function remoteInfo(terminalId: string) {
  return { terminalId, sessionId: 1, shell: '/bin/bash', cwd: '/root', cols: 80, rows: 24, createdAt: 0 }
}

function useCloudSession(id = 's1') {
  const store = useSessionStore()
  store.upsertSessionEntity(makeSession(id))
  store.setActiveSession(id)
  return store
}

describe('useTerminal 关闭最后一个 tab 自动收起面板', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    wsMock.attach.mockResolvedValue(undefined)
    vi.stubGlobal('document', {
      documentElement: { getAttribute: vi.fn(() => 'dark') },
      body: { style: {} },
    })
    vi.stubGlobal('MutationObserver', class { observe = vi.fn(); disconnect = vi.fn() })
    useTerminal().reset()
  })

  it('关闭最后一个终端 tab 后自动收起终端面板', async () => {
    useCloudSession()
    const terminal = useTerminal()
    terminal.isOpen.value = true
    apiMock.post.mockResolvedValue({ data: remoteInfo('t1') })

    expect(await terminal.createTerminal()).toBe('t1')
    expect(terminal.isOpen.value).toBe(true)

    apiMock.delete.mockResolvedValue({})
    await terminal.closeTerminal('t1')

    expect(apiMock.delete).toHaveBeenCalledWith('/sessions/s1/terminals/t1')
    expect(terminal.isOpen.value).toBe(false)
  })

  it('仍有其他终端 tab 时保持面板打开并切到相邻 tab', async () => {
    useCloudSession()
    const terminal = useTerminal()
    terminal.isOpen.value = true
    apiMock.post
      .mockResolvedValueOnce({ data: remoteInfo('t1') })
      .mockResolvedValueOnce({ data: remoteInfo('t2') })

    await terminal.createTerminal()
    await terminal.createTerminal()
    apiMock.delete.mockResolvedValue({})
    await terminal.closeTerminal('t1')

    expect(terminal.isOpen.value).toBe(true)
    expect(terminal.activeTabId.value).toBe('t2')
  })

  it('终端进程退出（onExit）同样触发自动收起', async () => {
    useCloudSession()
    const terminal = useTerminal()
    terminal.isOpen.value = true
    apiMock.post.mockResolvedValue({ data: remoteInfo('t1') })
    await terminal.createTerminal()

    const handlers = wsMock.registerTerminal.mock.calls.find((call) => call[0] === 't1')![1]
    handlers.onExit()

    expect(terminal.isOpen.value).toBe(false)
  })

  it('sendRaw 走原始通道并消耗单次修饰键', async () => {
    useCloudSession()
    const terminal = useTerminal()
    terminal.isOpen.value = true
    apiMock.post.mockResolvedValue({ data: remoteInfo('t1') })
    await terminal.createTerminal()

    const mods = useTerminalModifiers()
    mods.toggleCtrl()
    terminal.sendRaw('\x03')

    expect(wsMock.sendInput).toHaveBeenCalledWith('t1', '\x03')
    expect(mods.ctrl.value).toBe('off')
  })

  it('onData 经过修饰键处理（软键盘路径）', async () => {
    useCloudSession()
    const terminal = useTerminal()
    terminal.isOpen.value = true
    apiMock.post.mockResolvedValue({ data: remoteInfo('t1') })
    await terminal.createTerminal()

    const inst = terminal.getInstance('t1')!
    const mods = useTerminalModifiers()
    mods.toggleCtrl()
    const fake = inst.terminal as unknown as { emitData: (data: string) => void }
    fake.emitData('c')

    expect(wsMock.sendInput).toHaveBeenCalledWith('t1', '\x03')
    expect(mods.ctrl.value).toBe('off')
  })

  it('触屏端 mount 终端不自动聚焦（不弹软键盘）', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    useCloudSession()
    const terminal = useTerminal()
    terminal.isOpen.value = true
    apiMock.post.mockResolvedValue({ data: remoteInfo('t1') })
    await terminal.createTerminal()

    const inst = terminal.getInstance('t1')!
    terminal.mountTerminal('t1', {} as HTMLElement)
    await nextTick()
    await nextTick()

    const focusMock = inst.terminal.focus as unknown as { mock: { calls: unknown[] } }
    expect(focusMock.mock.calls).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('首帧序号超过 attached 基线时自动请求全量回放', async () => {
    useCloudSession()
    const terminal = useTerminal()
    terminal.isOpen.value = true
    apiMock.post.mockResolvedValue({ data: remoteInfo('t1') })
    await terminal.createTerminal()
    const handlers = wsMock.registerTerminal.mock.calls.find((call) => call[0] === 't1')![1]
    wsMock.attach.mockClear()

    handlers.onAttached(80, 24, { replay: 'full', seq: 10 })
    handlers.onOutput('x', { seq: 12, endSeq: 13 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wsMock.attach).toHaveBeenCalledWith('t1', { fromSeq: null })
  })

  it('空 delta 之后首帧序号等于基线时不误判缺口', async () => {
    useCloudSession()
    const terminal = useTerminal()
    terminal.isOpen.value = true
    apiMock.post.mockResolvedValue({ data: remoteInfo('t1') })
    await terminal.createTerminal()
    const handlers = wsMock.registerTerminal.mock.calls.find((call) => call[0] === 't1')![1]
    wsMock.attach.mockClear()

    handlers.onAttached(80, 24, { replay: 'delta', seq: 10 })
    handlers.onOutput('x', { seq: 10, endSeq: 11 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wsMock.attach).not.toHaveBeenCalled()
  })
})
