const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
})

/** 与后端一致：无时区日期时间按北京时间解释，带时区时间转换为北京时间。 */
export function formatDateTime(value: unknown): string {
  if (value == null || value === '') return '-'
  if (typeof value !== 'string') return '无效时间'

  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match) return '无效时间'
  // 用户/会话 VO 使用 LocalDateTime 表示法，零秒可能省略。
  const [, year, month, day, hour, minute, second = '00', fraction, zone] = match
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return '无效时间'

  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction?.slice(0, 4) || ''}${zone || '+08:00'}`)
  if (Number.isNaN(date.getTime())) return '无效时间'
  const parts = dateTimeFormatter.formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

/** Element Plus 表格 formatter 的第三个参数是单元格原始值。 */
export function formatDateTimeColumn(_row: unknown, _column: unknown, value: unknown): string {
  return formatDateTime(value)
}
