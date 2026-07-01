/**
 * Auth token storage.
 * Electron 打包后从 file:// 加载，localStorage 重启后不持久化，改由主进程写入 userData。
 */
let tokenCache: string | null = null
let refreshTokenCache: string | null = null

function useElectronAuthStore(): boolean {
  return typeof window !== 'undefined'
    && window.location.protocol === 'file:'
    && !!window.electronAPI?.getAuthTokens
}

function mirrorToLocalStorage() {
  if (tokenCache) {
    localStorage.setItem('token', tokenCache)
  } else {
    localStorage.removeItem('token')
  }
  if (refreshTokenCache) {
    localStorage.setItem('refreshToken', refreshTokenCache)
  } else {
    localStorage.removeItem('refreshToken')
  }
}

export async function initAuthStorage(): Promise<void> {
  if (useElectronAuthStore()) {
    const stored = await window.electronAPI!.getAuthTokens()
    tokenCache = stored.token
    refreshTokenCache = stored.refreshToken
    mirrorToLocalStorage()
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
  tokenCache = accessToken
  refreshTokenCache = refreshToken
  mirrorToLocalStorage()

  if (useElectronAuthStore()) {
    await window.electronAPI!.setAuthTokens({ token: accessToken, refreshToken })
  }
}

export async function clearTokens(): Promise<void> {
  tokenCache = null
  refreshTokenCache = null
  mirrorToLocalStorage()

  if (useElectronAuthStore()) {
    await window.electronAPI!.clearAuthTokens()
  }
}
