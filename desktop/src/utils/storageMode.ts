import { api } from '../api'

export interface UploadConfig {
  storageMode: 'oss' | 'local'
  baseUrl: string
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
    // Default to OSS if config endpoint fails
    return { storageMode: 'oss', baseUrl: '' }
  }
}
