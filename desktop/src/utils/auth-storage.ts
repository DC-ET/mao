import { safeRemoveItem, safeSetItem } from './safe-storage'

/**
 * Auth token storage.
 * Electron 环境（含 dev:electron 的 http://localhost）统一由主进程写入 userData/auth.json，
 * 不镜像进 localStorage（file:// 不持久化，dev 与 prod 加载协议不一致，且明文落 localStorage
 * 会扩大 token 暴露面）；浏览器环境 localStorage 是唯一存储。
 */
let tokenCache: string | null = null
let refreshTokenCache: string | null = null

function useElectronAuthStore(): boolean {
  return typeof window !== 'undefined'
    && !!window.electronAPI?.getAuthTokens
}

/** 仅浏览器环境写 localStorage；Electron 下 token 只存主进程。 */
function mirrorToLocalStorage() {
  if (useElectronAuthStore()) return
  if (tokenCache) {
    safeSetItem('token', tokenCache)
  } else {
    safeRemoveItem('token')
  }
  if (refreshTokenCache) {
    safeSetItem('refreshToken', refreshTokenCache)
  } else {
    safeRemoveItem('refreshToken')
  }
}

/** 历史版本曾把 token 镜像进 localStorage，Electron 下启动时清掉残留。 */
function removeLegacyLocalStorageTokens() {
  safeRemoveItem('token')
  safeRemoveItem('refreshToken')
}

export async function initAuthStorage(): Promise<void> {
  if (useElectronAuthStore()) {
    const stored = await window.electronAPI!.getAuthTokens()
    tokenCache = stored.token
    refreshTokenCache = stored.refreshToken
    removeLegacyLocalStorageTokens()
    return
  }

  tokenCache = localStorage.getItem('token')
  refreshTokenCache = localStorage.getItem('refreshToken')
}

export function getToken(): string | null {
  return tokenCache
}

export function getRefreshToken(): string | null {
  return refreshTokenCache
}

export async function setTokens(accessToken: string, refreshToken: string): Promise<void> {
  // 先写主进程（Electron 的权威存储），再镜像 localStorage（仅浏览器生效），
  // 避免镜像异常导致主流程失败
  if (useElectronAuthStore()) {
    await window.electronAPI!.setAuthTokens({ token: accessToken, refreshToken })
  }
  tokenCache = accessToken
  refreshTokenCache = refreshToken
  mirrorToLocalStorage()
}

export async function clearTokens(): Promise<void> {
  tokenCache = null
  refreshTokenCache = null
  mirrorToLocalStorage()

  if (useElectronAuthStore()) {
    await window.electronAPI!.clearAuthTokens()
  }
}
