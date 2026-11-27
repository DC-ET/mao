import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBrowserLiveStore } from './browserLive'
import { createBrowserReplayProvider } from '../composables/browserReplayProvider'
import type { BrowserInputBatch } from '@mao/contracts'

vi.mock('../composables/browserReplayProvider', () => ({ createBrowserReplayProvider: vi.fn() }))

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

  it('订阅重放 started（replay）不清帧、不重置 seq，只校准元数据', () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 61, type: 'browser_live_started', data: { width: 1280, height: 720, pageUrl: 'https://a.com', cliSession: 'ui2' } })
    store.ingest({ sessionId: 61, type: 'browser_frame', data: { seq: 42, jpeg: 'frame42', pageUrl: 'https://a.com/x' } })

    store.ingest({ sessionId: 61, type: 'browser_live_started', data: { width: 800, height: 600, pageUrl: 'https://a.com/y', cliSession: 'ui2', replay: true } })
    // 画中画 / Tab 不闪白：帧与 seq 保持，只校准元数据
    expect(store.sessions['61'].frame).toBe('frame42')
    expect(store.sessions['61'].lastSeq).toBe(42)
    expect(store.sessions['61'].pageUrl).toBe('https://a.com/y')
    expect(store.sessions['61'].width).toBe(800)
    expect(store.sessions['61'].isLive).toBe(true)

    // seq 未重置，乱序保护仍生效
    store.ingest({ sessionId: 61, type: 'browser_frame', data: { seq: 41, jpeg: 'stale' } })
    expect(store.sessions['61'].frame).toBe('frame42')
  })

  it('刷新后 store 为空时收到 replay：按正常 started 建立直播态', () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 62, type: 'browser_live_started', data: { width: 800, height: 600, pageUrl: 'https://a.com', cliSession: 'ui2', replay: true } })
    expect(store.sessions['62'].isLive).toBe(true)
    expect(store.sessions['62'].stoppedReason).toBeNull()
    expect(store.hasAnyLive).toBe(true)
  })

  it('replay 的宽高为 0 也要生效（最小化 / 隐藏窗口的合法尺寸，不能被 falsy 判断吞掉）', () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 63, type: 'browser_live_started', data: { width: 1280, height: 720, pageUrl: 'https://a.com', cliSession: 'ui2' } })
    // sidecar 对隐藏 / 最小化页面会报 0×0；重连重放时不能沿用刷新前的旧尺寸做布局
    store.ingest({ sessionId: 63, type: 'browser_live_started', data: { width: 0, height: 0, pageUrl: 'https://a.com', cliSession: 'ui2', replay: true } })
    expect(store.sessions['63'].isLive).toBe(true)
    expect(store.sessions['63'].width).toBe(0)
    expect(store.sessions['63'].height).toBe(0)
  })

  it('replay 的空串 pageUrl / cliSession 也要覆盖（与宽高同口径按类型判断）', () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 64, type: 'browser_live_started', data: { width: 800, height: 600, pageUrl: 'https://a.com/x', cliSession: 'ui2' } })
    // 空串是服务端重放的真实值；falsy 判断会让客户端一直显示刷新前的旧地址 / 旧会话名
    store.ingest({ sessionId: 64, type: 'browser_live_started', data: { width: 800, height: 600, pageUrl: '', cliSession: '', replay: true } })
    expect(store.sessions['64'].pageUrl).toBe('')
    expect(store.sessions['64'].cliSession).toBe('')
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

