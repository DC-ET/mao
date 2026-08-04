import { ref } from 'vue'

const STORAGE_KEY = 'app_version'
const CHECK_INTERVAL = 60_000
const APP_UPDATE_CHECK_INTERVAL = 60_000

/* ---- 安卓 OTA 相关常量 ---- */
// Capacitor WebView 中 BASE_URL 指向本地资产，需用完整 URL 访问服务端
const _apiBase = import.meta.env.VITE_API_BASE_URL || ''  // e.g. https://mao.etarch.cn/api/v1
const ANDROID_MANIFEST_URL = _apiBase ? _apiBase.replace(/\/api\/v1\/?$/, '/uploads/releases/android-latest.json') : '/uploads/releases/android-latest.json'
const IGNORED_VERSION_KEY = 'mao_android_ignored_version_code'

/* ---- Capacitor 环境检测（不依赖 @capacitor/core npm 包，直接读运行时注入） ---- */
function isAndroidCapacitor(): boolean {
  try {
    // @ts-ignore Capacitor 7 运行时注入
    return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.() && window.Capacitor.getPlatform?.() === 'android'
  } catch {
    return false
  }
}

// @ts-ignore
function getAndroidPlugin(): any {
  try {
    // @ts-ignore
    return window.Capacitor?.Plugins?.AppUpdate ?? null
  } catch {
    return null
  }
}

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
      window.location.replace(`${base}#/?_t=${Date.now()}`)
      return
    }
    // Capacitor 相对 base(./) + 深路径 History URL 时，location.reload() 会使
    // ./assets、./app-icon-small.png 解析到错误目录 → JS 不加载、图标裂图、卡 splash。
    // 强制从应用根路径重新进入（配合 hash 路由）。
    if (isAndroidCapacitor()) {
      window.location.replace(`${window.location.origin}/index.html?_t=${Date.now()}#/`)
      return
    }
    window.location.reload()
  }

  function getElectronAPI() {
    return typeof window !== 'undefined' ? window.electronAPI : undefined
  }

  function startAppUpdater() {
    if (appUpdaterStarted) return

    /* ---- Android（Capacitor）路径 ---- */
    if (isAndroidCapacitor() && getAndroidPlugin()) {
      appUpdaterStarted = true
      void checkAndroidUpdate()
      appUpdateTimer = setInterval(() => {
        if (!appUpdateAvailable.value && !appUpdateDownloaded.value && appUpdateStatus.value !== 'downloading') {
          void checkAndroidUpdate()
        }
      }, APP_UPDATE_CHECK_INTERVAL)
      return
    }

    /* ---- Electron 路径 ---- */
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
    /* ---- Android 路径 ---- */
    if (isAndroidCapacitor() && getAndroidPlugin()) {
      return checkAndroidUpdate()
    }

    /* ---- Electron 路径 ---- */
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

  /** 安卓：拉取 android-latest.json 比对 versionCode */
  async function checkAndroidUpdate() {
    try {
      appUpdateStatus.value = 'checking'
      appUpdateError.value = null
      const plugin = getAndroidPlugin()
      if (!plugin) { appUpdateStatus.value = 'unsupported'; return }

      // 获取当前版本
      const current = await plugin.getVersionCode()
      const currentVersionCode: number = current?.versionCode ?? 0

      // 拉取清单
      const url = ANDROID_MANIFEST_URL + (ANDROID_MANIFEST_URL.includes('?') ? '&' : '?') + '_t=' + Date.now()
      const resp = await fetch(url)
      if (!resp.ok) { appUpdateStatus.value = 'not-available'; return }
      const manifest = await resp.json() as {
        versionCode: number
        versionName: string
        downloadUrl: string
        minVersionCode?: number
        changelog?: string
      }

      if (!manifest.versionCode || !manifest.downloadUrl) {
        appUpdateStatus.value = 'not-available'
        return
      }

      if (manifest.versionCode <= currentVersionCode) {
        appUpdateStatus.value = 'not-available'
        return
      }

      // 是否被用户忽略
      const ignored = Number(localStorage.getItem(IGNORED_VERSION_KEY) || 0)
      if (manifest.versionCode === ignored && (manifest.minVersionCode ?? 0) <= currentVersionCode) {
        appUpdateStatus.value = 'not-available'
        return
      }

      // 有更新：先写入全部元数据与状态，再置 appUpdateAvailable 触发 UI watch。
      // 注意：如果先置 appUpdateAvailable，TopNav 的 watch 触发时状态仍可能是 checking，导致弹窗不出现。
      const isForced = (manifest.minVersionCode ?? 0) > currentVersionCode
      _androidDownloadUrl = manifest.downloadUrl
      _androidIsForced = isForced
      _androidManifestVersionCode = manifest.versionCode
      appUpdateVersion.value = manifest.versionName || String(manifest.versionCode)
      appUpdateProgress.value = null
      appUpdateStatus.value = 'available'
      appUpdateAvailable.value = true
    } catch (error) {
      appUpdateStatus.value = 'error'
      appUpdateError.value = error instanceof Error ? error.message : '检查安卓更新失败'
    }
  }

  /** 安卓下载 URL 等缓存（模块内单例） */
  let _androidDownloadUrl = ''
  let _androidIsForced = false
  let _androidManifestVersionCode = 0

  /** 安卓：下载 APK 并拉起系统安装器 */
  async function androidInstallUpdate(downloadUrl?: string) {
    const url = downloadUrl || _androidDownloadUrl
    const plugin = getAndroidPlugin()
    if (!plugin || !url) return { success: false, error: '当前环境不支持客户端升级' }

    // 监听下载进度
    const listener = plugin.addListener?.('downloadProgress', (data: { percent?: number }) => {
      appUpdateStatus.value = 'downloading'
      appUpdateProgress.value = data?.percent ?? null
    })

    try {
      appUpdateStatus.value = 'downloading'
      appUpdateProgress.value = 0
      await plugin.downloadAndInstall({ url })
      appUpdateStatus.value = 'downloaded'
      appUpdateDownloaded.value = true
      appUpdateProgress.value = 100
      return { success: true }
    } catch (err: any) {
      const msg = String(err?.message || err || '')
      // 需要用户授权"安装未知来源"，引导到设置页
      if (msg.includes('INSTALL_PERMISSION_REQUIRED') || err?.code === 'INSTALL_PERMISSION_REQUIRED') {
        appUpdateStatus.value = 'available'
        appUpdateError.value = null
        try { await plugin.openInstallSettings?.() } catch {}
        return { success: false, error: 'need-permission' }
      }
      appUpdateStatus.value = 'error'
      appUpdateError.value = msg || '下载安装失败'
      return { success: false, error: msg }
    } finally {
      listener?.remove?.()
    }
  }

  function ignoreAndroidUpdate() {
    if (_androidManifestVersionCode) {
      localStorage.setItem(IGNORED_VERSION_KEY, String(_androidManifestVersionCode))
    }
    appUpdateAvailable.value = false
    appUpdateStatus.value = 'not-available'
  }

  function isAndroidForcedUpdate() {
    return isAndroidCapacitor() && _androidIsForced && appUpdateAvailable.value
  }

  async function installAppUpdate() {
    /* ---- Android 路径 ---- */
    if (isAndroidCapacitor() && getAndroidPlugin()) {
      return androidInstallUpdate()
    }

    /* ---- Electron 路径 ---- */
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
    installAppUpdate,
    // 安卓 OTA 专属（Electron / Web 环境下调用无副作用）
    ignoreAndroidUpdate,
    isAndroidForcedUpdate,
    isAndroidCapacitor
  }
}
