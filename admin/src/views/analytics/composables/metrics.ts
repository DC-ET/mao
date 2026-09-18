export function delta(current: number, previous: number | undefined): number | null {
  if (previous == null || previous === 0) return current > 0 ? null : 0
  return Math.round(((current - previous) / previous) * 100)
}

export function deltaText(value: number | null): string {
  if (value === null) return ''
  if (value === 0) return '持平'
  return `${value > 0 ? '↑' : '↓'} ${Math.abs(value)}%`
}

/** 项目约定：绿=变好、红=变差；token/失败率等 inverse 指标下降才算好。 */
export function deltaClass(value: number | null, inverse = false): 'good' | 'bad' | 'flat' {
  if (value === null || value === 0) return 'flat'
  const good = inverse ? value < 0 : value > 0
  return good ? 'good' : 'bad'
}

export function percent(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((part / total) * 1000) / 10
}
