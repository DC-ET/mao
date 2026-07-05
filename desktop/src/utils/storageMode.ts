import { api } from '../api'

export interface UploadConfig {
  storageMode: 'oss' | 'local'
  baseUrl: string
}

let cachedConfig: UploadConfig | null = null

/**
 * Fetch upload configuration from backend.
 * Result is cached for the lifetime of the application.
 */
export async function getUploadConfig(): Promise<UploadConfig> {
  if (cachedConfig) {
    return cachedConfig
  }
  try {
    const { data } = await api.get('/upload/config')
    cachedConfig = data as UploadConfig
    return cachedConfig!
  } catch {
    // Default to OSS if config endpoint fails
    return { storageMode: 'oss', baseUrl: '' }
  }
}
