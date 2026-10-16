/** 千分位整数（token 计数等）。 */
export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat('zh-CN').format(value ?? 0)
}

/**
 * 成本展示：与模型价格填写单位一致，最多保留 3 位小数（小金额不丢精度）；
 * null/非法值显示「-」。口径同管理后台用量分析。
 */
export function formatCost(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const abs = Math.abs(value)
  if (abs >= 10000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
  if (abs >= 1000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

/** Token 紧凑单位表（1000 进制，从大到小）。 */
const TOKEN_UNITS: Array<{ divisor: number; label: string }> = [
  { divisor: 1e12, label: 'T' },
  { divisor: 1e9, label: 'B' },
  { divisor: 1e6, label: 'M' },
  { divisor: 1e3, label: 'K' },
]

export interface TokenUnit {
  divisor: number
  label: string
}

/** 数值适配的紧凑单位；小于 1000 返回 null（原样展示整数）。 */
export function pickTokenUnit(value: number): TokenUnit | null {
  const abs = Math.abs(value)
  for (let i = 0; i < TOKEN_UNITS.length; i++) {
    if (abs >= TOKEN_UNITS[i].divisor) {
      // 贴近上级单位上限时进位（999.95K → 1M），读数不出现 1000K 这种跨档数字
      if (i > 0 && abs / TOKEN_UNITS[i].divisor >= 999.95) return TOKEN_UNITS[i - 1]
      return TOKEN_UNITS[i]
    }
  }
  return null
}

/** token 紧凑展示：667577705 → 667.58M；小于 1000 原样；null/非法值按 0。 */
export function formatToken(value: number | null | undefined): string {
  const v = value ?? 0
  if (!Number.isFinite(v)) return '0'
  return formatTokenWithUnit(v, pickTokenUnit(v))
}

/** 按指定单位折算（趋势纵轴整轴统一单位用）；无单位时原样取整。 */
export function formatTokenWithUnit(value: number, unit: TokenUnit | null): string {
  if (!unit) return String(Math.round(value))
  if (value === 0) return '0'
  return `${(value / unit.divisor).toFixed(2)}${unit.label}`
}

/** 缓存命中：命中数（占入 token 百分比）；无命中或无入 token 时只显示数字。 */
export function formatCacheHit(row: { cachedTokens?: number | null; promptTokens?: number | null }): string {
  const cached = row.cachedTokens || 0
  const prompt = row.promptTokens || 0
  if (cached <= 0) return '0'
  const num = formatToken(cached)
  if (prompt <= 0) return num
  return `${num} (${Math.round((cached / prompt) * 100)}%)`
}

/** 百分比；分母为 0 时返回「-」，不显示 0% 误导。 */
export function formatPercent(part: number, total: number): string {
  if (total <= 0) return '-'
  return `${Math.round((part / total) * 100)}%`
}

/**
 * 占比展示（饼图图例 / 标签 / tooltip 用）：小于 1% 显示「<1%」，小于 10% 保留 1 位小数，
 * 其余取整——细片的 0.4% 不会被四舍五入成 0%，也不拖着 4 位小数。
 */
export function formatPercentValue(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return '0%'
  if (percent < 1) return '<1%'
  // 贴近 10% 时进位（9.96 → 10%），读数不出现 10.0% 这种跨档数字
  if (percent < 9.95) return `${percent.toFixed(1)}%`
  return `${Math.round(percent)}%`
}
