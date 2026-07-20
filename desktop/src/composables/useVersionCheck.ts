import { ref } from 'vue'

const STORAGE_KEY = 'app_version'
const CHECK_INTERVAL = 60_000
const APP_UPDATE_CHECK_INTERVAL = 60_000

const hasUpdate = ref(false)
const currentVersion = ref<string | null>(localStorage.getItem(STORAGE_KEY))
const newVersion = ref<string | null>(null)
const appUpdateStatus = ref<'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'unsupported'>('idle')
const appUpdateAvailable = ref(false)
const appUpdateDownloaded = ref(false)
const appUpdateVersion = ref<string | null>(null)
const appUpdateProgress = ref<number | null>(null)
const appUpdateError = ref<string | null>(null)

let timer: ReturnType<typeof setInterval> | null = null
let appUpdateTimer: ReturnType<typeof setInterval> | null = null
let appUpdaterStarted = false
let removeAppUpdaterListeners: Array<() => void> = []
/** 页面加载后首次检查只同步基线，不提示更新（此时资源已是当前运行版本） */
let baselineSynced = false

async function checkVersion() {
  try {
    const versionUrl = new URL(`${import.meta.env.BASE_URL}version.json`, window.location.href)
    versionUrl.searchParams.set('_t', String(Date.now()))
    const resp = await fetch(versionUrl)
    if (!resp.ok) return
    const data = await resp.json() as { version: string; buildTime: string }
    const remoteVersion = data.version

    if (!baselineSynced) {
      // 刚完成加载/刷新：以远程版本为基线，避免「已刷到新代码仍提示有更新」
      localStorage.setItem(STORAGE_KEY, remoteVersion)
      currentVersion.value = remoteVersion
      hasUpdate.value = false
      newVersion.value = null
      baselineSynced = true
      return
    }

    if (currentVersion.value && currentVersion.value !== remoteVersion) {
      hasUpdate.value = true
      newVersion.value = remoteVersion
    }

    localStorage.setItem(STORAGE_KEY, remoteVersion)
    currentVersion.value = remoteVersion
  } catch {
    // 网络不可用时静默忽略
  }
}

export function useVersionCheck() {
  function startPolling() {
    if (timer) return
    // 立即检查一次，然后定时轮询
    checkVersion()
    timer = setInterval(checkVersion, CHECK_INTERVAL)
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function reloadApp() {
    // file:// 打包环境使用 hash 路由，href='/' 会跳到文件系统根目录导致白屏
    if (window.location.protocol === 'file:') {
      const base = window.location.href.split('#')[0]
      window.location.replace(`${base}#/`)
      return
    }
    window.location.reload()
  }

  function getElectronAPI() {
    return typeof window !== 'undefined' ? window.electronAPI : undefined
  }

  function startAppUpdater() {
    if (appUpdaterStarted) return
    const electronAPI = getElectronAPI()
    if (!electronAPI?.checkForUpdate) {
      appUpdateStatus.value = 'unsupported'
      return
    }

    appUpdaterStarted = true
    removeAppUpdaterListeners = [
      electronAPI.onUpdateChecking?.(() => {
        appUpdateStatus.value = 'checking'
        appUpdateError.value = null
      }),
      electronAPI.onUpdateAvailable?.((info) => {
        appUpdateStatus.value = 'available'
        appUpdateAvailable.value = true
        appUpdateDownloaded.value = false
        appUpdateVersion.value = info?.version || null
        appUpdateProgress.value = 0
      }),
      electronAPI.onDownloadProgress?.((progress) => {
        appUpdateStatus.value = 'downloading'
        appUpdateProgress.value = Math.max(0, Math.min(100, progress?.percent || 0))
      }),
      electronAPI.onUpdateDownloaded?.((info) => {
        appUpdateStatus.value = 'downloaded'
        appUpdateAvailable.value = true
        appUpdateDownloaded.value = true
        appUpdateVersion.value = info?.version || appUpdateVersion.value
        appUpdateProgress.value = 100
      }),
      electronAPI.onUpdateNotAvailable?.(() => {
        if (!appUpdateAvailable.value) {
          appUpdateStatus.value = 'not-available'
        }
      }),
      electronAPI.onUpdateError?.((error) => {
        appUpdateStatus.value = 'error'
        appUpdateError.value = error?.message || '检查客户端更新失败'
      })
    ].filter(Boolean) as Array<() => void>

    void checkAppUpdate()
    appUpdateTimer = setInterval(() => {
      if (!appUpdateAvailable.value && !appUpdateDownloaded.value && appUpdateStatus.value !== 'downloading') {
        void checkAppUpdate()
      }
    }, APP_UPDATE_CHECK_INTERVAL)
  }

  function stopAppUpdater() {
    if (appUpdateTimer) {
      clearInterval(appUpdateTimer)
      appUpdateTimer = null
    }
    for (const removeListener of removeAppUpdaterListeners) {
      removeListener()
    }
    removeAppUpdaterListeners = []
    appUpdaterStarted = false
  }

  async function checkAppUpdate() {
    const electronAPI = getElectronAPI()
    if (!electronAPI?.checkForUpdate) {
      appUpdateStatus.value = 'unsupported'
      return
    }
    try {
      appUpdateStatus.value = 'checking'
      appUpdateError.value = null
      const result = await electronAPI.checkForUpdate()
      if (result?.skipped) {
        appUpdateStatus.value = 'unsupported'
        return
      }
      // Promise 成功返回时，若事件侧尚未推进状态（或并发检查把状态又写回 checking），
      // 显式落到完成态，避免 UI 一直显示「正在检查」。
      if (
        appUpdateStatus.value === 'checking' &&
        !appUpdateAvailable.value &&
        !appUpdateDownloaded.value
      ) {
        appUpdateStatus.value = 'not-available'
      }
    } catch (error) {
      appUpdateStatus.value = 'error'
      appUpdateError.value = error instanceof Error ? error.message : '检查客户端更新失败'
    }
  }

  async function installAppUpdate() {
    const electronAPI = getElectronAPI()
    if (!electronAPI?.installUpdate) return { success: false, error: '当前环境不支持客户端升级' }
    return electronAPI.installUpdate()
  }

  return {
    hasUpdate,
    currentVersion,
    newVersion,
    appUpdateStatus,
    appUpdateAvailable,
    appUpdateDownloaded,
    appUpdateVersion,
    appUpdateProgress,
    appUpdateError,
    startPolling,
    stopPolling,
    reloadApp,
    startAppUpdater,
    stopAppUpdater,
    checkAppUpdate,
    installAppUpdate
  }
}