describe('browserLive store 协作输入（技术方案 2026-11-27）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const META = { targetId: 'T1', deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0, offsetLeft: 0, offsetTop: 0 }

  it('ingest：started.control → startedControl；帧 meta / lastFrameAt；帧级 meta 缺失沿用上一个', () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 11, type: 'browser_live_started', data: { width: 1280, height: 720, control: true } })
    expect(store.sessions['11'].startedControl).toBe(true)

    store.ingest({ sessionId: 11, type: 'browser_frame', data: { seq: 1, jpeg: 'A', meta: META } })
    expect(store.sessions['11'].frameMeta).toEqual(META)
    expect(store.sessions['11'].lastFrameAt).toBeGreaterThan(0)

    // 帧不带 meta（CDP 可选字段）：沿用上一个
    store.ingest({ sessionId: 11, type: 'browser_frame', data: { seq: 2, jpeg: 'B' } })
    expect(store.sessions['11'].frameMeta).toEqual(META)

    // stopped → 能力标记复位（交互入口随之失效）
    store.ingest({ sessionId: 11, type: 'browser_live_stopped', data: { reason: 'user_stop' } })
    expect(store.sessions['11'].startedControl).toBe(false)
  })

  it('新一场 started 重置 frameMeta / startedControl / inputUnsupported；replay 只按类型校准 control', () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 12, type: 'browser_live_started', data: { width: 800, height: 600, control: true } })
    store.ingest({ sessionId: 12, type: 'browser_frame', data: { seq: 1, jpeg: 'A', meta: META } })
    store.inputUnsupported['12'] = true

    // replay：control 按类型判断校准（旧 sidecar replay 不带 → 保留旧值）
    store.ingest({ sessionId: 12, type: 'browser_live_started', data: { width: 800, height: 600, replay: true } })
    expect(store.sessions['12'].startedControl).toBe(true)
    expect(store.sessions['12'].frameMeta).toEqual(META)

    // 新一场（非 replay）：meta 清空、unsupported 复位、control 以新值定
    store.ingest({ sessionId: 12, type: 'browser_live_started', data: { width: 640, height: 480 } })
    expect(store.sessions['12'].frameMeta).toBeNull()
    expect(store.sessions['12'].startedControl).toBe(false)
    expect(store.inputUnsupported['12']).toBeUndefined()
  })

  it('inputBrowser：Electron 走 IPC，unsupported 只记一次；Web 走注入请求器', async () => {
    const store = useBrowserLiveStore()
    store.ingest({ sessionId: 9, type: 'browser_live_started', data: { width: 1, height: 1 } })
    const batch: BrowserInputBatch = { targetId: null, events: [{ type: 'char', text: 'a' }] }

    // Web（无 electronAPI）：未注入请求器时不抛错；注入后按 (sid, batch) 透传
    expect(() => store.inputBrowser(9, batch)).not.toThrow()
    const relayed: Array<[number, BrowserInputBatch]> = []
    store.setInputRequester((sid, data) => relayed.push([sid, data]))
    store.inputBrowser(9, batch)
    store.inputBrowser(null, batch) // 缺省回退最近活跃会话
    expect(relayed).toEqual([[9, batch], [9, batch]])

    // Electron：IPC 透传；'unsupported' 回执只记一次标记（高频批不重复提示）
    const calls: Array<[number, BrowserInputBatch]> = []
    let reply = 'ok'
    ;(globalThis as any).window = {
      electronAPI: { browserLive: { input: (sid: number, data: BrowserInputBatch) => { calls.push([sid, data]); return Promise.resolve(reply) } } },
    }
    try {
      await store.inputBrowser(9, batch)
      await store.inputBrowser(9, batch)
      expect(calls).toEqual([[9, batch], [9, batch]])
      expect(store.inputUnsupported['9']).toBeUndefined()

      reply = 'unsupported'
      await store.inputBrowser(9, batch)
      await store.inputBrowser(9, batch)
      expect(store.inputUnsupported['9']).toBe(true) // 标记置位（第二次不再置，视图据此禁用入口）
    } finally {
      delete (globalThis as any).window
    }
  })
})

describe('browserLive store 回放入口（V202）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(createBrowserReplayProvider).mockReset()
  })

  it('requestReplayBrowse 记账递增；consumeReplayBrowse 只消费一次（记账在 store，Tab 新挂载不吞请求）', () => {
    const store = useBrowserLiveStore()
    expect(store.replayBrowse.seq).toBe(0)
    store.requestReplayBrowse(31)
    expect(store.replayBrowse).toEqual({ sessionId: 31, seq: 1, consumedSeq: 0 })
    expect(store.consumeReplayBrowse()).toEqual({ sessionId: 31 })
    expect(store.consumeReplayBrowse()).toBeNull() // 消费后回写 consumedSeq，重复调用返回 null
    store.requestReplayBrowse(null)
    expect(store.consumeReplayBrowse()).toEqual({ sessionId: null })
  })

  it('started/stopped 使回放可用性缓存置过期（保留上次结果、checkedAt=0 触发重探）', () => {
    const store = useBrowserLiveStore()
    store.replayAvailability['11'] = { available: true, checkedAt: Date.now() }
    store.ingest({ sessionId: 11, type: 'browser_live_started', data: {} })
    expect(store.replayAvailability['11']).toEqual({ available: true, checkedAt: 0 })
    store.ingest({ sessionId: 11, type: 'browser_live_stopped', data: { reason: 'user_stop' } })
    expect(store.replayAvailability['11']).toEqual({ available: true, checkedAt: 0 })
  })

  it('ensureReplayAvailability：无 provider（Web 看 LOCAL）标记不可用；有 provider 回填列表结果', async () => {
    const store = useBrowserLiveStore()
    vi.mocked(createBrowserReplayProvider).mockReturnValue(null)
    await store.ensureReplayAvailability(41, 'LOCAL')
    expect(store.replayAvailability['41'].available).toBe(false)

    vi.mocked(createBrowserReplayProvider).mockReturnValue({ list: async () => [{ liveId: 'L1', startedAt: 1, endedAt: 2, frameCount: 3, durationMs: 1, approxBytes: 0, truncated: false }], timeline: async () => null, frame: async () => null })
    await store.ensureReplayAvailability(42, 'CLOUD')
    expect(store.replayAvailability['42'].available).toBe(true)
  })

  it('过期缓存（checkedAt=0）在 30s 内也会重探：直播结束后 chip 才能恢复显示', async () => {
    const store = useBrowserLiveStore()
    const listFn = vi.fn(async () => [{ liveId: 'L1', startedAt: 1, endedAt: 2, frameCount: 1, durationMs: 1, approxBytes: 0, truncated: false }])
    vi.mocked(createBrowserReplayProvider).mockReturnValue({ list: listFn, timeline: async () => null, frame: async () => null })
    await store.ensureReplayAvailability(51, 'CLOUD')
    expect(listFn).toHaveBeenCalledTimes(1)
    // 直播结束 → 置过期；即便 30s 缓存窗口未过也立即重探
    store.ingest({ sessionId: 51, type: 'browser_live_stopped', data: { reason: 'user_stop' } })
    await store.ensureReplayAvailability(51, 'CLOUD')
    expect(listFn).toHaveBeenCalledTimes(2)
    expect(store.replayAvailability['51'].available).toBe(true)
  })
})
