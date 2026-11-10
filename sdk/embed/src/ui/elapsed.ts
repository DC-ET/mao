/**
 * 执行中耗时的紧凑展示（对齐 desktop/src/utils/elapsed.ts）：
 * <1m 用秒，<1h 用 m/s（如 1m30s），否则折算小时；各档位一律向下取整。
 * 不足 1s 的值由调用方（ToolCallElapsed）门控不渲染。
 */
export function formatElapsedMs(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

/**
 * 任务耗时（轮次折叠条文案）：整分整秒口径，与桌面端 ChatRoundList「任务耗时」一致。
 * 起点用户消息发出、终点本轮最后一条消息的结束时刻，diff <= 0（缺时间戳/时钟回拨）返回空串。
 */
export function formatRoundDuration(startIso?: string, endIso?: string): string {
  if (!startIso || !endIso) return '';
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const diff = end - start;
  if (diff <= 0) return '';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
  return `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分钟`;
}
