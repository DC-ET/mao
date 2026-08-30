import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'

interface User {
  id: number
  username: string
  displayName: string
  email: string
  avatarUrl: string
  permissions?: string[]
  isAdmin?: boolean
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'))
  const user = ref<User | null>(null)

  const permissions = computed(() => user.value?.permissions || [])

  const isAdmin = computed(() => Boolean(user.value?.isAdmin))

  function hasPermission(code: string): boolean {
    return permissions.value.includes(code)
  }

  async function login(username: string, password: string) {
    const { data } = await api.post('/auth/login', { username, password })
    token.value = data.accessToken
    localStorage.setItem('token', data.accessToken)
    localStorage.setItem('refreshToken', data.refreshToken)
    // Load full profile (incl. permissions) before entering the app.
    await fetchUserInfo()
  }

  async function logout() {
    try {
      await api.post('/auth/logout')
    } finally {
      token.value = null
      user.value = null
      localStorage.removeItem('token')
      localStorage.removeItem('refreshToken')
    }
  }

  async function fetchUserInfo() {
    if (!token.value) return
    const { data } = await api.get('/users/me')
    user.value = data
  }

  /** 清理本地登录态（token 失效时使用，不调用服务端） */
  function clearAuth() {
    token.value = null
    user.value = null
    localStorage.removeItem('token')
    localStorage.removeItem('refreshToken')
  }

  return {
    token,
    user,
    permissions,
    isAdmin,
    hasPermission,
    login,
    logout,
    fetchUserInfo,
    clearAuth
  }
})
