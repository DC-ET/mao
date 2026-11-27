import type { ReplayFrameMeta } from '@mao/contracts'

/**
 * 回放播放器纯函数：时间轴密度带几何、点击/拖拽定位、播放头推进、播放头秒表。
 *
 * 来源：desktop/src/utils/replayPlayer.ts（V202，技术方案 2026-11-22 §5.2）。
 * 技术方案 2026-11-27 D4/§5.3：`shared/contracts` 是纯类型包（exports 仅 types），
 * 不能承载运行时代码，MVP 不下沉共享运行模块；admin 播放器跨应用无法复用桌面 SFC，
 * 故在此复制一份并标注来源——改动播放几何/推进逻辑时两端同步，避免分叉。
 */

const TIMELINE_VIEW_WIDTH = 996

/** 时间轴密度带：每帧一根竖条，活跃段浓（间隔短 → 不透明度高）、静止段稀（对数映射）。 */
export function replayBars(frames: ReplayFrameMeta[]): Array<{ seq: number; x: number; h: number; opacity: number }> {
  if (frames.length === 0) return []
  const t0 = frames[0].ts
  const span = Math.max(1, frames[frames.length - 1].ts - t0)
  return frames.map((frame, i) => {
    const gap = i + 1 < frames.length ? frames[i + 1].ts - frame.ts : span / Math.max(1, frames.length)
    const opacity = gap <= 1000 ? 1 : Math.max(0.15, 1 - Math.log10(gap / 1000) / 2)
    return {
      seq: frame.seq,
      x: Math.min(TIMELINE_VIEW_WIDTH - 4, ((frame.ts - t0) / span) * (TIMELINE_VIEW_WIDTH - 4)),
      h: 26,
      opacity: Number(opacity.toFixed(2)),
    }
  })
}

/** 时间轴点击 / 拖拽（0..1 比例）→ 命中 ts <= 目标时间的最后一帧索引。 */
export function replayIndexForRatio(frames: ReplayFrameMeta[], ratio: number): number {
  if (frames.length === 0) return -1
  const clamped = Math.max(0, Math.min(1, ratio))
  const t0 = frames[0].ts
  const span = Math.max(1, frames[frames.length - 1].ts - t0)
  const targetTs = t0 + clamped * span
  let idx = 0
  while (idx + 1 < frames.length && frames[idx + 1].ts <= targetTs) idx += 1
  return idx
}

/** 播放头推进：从 fromIdx 起，返回 ts <= playheadTs 的最后一帧索引（不回退，单调前进）。 */
export function replayAdvanceIndex(frames: ReplayFrameMeta[], fromIdx: number, playheadTs: number): number {
  if (frames.length === 0) return -1
  let idx = Math.max(0, Math.min(fromIdx, frames.length - 1))
  while (idx + 1 < frames.length && frames[idx + 1].ts <= playheadTs) idx += 1
  return idx
}

/** 播放头秒表（mm:ss），基于首帧相对时间。 */
export function replayClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/**
 * 管理端帧端点路径（技术方案 2026-11-27 §4.2）。liveId 走 `L\d+` 白名单（后端校验），
 * 这里仍 encodeURIComponent 兜底；sessionId 由后端反查归属，不接受前端传 uid。
 */
export function frameUrlFor(sessionId: number, liveId: string, seq: number): string {
  return `/admin/browser-replays/${sessionId}/${encodeURIComponent(liveId)}/frames/${seq}`
}

/**
 * axios 错误 → HTTP 状态码（无 response 时返回 0）。
 * 后端 404 是空 body（`reply.status(404).send()`）而非 Result 信封错误码，
 * 帧/timeline 的「已被清理」必须按 HTTP 状态判定，不能按业务码（范本 desktop/src/api/index.ts fetchBrowserReplayFrame）。
 */
export function httpStatusOf(error: unknown): number {
  const status = (error as { response?: { status?: number } })?.response?.status
  return typeof status === 'number' ? status : 0
}
