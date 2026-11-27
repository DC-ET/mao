import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let downloadedUrl = ''

function installAndroidGlobals() {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
    setItem: (key: string, value: string) => { storage.set(key, String(value)) },
    removeItem: (key: string) => { storage.delete(key) },
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() { return storage.size },
  })
  vi.stubGlobal('window', {
    location: {
      href: 'https://mao.example.com/tasks/1',
      protocol: 'https:',
      origin: 'https://mao.example.com',
      hostname: 'mao.example.com',
    },
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        AppUpdate: {
          getVersionCode: async () => ({ versionCode: 1 }),
          addListener: async () => ({ remove: async () => {} }),
          downloadAndInstall: async ({ url }: { url: string }) => { downloadedUrl = url },
        },
      },
    },
  })
}

beforeEach(() => {
  vi.resetModules()
  downloadedUrl = ''
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/api/v1')
  installAndroidGlobals()
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      versionCode: 2,
      versionName: '2.0.0',
      downloadUrl: '/uploads/releases/android-2.apk',
    }),
  })))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('安卓 OTA 同源解析', () => {
  it('split-domain 时清单与 downloadUrl 都跟随 SPA 站点，而不是 API 域', async () => {
    const { useVersionCheck } = await import('./useVersionCheck')
    const vc = useVersionCheck()
    try {
      vc.startAppUpdater()
      await vi.waitFor(() => expect(vc.appUpdateStatus.value).toBe('available'))

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('https://mao.example.com/uploads/releases/android-latest.json')
      )
      expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('api.example.com'))

      const result = await vc.installAppUpdate()
      expect(result.success).toBe(true)
      expect(downloadedUrl).toBe('https://mao.example.com/uploads/releases/android-2.apk')
    } finally {
      vc.stopAppUpdater()
    }
  })
})