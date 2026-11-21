import type { StorageMode } from '@mao/contracts'
import { api } from '../api'

export interface UploadConfig {
  storageMode: StorageMode
  baseUrl: string
  maxSizeMb: number
}

const CACHE_TTL_MS = 60_000
let cachedConfig: UploadConfig | null = null
let cachedAt = 0

/**
 * Fetch upload configuration from backend.
 * Cached briefly (60s) so admin-side changes take effect without app restart,
 * while avoiding a round trip on every upload.
 */
export async function getUploadConfig(): Promise<UploadConfig> {
  if (cachedConfig && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedConfig
  }
  try {
    const { data } = await api.get('/upload/config')
    cachedConfig = data as UploadConfig
    cachedAt = Date.now()
    return cachedConfig!
  } catch {
    // 取不到配置时回落本地磁盘：后端不可达时对象存储票据必然也拿不到
    return { storageMode: 'local', baseUrl: '', maxSizeMb: 1024 }
  }
}
