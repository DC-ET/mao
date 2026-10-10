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

/** 计数紧凑单位：万/亿，避免统计卡片与坐标轴被长数字撑开（口径同管理后台）。 */
export function formatCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${trimZero(value / 1e8)} 亿`
  if (abs >= 1e4) return `${trimZero(value / 1e4)} 万`
  return String(value)
}

/** 缓存命中：命中数（占入 token 百分比）；无命中或无入 token 时只显示数字。 */
export function formatCacheHit(row: { cachedTokens?: number | null; promptTokens?: number | null }): string {
  const cached = row.cachedTokens || 0
  const prompt = row.promptTokens || 0
  if (cached <= 0) return '0'
  const num = formatNumber(cached)
  if (prompt <= 0) return num
  return `${num} (${Math.round((cached / prompt) * 100)}%)`
}

/** 百分比；分母为 0 时返回「-」，不显示 0% 误导。 */
export function formatPercent(part: number, total: number): string {
  if (total <= 0) return '-'
  return `${Math.round((part / total) * 100)}%`
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}
