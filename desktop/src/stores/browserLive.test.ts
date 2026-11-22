import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBrowserLiveStore } from './browserLive'

// 浏览器直播 store（方案 2026-11-20 v2 D10）：事件 ingest 序列、乱序帧丢弃、
// stopped 收窗态、停止动作只在 Electron 下走 IPC。
describe('browserLive store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('ingest 开始/帧/停止 完整序列', () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 11, type: 'browser_live_started', data: { width: 1280, height: 720, pageUrl: 'https://example.com', cliSession: 'default' } })
    expect(store.sessions['11'].isLive).toBe(true)
    expect(store.activeSessionId).toBe(11)

    store.ingest({ sessionId: 11, type: 'browser_frame', data: { seq: 1, jpeg: 'A', pageUrl: 'https://example.com/a' } })
    expect(store.sessions['11'].frame).toBe('A')
    expect(store.sessions['11'].pageUrl).toBe('https://example.com/a')

    store.ingest({ sessionId: 11, type: 'browser_live_stopped', data: { reason: 'browser_exit' } })
    expect(store.sessions['11'].isLive).toBe(false)
    expect(store.sessions['11'].stoppedReason).toBe('browser_exit')
    expect(store.hasAnyLive).toBe(false)
  })

  it('乱序帧直接丢弃，不覆盖最新画面', () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 5, type: 'browser_frame', data: { seq: 10, jpeg: 'new' } })
    store.ingest({ sessionId: 5, type: 'browser_frame', data: { seq: 7, jpeg: 'stale' } })
    expect(store.sessions['5'].frame).toBe('new')
    expect(store.sessions['5'].lastSeq).toBe(10)
  })

  it('同一会话二次直播：started 重置 lastSeq/frame/stoppedReason（2026-11-22 回归）', () => {
    const store = useBrowserLiveStore()
    // 第一场：started → 帧 → 停止
    store.ingest({ sessionId: 21, type: 'browser_live_started', data: { width: 1280, height: 720, pageUrl: 'https://a.com', cliSession: 'default' } })
    store.ingest({ sessionId: 21, type: 'browser_frame', data: { seq: 5, jpeg: 'first', pageUrl: 'https://a.com/x' } })
    store.ingest({ sessionId: 21, type: 'browser_live_stopped', data: { reason: 'browser_exit' } })
    expect(store.sessions['21'].isLive).toBe(false)
    expect(store.sessions['21'].stoppedReason).toBe('browser_exit')

    // 第二场：host 进程重启后 seq 从 1 重新计数——不清 lastSeq 整场帧都会被丢
    store.ingest({ sessionId: 21, type: 'browser_live_started', data: { width: 800, height: 600, pageUrl: 'https://b.com', cliSession: 'default' } })
    expect(store.sessions['21'].isLive).toBe(true)
    expect(store.sessions['21'].stoppedReason).toBeNull()
    expect(store.sessions['21'].frame).toBeNull()
    expect(store.sessions['21'].lastSeq).toBe(0)

    store.ingest({ sessionId: 21, type: 'browser_frame', data: { seq: 1, jpeg: 'second', pageUrl: 'https://b.com/y' } })
    expect(store.sessions['21'].frame).toBe('second')
    expect(store.sessions['21'].lastSeq).toBe(1)
    expect(store.hasAnyLive).toBe(true)
  })

  it('最近活跃会话跟随帧事件', () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 1, type: 'browser_frame', data: { seq: 1, jpeg: 'a' } })
    store.ingest({ sessionId: 2, type: 'browser_frame', data: { seq: 1, jpeg: 'b' } })
    expect(store.activeSessionId).toBe(2)
    expect(store.activeSession?.frame).toBe('b')
  })

  it('stopBrowser 仅在 Electron 下走 IPC，且缺省用最近活跃会话', () => {
    // 非 Electron（node 测试环境无 electronAPI）：未注入停止通道时不抛错、不动作
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 9, type: 'browser_live_started', data: { width: 1, height: 1 } })
    expect(() => store.stopBrowser()).not.toThrow()

    // Electron 存在时：透传 sessionId（node 测试环境无 window，以 globalThis stub）
    const stopCalls: Array<number | undefined> = []
    const stubWindow = { electronAPI: { browserLive: { stop: (sid: number | undefined) => stopCalls.push(sid) } } }
    ;(globalThis as any).window = stubWindow
    try {
      store.stopBrowser()
      expect(stopCalls).toEqual([9])
      store.stopBrowser(3)
      expect(stopCalls).toEqual([9, 3])
    } finally {
      delete (globalThis as any).window
    }
  })

  it('Web 端（M2）：注入停止通道后 stopBrowser 走请求器，Electron 优先级更高', () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 7, type: 'browser_live_started', data: { width: 1, height: 1 } })
    const requested: number[] = []
    store.setStopRequester((sid) => requested.push(sid))

    // 非 Electron：走注入的请求器（缺省最近活跃会话 / 显式 sessionId 均可）
    store.stopBrowser()
    expect(requested).toEqual([7])
    store.stopBrowser(4)
    expect(requested).toEqual([7, 4])

    // Electron 存在时：仍走 IPC，不走请求器
    const ipcCalls: number[] = []
    ;(globalThis as any).window = { electronAPI: { browserLive: { stop: (sid: number) => ipcCalls.push(sid) } } }
    try {
      store.stopBrowser(2)
      expect(ipcCalls).toEqual([2])
      expect(requested).toEqual([7, 4])
    } finally {
      delete (globalThis as any).window
    }

    // null 同 undefined：?? 语义回退到最近活跃会话
    store.stopBrowser(null)
    expect(requested).toEqual([7, 4, 7])
  })

  it('bindMainProcess 在非 Electron 下是空操作且可重复调用', () => {
    const store = useBrowserLiveStore()
    expect(() => {
      store.bindMainProcess()
      store.bindMainProcess()
    }).not.toThrow()
    expect(store.ipcBound).toBe(false)
  })
})
