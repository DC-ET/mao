import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'
import { invalidateAnalytics } from '../views/analytics/composables/useScopeQuery'

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
    // skipErrorToast：登录页 catch 自行提示，拦截器再弹会双重提示
    const { data } = await api.post('/auth/admin/login', { username, password }, { skipErrorToast: true })
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
      // 登出是 router.push 不刷新页面，模块级缓存（用量分析 TTL 5 分钟）不按账号隔离，
      // 不清掉会让下一账号看到上一账号的数据
      invalidateAnalytics()
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
    invalidateAnalytics()
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
