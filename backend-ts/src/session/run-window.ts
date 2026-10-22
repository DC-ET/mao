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

/**
 * 「结束时刻 − duration」的估算起点（epoch ms）；任一侧缺失或解析失败为 null。
 *
 * 时间概览条带与下钻定位共用同一估算口径：VO 层不许补 0、不许用 createdAt 冒充起点
 * （秒级 created_at 下是估算值，必须与事实区分）。wallClockMs 的「durationMs 缺失按
 * 瞬时点参与」是墙钟自己的兜底语义，不走这里——两者不一致会让色条画出墙钟右边界。
 */
export function estimatedStartMs(createdAt: string | null | undefined, durationMs: number | null | undefined): number | null {
  if (createdAt == null || durationMs == null) return null;
  const end = toEpochMs(createdAt);
  if (end == null) return null;
  return end - Math.max(0, durationMs);
}

/** 秒级误差可接受；没有 duration 的点不参与；空集返回 0。 */
export function wallClockMs(points: ClockPoint[]): number {
  let minStart: number | null = null;
  let maxEnd: number | null = null;
  for (const point of points) {
    if (point.createdAt == null) continue;
    const end = toEpochMs(point.createdAt);
    if (end == null) continue;
    // durationMs 缺失（历史活动行）按瞬时点参与墙钟：起点即结束时刻。
    // estimatedStartMs 要求两侧非空（VO 口径），这里显式兜底，保持既有墙钟行为不变。
    const start = point.durationMs == null ? end : estimatedStartMs(point.createdAt, point.durationMs)!;
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
