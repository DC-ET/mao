import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAndroidServerConfigPlugin } from './android-server-config'

function stubCapacitor(platform: string, plugin?: unknown) {
  vi.stubGlobal('window', {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => platform,
      Plugins: plugin ? { ServerConfig: plugin } : {},
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getAndroidServerConfigPlugin', () => {
  it('非安卓环境返回 null', () => {
    expect(getAndroidServerConfigPlugin()).toBeNull()
    stubCapacitor('ios', { get: vi.fn(), openPicker: vi.fn() })
    expect(getAndroidServerConfigPlugin()).toBeNull()
  })

  it('老安卓壳没有插件时返回 null', () => {
    stubCapacitor('android')
    expect(getAndroidServerConfigPlugin()).toBeNull()
  })

  it('新安卓壳透传 get / openPicker', async () => {
    const plugin = {
      get: vi.fn(async () => ({ serverBaseUrl: 'https://mao.example.com', allowHttp: false })),
      openPicker: vi.fn(async () => ({ changed: true })),
    }
    stubCapacitor('android', plugin)
    const resolved = getAndroidServerConfigPlugin()
    expect(resolved).toBe(plugin)
    await expect(resolved?.get()).resolves.toEqual({ serverBaseUrl: 'https://mao.example.com', allowHttp: false })
    await expect(resolved?.openPicker()).resolves.toEqual({ changed: true })
  })
})