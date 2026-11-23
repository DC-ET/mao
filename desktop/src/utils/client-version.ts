import pkg from '../../package.json'
import { isAndroidCapacitor } from './capacitor'
import { isElectronClient } from './platform'

/** 当前页面构建版本（desktop/package.json）。浏览器直接上报这个；壳读不到版本时也退回它。 */
export const PAGE_VERSION = typeof pkg.version === 'string' ? pkg.version : ''

const VERSION_LOOKUP_MS = 1_000

interface AndroidVersionInfo {
  versionName?: string
}

interface AndroidUpdatePlugin {
  getVersionCode?: () => Promise<AndroidVersionInfo>
}

function pageVersion(): string | undefined {
  const version = PAGE_VERSION.trim()
  return version || undefined
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * 连上 WS 时自报的客户端版本。
 * 桌面优先用已安装的壳版本（与更新检查同一份），安卓优先用 APK versionName，
 * 浏览器以及壳版本读不到时用当前页面的构建版本。
 */
export async function resolveClientVersion(): Promise<string | undefined> {
  if (isElectronClient()) {
    try {
      const reported = await withTimeout(
        Promise.resolve(window.electronAPI?.getAppVersion?.() ?? ''),
        VERSION_LOOKUP_MS,
      )
      const version = typeof reported === 'string' ? reported.trim() : ''
      if (version) return version
    } catch {
      // 壳版本读不到时退回页面版本，避免拖住鉴权首帧
    }
    return pageVersion()
  }
  if (isAndroidCapacitor()) {
    try {
      const plugin = (window as { Capacitor?: { Plugins?: { AppUpdate?: AndroidUpdatePlugin } } }).Capacitor
        ?.Plugins?.AppUpdate
      const info = await withTimeout(
        Promise.resolve(plugin?.getVersionCode?.() ?? null),
        VERSION_LOOKUP_MS,
      )
      const version = typeof info?.versionName === 'string' ? info.versionName.trim() : ''
      if (version) return version
    } catch {
      // 插件不可用或超时：退回页面版本
    }
  }
  return pageVersion()
}

/** 浏览器同步上报用：没有壳可问，版本就是当前页面构建版本。 */
export function currentPageVersion(): string | undefined {
  return pageVersion()
}
