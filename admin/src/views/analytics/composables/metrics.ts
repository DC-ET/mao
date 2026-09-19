/** 上期为 0 且本期有值时返回 Infinity（无法计算百分比），展示层显示「新增」标记。 */
export function delta(current: number, previous: number | undefined): number | null {
  if (previous == null) return current > 0 ? null : 0
  if (previous === 0) return current > 0 ? Infinity : 0
  return Math.round(((current - previous) / previous) * 100)
}

export function deltaText(value: number | null): string {
  if (value === null) return ''
  if (value === Infinity) return '新增'
  if (value === 0) return '持平'
  return `${value > 0 ? '↑' : '↓'} ${Math.abs(value)}%`
}

/** 展示口径统一：上升=红、下降=绿（只表示方向，不区分指标好坏）。 */
export function deltaClass(value: number | null): 'up' | 'down' | 'flat' {
  if (value === null || value === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}

export function percent(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((part / total) * 1000) / 10
}
