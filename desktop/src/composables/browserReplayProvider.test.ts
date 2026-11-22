import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserReplayProvider } from './browserReplayProvider'
import { isElectronClient } from '../utils/platform'

// 回放数据双路分流（V202，技术方案 §4）：CLOUD→axios、LOCAL(Electron)→主进程 IPC、
// Web 看 LOCAL 会话→无 provider。LOCAL 帧字节（invoke 结构化克隆的 Uint8Array）转 base64。
vi.mock('../utils/platform', () => ({ isElectronClient: vi.fn() }))

function stubElectronApi(api: Record<string, unknown>) {
  ;(globalThis as { window?: unknown }).window = { electronAPI: { browserLive: api } }
}

describe('createBrowserReplayProvider', () => {
  beforeEach(() => {
    vi.mocked(isElectronClient).mockReset()
    delete (globalThis as { window?: unknown }).window
  })

  it('CLOUD：走 axios provider（方法存在，数据形态由 api 层保证）', () => {
    expect(createBrowserReplayProvider('CLOUD')).not.toBeNull()
  })

  it('Web 看 LOCAL 会话：无 provider（runtime 数据不在本机也不在服务端）', () => {
    vi.mocked(isElectronClient).mockReturnValue(false)
    expect(createBrowserReplayProvider('LOCAL')).toBeNull()
    expect(createBrowserReplayProvider(undefined)).toBeNull()
  })

  it('LOCAL(Electron)：IPC 直读，帧字节转 base64，空字节返回 null', async () => {
    vi.mocked(isElectronClient).mockReturnValue(true)
    stubElectronApi({
      replayList: async (sessionId: number) => {
        expect(sessionId).toBe(11)
        return [{ liveId: 'L1000', startedAt: 1000, endedAt: 2000, frameCount: 1, durationMs: 1000, approxBytes: 3, truncated: false }]
      },
      replayTimeline: async () => null,
      replayFrame: vi.fn()
        .mockResolvedValueOnce(new Uint8Array([104, 105])) // "hi"
        .mockResolvedValueOnce(new Uint8Array([])),
    })
    const provider = createBrowserReplayProvider('LOCAL')
    expect(provider).not.toBeNull()
    const summaries = await provider!.list(11)
    expect(summaries[0].liveId).toBe('L1000')
    expect(await provider!.frame(11, 'L1000', 1)).toBe(btoa('hi'))
    expect(await provider!.frame(11, 'L1000', 2)).toBeNull()
  })

  it('Electron 但缺 replay API（旧主进程）：provider 为 null', () => {
    vi.mocked(isElectronClient).mockReturnValue(true)
    stubElectronApi({ getState: async () => ({}) })
    expect(createBrowserReplayProvider('LOCAL')).toBeNull()
  })
})
