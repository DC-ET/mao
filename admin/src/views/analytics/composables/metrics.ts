/** 上期为 0 且本期有值时返回 Infinity（无法计算百分比），展示层显示「新增」标记。 */
export function delta(current: number, previous: number | undefined): number | null {
  if (previous == null) return current > 0 ? null : 0
  if (previous === 0) return current > 0 ? Infinity : 0
  return Math.round(((current - previous) / previous) * 100)
}

export function deltaText(value: number | null, unit: '%' | 'pp' = '%'): string {
  if (value === null) return ''
  if (value === Infinity) return '新增'
  if (value === 0) return '持平'
  return `${value > 0 ? '↑' : '↓'} ${Math.abs(value)}${unit}`
}

/** 展示口径统一：上升=红、下降=绿（只表示方向，不区分指标好坏）。 */
export function deltaClass(value: number | null): 'up' | 'down' | 'flat' {
  if (value === null || value === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}

/** 比率类指标（命中率等）的环比按百分点差：30% → 35% 是 ↑ 5pp，不是 ↑ 17%。任一端无值返回 null。 */
export function ppDelta(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current == null || previous == null) return null
  return Math.round((current - previous) * 10) / 10
}

export function percent(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((part / total) * 1000) / 10
}
