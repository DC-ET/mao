import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAGE_VERSION, resolveClientVersion } from './client-version'

const originalWindow = globalThis.window

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window
  } else {
    globalThis.window = originalWindow
  }
  vi.useRealTimers()
})

function setWindow(value: unknown) {
  Object.defineProperty(globalThis, 'window', { value, writable: true, configurable: true })
}

describe('resolveClientVersion', () => {
  it('reports the installed shell version on Electron', async () => {
    setWindow({ electronAPI: { getAppVersion: async () => ' 0.0.532 ' } })
    await expect(resolveClientVersion()).resolves.toBe('0.0.532')
  })

  it('falls back to the page build when the shell version is unavailable', async () => {
    setWindow({ electronAPI: { getAppVersion: async () => { throw new Error('ipc down') } } })
    await expect(resolveClientVersion()).resolves.toBe(PAGE_VERSION)
  })

  it('reports the APK version on Android', async () => {
    setWindow({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: { AppUpdate: { getVersionCode: async () => ({ versionName: '0.0.12' }) } },
      },
    })
    await expect(resolveClientVersion()).resolves.toBe('0.0.12')
  })

  it('falls back to the page build when the Android plugin does not answer', async () => {
    vi.useFakeTimers()
    setWindow({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: { AppUpdate: { getVersionCode: () => new Promise(() => {}) } },
      },
    })
    const pending = resolveClientVersion()
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toBe(PAGE_VERSION)
  })

  it('reports the page build in a browser', async () => {
    setWindow({})
    await expect(resolveClientVersion()).resolves.toBe(PAGE_VERSION)
  })
})
