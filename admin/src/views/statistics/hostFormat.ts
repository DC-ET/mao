/** 主机状态页的展示换算。采集与口径在后端，这里只负责文案。 */

export function platformLabel(platform: string): string {
  if (platform === 'linux') return 'Linux'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  return platform || '—'
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  if (minutes > 0) return `${minutes} 分钟`
  return `${total} 秒`
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
}

export function formatLoad(load1: number, load5: number, load15: number): string {
  const text = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : '—')
  return `${text(load1)} / ${text(load5)} / ${text(load15)}`
}

export function usageLevel(percent: number | null | undefined): 'normal' | 'warm' | 'hot' {
  if (percent == null || !Number.isFinite(percent) || percent < 75) return 'normal'
  return percent >= 90 ? 'hot' : 'warm'
}

/** el-progress 的 color 回调。CSS 变量由组件库主题提供。 */
export function usageColor(percent: number): string {
  if (percent >= 90) return 'var(--el-color-danger)'
  if (percent >= 75) return 'var(--el-color-warning)'
  return 'var(--el-color-primary)'
}

export function memoryHint(source: 'proc' | 'os' | undefined): string {
  return source === 'proc' ? '可用含可回收缓存' : '未计入可回收缓存，占用率会偏高'
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export function formatDelay(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const rounded = Math.round(ms * 10) / 10
  return Number.isInteger(rounded) ? `${rounded} ms` : `${rounded.toFixed(1)} ms`
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function diskPlace(disk: { path: string; mount: string }): string {
  if (disk.path === disk.mount) return disk.mount
  return `${disk.path} · 挂载 ${disk.mount}`
}
