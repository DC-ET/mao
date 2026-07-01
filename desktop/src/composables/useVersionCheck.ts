import { ref } from 'vue'

const STORAGE_KEY = 'app_version'
const CHECK_INTERVAL = 60_000

const hasUpdate = ref(false)
const currentVersion = ref<string | null>(localStorage.getItem(STORAGE_KEY))
const newVersion = ref<string | null>(null)

let timer: ReturnType<typeof setInterval> | null = null

async function checkVersion() {
  try {
    const versionUrl = new URL(`${import.meta.env.BASE_URL}version.json`, window.location.href)
    versionUrl.searchParams.set('_t', String(Date.now()))
    const resp = await fetch(versionUrl)
    if (!resp.ok) return
    const data = await resp.json() as { version: string; buildTime: string }
    const remoteVersion = data.version

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

  return {
    hasUpdate,
    currentVersion,
    newVersion,
    startPolling,
    stopPolling,
    reloadApp
  }
}
