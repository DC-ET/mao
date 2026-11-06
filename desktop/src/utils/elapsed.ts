/**
 * 执行中耗时的紧凑展示：<1s 用 ms，<1m 用秒，<1h 用 m/s（如 1m30s），否则折算小时。
 * 各档位一律向下取整——秒级走表本来就会每秒跳变，取整只会让显示比真实稍慢不到 1s。
 * 与轨迹 tab RunTracePanel 的 formatMs（宽式 "1m 30s"、含 null 兜底）是两套用途：
 * 这里只服务「执行中」的实时计时，不需要 null 兜底（无起表时刻的调用根本不渲染）。
 */
export function formatElapsedMs(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms)}ms`
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.floor((ms % 60_000) / 1000)
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`
  }
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
}
