import { ref, onScopeDispose } from 'vue'

const TICK_MS = 30_000

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
let refCount = 0

function startTicker() {
  if (timer != null) return
  timer = setInterval(() => {
    now.value = Date.now()
  }, TICK_MS)
}

function stopTicker() {
  if (timer != null) {
    clearInterval(timer)
    timer = null
  }
}

/** 订阅全局相对时间 ticker（30s）。渲染中调用 formatRelativeTime 会读取 now，从而随 ticker 刷新。 */
export function useRelativeTime() {
  refCount++
  startTicker()
  onScopeDispose(() => {
    refCount--
    if (refCount <= 0) stopTicker()
  })
  return now
}

/** 相对时间文案（刚刚 / X分 / X小时 / X天 / X月 / X年）。 */
export function formatRelativeTime(time?: string | number | Date | null): string {
  if (time == null || time === '') return ''
  const t = time instanceof Date ? time.getTime() : new Date(time).getTime()
  if (Number.isNaN(t)) return ''
  const diffMs = now.value - t
  if (diffMs < 0) return ''

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}月`
  const years = Math.floor(months / 12)
  return `${years}年`
}
