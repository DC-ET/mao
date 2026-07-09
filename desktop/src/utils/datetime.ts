/** 解析多种时间字符串为 Date（兼容 ISO、空格分隔、斜杠分隔） */
export function parseDateTime(value?: string | Date | number | null): Date | null {
  if (value == null || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }

  const trimmed = value.trim()
  // yyyy-MM-dd HH:mm:ss → ISO-like，避免 Safari 解析失败
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)
    ? trimmed.replace(' ', 'T')
    : trimmed
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 将时间统一格式化为 yyyy-MM-dd HH:mm:ss */
export function formatDateTime(value?: string | Date | number | null): string {
  if (value == null || value === '') return ''
  const date = parseDateTime(value)
  if (!date) return String(value)

  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`
}

/** 当前本地时间，格式 yyyy-MM-dd HH:mm:ss */
export function nowDateTime(): string {
  return formatDateTime(new Date())
}
