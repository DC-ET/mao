import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'
import { useSessionStore } from './session'
import { useDraftStore } from './draft'
import { useStreamWS } from '../composables/useStreamWS'
import { useTerminalWS } from '../composables/useTerminalWS'
import { clearTokens, getToken, setTokens } from '../utils/auth-storage'
import { redirectToLogin } from '../utils/login-redirect'

interface User {
  id: number
  username: string
  displayName: string
  email: string
  avatarUrl: string
  authSource: 'LOCAL' | 'LDAP' | 'FEISHU' | string
  /** GET /users/me 返回；登录响应不含，需登录后补拉一次 */
  permissions?: string[]
  isAdmin?: boolean
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

  const permissions = computed(() => user.value?.permissions ?? [])
  const isAdmin = computed(() => Boolean(user.value?.isAdmin))

  function hasPermission(code: string): boolean {
    return permissions.value.includes(code)
  }

  /** 清掉本地会话状态（token、WS、会话与草稿）。不调用后端，供登出与 401 强制下线共用。 */
  async function clearLocalSession() {
    token.value = null
    user.value = null
    await clearTokens()
    useStreamWS().disconnect()
    useTerminalWS().disconnect()
    // 动态引入：useTerminal 依赖 api，静态引入会与 api → auth 形成模块环
    const { useTerminal } = await import('../composables/useTerminal')
    useTerminal().reset()
    useSessionStore().reset()
    useDraftStore().reset()
  }

  async function applyLogin(data: LoginResponse) {
    token.value = data.accessToken
    user.value = data.user
    await setTokens(data.accessToken, data.refreshToken)
    // 登录响应不含 permissions/isAdmin，进入应用前补拉完整档案（权限门禁依赖它）。
    // 失败不阻断登录：router 守卫会再补拉，缺 permissions 时按钮按不可用渲染
    await fetchUserInfo().catch(() => {})
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
    permissions,
    isAdmin,
    hasPermission,
    login,
    fetchAuthFeatures,
    startFeishuLogin,
    pollFeishuLogin,
    logout,
    clearLocalSession,
    fetchUserInfo
  }
})
