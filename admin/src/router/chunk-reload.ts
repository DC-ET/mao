/** 记录上一次因旧脚本 404 而整页跳转的时间，避免新版本仍缺文件时来回刷新。 */
export const CHUNK_RELOAD_STAMP_KEY = 'mao_admin_chunk_reload_at'

/** 两次自动跳转的最短间隔。 */
export const CHUNK_RELOAD_WINDOW_MS = 10_000

const STALE_CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i

export interface ChunkReloadStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

/** 懒加载的页面脚本或样式在部署后已被删掉。 */
export function isStaleChunkError(error: unknown): boolean {
  return STALE_CHUNK_ERROR.test(errorText(error))
}

/**
 * 旧标签点到尚未加载的菜单时，返回应整页打开的地址。
 * 非脚本缺失、没有目标地址、或距上次自动跳转过近时返回 null。
 */
export function chunkReloadTarget(
  error: unknown,
  href: string,
  storage: ChunkReloadStorage | null,
  now = Date.now(),
): string | null {
  if (!isStaleChunkError(error) || !href || !storage) return null
  let last: number | null = null
  try {
    const raw = storage.getItem(CHUNK_RELOAD_STAMP_KEY)
    if (raw) {
      const parsed = Number(raw)
      last = Number.isFinite(parsed) ? parsed : null
    }
  } catch {
    return null
  }
  if (last != null && now - last < CHUNK_RELOAD_WINDOW_MS) return null
  try {
    storage.setItem(CHUNK_RELOAD_STAMP_KEY, String(now))
  } catch {
    return null
  }
  return href
}
