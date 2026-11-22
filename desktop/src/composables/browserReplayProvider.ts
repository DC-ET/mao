import type { ReplaySummary, ReplayTimeline } from '@mao/contracts'
import { fetchBrowserReplayFrame, fetchBrowserReplayTimeline, listBrowserReplays } from '../api'
import { isElectronClient } from '../utils/platform'

export interface BrowserReplayProvider {
  list(sessionId: number): Promise<ReplaySummary[]>
  timeline(sessionId: number, liveId: string): Promise<ReplayTimeline | null>
  /** 单帧 JPEG 的 base64（对齐直播 drawFrame 的数据形态）；缺失返回 null。 */
  frame(sessionId: number, liveId: string, seq: number): Promise<string | null>
}

const cloudProvider: BrowserReplayProvider = {
  list: (sessionId) => listBrowserReplays(sessionId),
  timeline: (sessionId, liveId) => fetchBrowserReplayTimeline(sessionId, liveId),
  frame: (sessionId, liveId, seq) => fetchBrowserReplayFrame(sessionId, liveId, seq),
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function electronProvider(): BrowserReplayProvider | null {
  const api = (window as unknown as { electronAPI?: { browserLive?: Record<string, unknown> } }).electronAPI?.browserLive
  if (!api?.replayList) return null
  const live = api as unknown as {
    replayList(sessionId: number): Promise<ReplaySummary[] | null>
    replayTimeline(sessionId: number, liveId: string): Promise<{ manifest: ReplayTimeline['manifest']; frames: ReplayTimeline['frames'] } | null>
    replayFrame(sessionId: number, liveId: string, seq: number): Promise<Uint8Array | null>
  }
  return {
    list: async (sessionId) => (await live.replayList(sessionId)) ?? [],
    timeline: async (sessionId, liveId) => (await live.replayTimeline(sessionId, liveId)) ?? null,
    frame: async (sessionId, liveId, seq) => {
      const bytes = await live.replayFrame(sessionId, liveId, seq)
      return bytes && bytes.length > 0 ? bytesToBase64(bytes) : null
    },
  }
}

/**
 * 回放数据双路分流（技术方案 2026-11-22 §4）：CLOUD 会话走 axios API（服务器 runtime 目录）；
 * LOCAL 会话在 Electron 下走主进程 fs 直读 IPC（本机 ~/.mao/runtime）。Web 看 LOCAL 会话时
 * runtime 数据既不在本机也不在服务端，返回 null（调用方显示不可用态）。
 */
export function createBrowserReplayProvider(executionMode: string | null | undefined): BrowserReplayProvider | null {
  if (executionMode === 'CLOUD') return cloudProvider
  if (isElectronClient()) return electronProvider()
  return null
}
