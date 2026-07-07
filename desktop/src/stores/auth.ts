import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'
import { useSessionStore } from './session'
import { useStreamWS } from '../composables/useStreamWS'
import { clearTokens, getToken, setTokens } from '../utils/auth-storage'

interface User {
  id: number
  username: string
  displayName: string
  email: string
  avatarUrl: string
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

  async function logout() {
    try {
      await api.post('/auth/logout')
    } finally {
      token.value = null
      user.value = null
      await clearTokens()
      useStreamWS().disconnect()
      useSessionStore().reset()
    }
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
    fetchUserInfo
  }
})
