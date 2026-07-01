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

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(getToken())
  const user = ref<User | null>(null)

  async function login(username: string, password: string) {
    const { data } = await api.post('/auth/login', { username, password })
    token.value = data.accessToken
    user.value = data.user
    await setTokens(data.accessToken, data.refreshToken)
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
    login,
    logout,
    fetchUserInfo
  }
})
