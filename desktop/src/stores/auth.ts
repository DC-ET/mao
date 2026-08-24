import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'
import { useSessionStore } from './session'
import { useDraftStore } from './draft'
import { useStreamWS } from '../composables/useStreamWS'
import { clearTokens, getToken, setTokens } from '../utils/auth-storage'
import { redirectToLogin } from '../utils/login-redirect'

interface User {
  id: number
  username: string
  displayName: string
  email: string
  avatarUrl: string
  authSource: 'LOCAL' | 'LDAP' | 'FEISHU' | string
}

interface LoginResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: User
}

export interface FeishuQrCode {
  authUrl: string
  qrCodeUrl: string
  state: string
  expiresIn: number
  pollInterval: number
}

export interface FeishuLoginStatus {
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED'
  message?: string
  login?: LoginResponse
}

export interface AuthFeatures {
  feishuEnabled: boolean
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(getToken())
  const user = ref<User | null>(null)
  const features = ref<AuthFeatures>({ feishuEnabled: false })

  /** 清掉本地会话状态（token、WS、会话与草稿）。不调用后端，供登出与 401 强制下线共用。 */
  async function clearLocalSession() {
    token.value = null
    user.value = null
    await clearTokens()
    useStreamWS().disconnect()
    useSessionStore().reset()
    useDraftStore().reset()
  }

  async function applyLogin(data: LoginResponse) {
    token.value = data.accessToken
    user.value = data.user
    await setTokens(data.accessToken, data.refreshToken)
  }

  async function login(username: string, password: string) {
    const { data } = await api.post('/auth/login', { username, password })
    await applyLogin(data)
  }

  async function startFeishuLogin(): Promise<FeishuQrCode> {
    const { data } = await api.get('/auth/feishu/qrcode')
    return data
  }

  async function fetchAuthFeatures() {
    const { data } = await api.get('/auth/features')
    features.value = {
      feishuEnabled: Boolean(data?.feishuEnabled)
    }
    return features.value
  }

  async function pollFeishuLogin(state: string): Promise<FeishuLoginStatus> {
    const { data } = await api.get('/auth/feishu/status', { params: { state } })
    if (data.status === 'SUCCESS' && data.login) {
      await applyLogin(data.login)
    }
    return data
  }

  /** 登出：尽量通知后端，然后清本地会话并回登录页（不带 redirect）。 */
  async function logout() {
    try {
      await api.post('/auth/logout')
    } finally {
      await clearLocalSession()
    }
    // 动态引入 router：避免模块加载期创建路由，破坏 Node 环境单测
    const { default: router } = await import('../router')
    // 不带 redirect：登出后回跳到需登录页没有意义
    redirectToLogin(router, '/')
  }

  async function fetchUserInfo() {
    if (!token.value) return
    const { data } = await api.get('/users/me')
    user.value = data
  }

  return {
    token,
    user,
    features,
    login,
    fetchAuthFeatures,
    startFeishuLogin,
    pollFeishuLogin,
    logout,
    clearLocalSession,
    fetchUserInfo
  }
})
