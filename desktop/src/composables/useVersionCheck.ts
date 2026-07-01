import { ref } from 'vue'

const STORAGE_KEY = 'app_version'
const CHECK_INTERVAL = 60_000

const hasUpdate = ref(false)
const currentVersion = ref<string | null>(localStorage.getItem(STORAGE_KEY))
const newVersion = ref<string | null>(null)

let timer: ReturnType<typeof setInterval> | null = null

async function checkVersion() {
  try {
    const resp = await fetch(`/version.json?_t=${Date.now()}`)
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
    window.location.href = '/'
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
