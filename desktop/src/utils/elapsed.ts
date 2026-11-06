/**
 * 执行中耗时的紧凑展示：<1m 用秒，<1h 用 m/s（如 1m30s），否则折算小时。
 * 各档位一律向下取整——秒级走表本来就会每秒跳变，取整只会让显示比真实稍慢不到 1s。
 * 与轨迹 tab RunTracePanel 的 formatMs（宽式 "1m 30s"、含 null 兜底）是两套用途：
 * 这里只服务「执行中」的实时计时。不足 1s 的值由调用方（ToolCallElapsed）门控不渲染
 * ——绝大多数工具调用远小于 1s，一闪而过的 ms 数字只是噪音——故这里不再需要 ms 档。
 */
export function formatElapsedMs(ms: number): string {
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

/**
 * 把服务端「已耗时」换算成客户端起表基座（epoch ms）：订阅重放的在途 tool_call_start 带
 * elapsed_ms（服务端口径）——页面刷新 / 网络重连后计时接得上真正的开始时刻，不再从 0 起表；
 * 缺失（实时事件的收包时刻即开始时刻）或非法值时退回当前时刻。
 * 用相对耗时而非绝对时刻传递，两端时钟偏差不影响结果。
 */
export function elapsedBaseMs(elapsedMs?: number | null): number {
  return typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? Date.now() - elapsedMs
    : Date.now()
}
