/**
 * 运行窗口的成本与墙钟。轨迹面板和定时任务运行历史共用成本算法；
 * 墙钟函数保持原语义（空集返回 0），调用方自己决定送哪些采样点。
 */

export interface CostCall {
  costMicros?: number | null;
}

/** 墙钟采样点：结束时刻 + 本地计量的耗时。 */
export interface ClockPoint {
  createdAt: string | null;
  durationMs: number | null;
}

/** 空窗口或任一行 costMicros == null → null。 */
export function sumCostMicros(calls: CostCall[]): number | null {
  if (calls.length === 0) return null;
  let total = 0;
  for (const call of calls) {
    if (call.costMicros == null) return null;
    total += call.costMicros;
  }
  return total;
}

/** 秒级误差可接受；没有 duration 的点不参与；空集返回 0。 */
export function wallClockMs(points: ClockPoint[]): number {
  let minStart: number | null = null;
  let maxEnd: number | null = null;
  for (const point of points) {
    if (point.createdAt == null) continue;
    const end = toEpochMs(point.createdAt);
    if (end == null) continue;
    const start = end - Math.max(0, point.durationMs ?? 0);
    if (minStart == null || start < minStart) minStart = start;
    if (maxEnd == null || end > maxEnd) maxEnd = end;
  }
  if (minStart == null || maxEnd == null) return 0;
  return Math.max(0, maxEnd - minStart);
}

function toEpochMs(value: string): number | null {
  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : parsed;
}
