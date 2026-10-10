/** 汇总行 → 饼图切片的输入（按模型/按场景/按 Agent 三种行统一到此形态）。 */
export interface PieSourceRow {
  name: string
  callCount: number
  totalTokens: number
  /** 场景聚合不带成本，缺省时饼图不展示成本行 */
  cost?: number
}

export interface PieSlice {
  name: string
  /** 饼图数值：调用次数（分布口径） */
  value: number
  calls: number
  tokens: number
  cost?: number
}

/** 超过上限的尾部合并为这一片，避免模型/Agent 多了饼图碎成渣。 */
export const PIE_OTHER_LABEL = '其他'

/** 尾部合并默认保留的最大片数。 */
export const PIE_SLICE_LIMIT = 8

/**
 * 汇总行 → 饼图切片：按调用次数降序取前 limit 个，其余合并为「其他」。
 * 调用数为 0 的行不进饼图；全无数据时返回空数组（图表走空态）。
 */
export function buildPieSlices(rows: PieSourceRow[], limit: number = PIE_SLICE_LIMIT): PieSlice[] {
  const sorted = rows
    .filter((r) => r.callCount > 0)
    .sort((a, b) => b.callCount - a.callCount);
  const cap = Math.max(1, Math.trunc(limit));
  const head = sorted.slice(0, cap);
  const tail = sorted.slice(cap);
  const slices: PieSlice[] = head.map((r) => ({
    name: r.name,
    value: r.callCount,
    calls: r.callCount,
    tokens: r.totalTokens,
    cost: r.cost,
  }));
  if (tail.length > 0) {
    slices.push({
      name: PIE_OTHER_LABEL,
      value: tail.reduce((s, r) => s + r.callCount, 0),
      calls: tail.reduce((s, r) => s + r.callCount, 0),
      tokens: tail.reduce((s, r) => s + r.totalTokens, 0),
      // 只要有一行带成本就合计（场景聚合全行无成本 →  undefined，tooltip 不展示成本行）
      cost: tail.some((r) => r.cost != null) ? tail.reduce((s, r) => s + (r.cost ?? 0), 0) : undefined,
    });
  }
  return slices;
}
