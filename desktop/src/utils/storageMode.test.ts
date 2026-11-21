import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('../api', () => ({ api }))

/** getUploadConfig 以模块级变量做 60s 缓存；resetModules 保证每个用例拿到空缓存。 */
async function freshGetUploadConfig() {
  vi.resetModules()
  const mod = await import('./storageMode')
  return mod.getUploadConfig
}

describe('getUploadConfig（上传配置缓存与回落）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-21T03:25:45Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returnsConfigFromBackend', async () => {
    const getUploadConfig = await freshGetUploadConfig()
    api.get.mockResolvedValue({ data: { storageMode: 'cos', baseUrl: '', maxSizeMb: 50 } })
    expect(await getUploadConfig()).toEqual({ storageMode: 'cos', baseUrl: '', maxSizeMb: 50 })
    expect(api.get).toHaveBeenCalledWith('/upload/config')
  })

  it('fallsBackToLocalWhenConfigUnavailable', async () => {
    const getUploadConfig = await freshGetUploadConfig()
    api.get.mockRejectedValue(new Error('network down'))
    expect(await getUploadConfig()).toEqual({ storageMode: 'local', baseUrl: '', maxSizeMb: 1024 })
  })

  it('servesCacheWithinTtlAndRefetchesAfterTtl', async () => {
    const getUploadConfig = await freshGetUploadConfig()
    api.get.mockResolvedValue({ data: { storageMode: 'oss', baseUrl: '/uploads', maxSizeMb: 20 } })
    await getUploadConfig()
    await getUploadConfig()
    expect(api.get).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(61_000)
    await getUploadConfig()
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it('doesNotCacheFailedFetch', async () => {
    const getUploadConfig = await freshGetUploadConfig()
    api.get.mockRejectedValueOnce(new Error('boom'))
    expect(await getUploadConfig()).toEqual({ storageMode: 'local', baseUrl: '', maxSizeMb: 1024 })
    expect(await getUploadConfig()).toEqual({ storageMode: 'local', baseUrl: '', maxSizeMb: 1024 })
    expect(api.get).toHaveBeenCalledTimes(2)
  })
})
