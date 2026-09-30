/**
 * localStorage 写操作统一兜底：存储被禁用（隐私模式）或配额满时
 * setItem/removeItem 会抛 SecurityError/QuotaExceededError，调用方不应因此崩溃，
 * 最多退化为「不持久化」。
 */
export function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 存储不可用时静默降级 */
  }
}

export function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 存储不可用时静默降级 */
  }
}
