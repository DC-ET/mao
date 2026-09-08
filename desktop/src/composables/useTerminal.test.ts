import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTerminal } from './useTerminal'
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
    onData = vi.fn(() => ({ dispose: () => {} }))
    onResize = vi.fn(() => ({ dispose: () => {} }))
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
})
