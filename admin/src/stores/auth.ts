import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

interface User {
  id: number
  username: string
  displayName: string
  email: string
  avatarUrl: string
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'))
  const user = ref<User | null>(null)

  async function login(username: string, password: string, authType: string = 'LDAP') {
    const { data } = await api.post('/auth/login', { username, password, authType })
    token.value = data.accessToken
    user.value = data.user
    localStorage.setItem('token', data.accessToken)
    localStorage.setItem('refreshToken', data.refreshToken)
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

  return {
    token,
    user,
    login,
    logout,
    fetchUserInfo
  }
})
