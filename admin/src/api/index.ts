import axios, { type AxiosRequestConfig } from 'axios'
import { ElMessage } from 'element-plus'
import type { Result } from '@mao/contracts'

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// Request interceptor - add token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

let refreshing: Promise<string | null> | null = null

// 用 refreshToken 换新 token；并发 401 共享同一次刷新。
async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = localStorage.getItem('refreshToken')
  if (!refreshToken) return null
  try {
    const { data } = await axios.post(
      `${api.defaults.baseURL}/auth/refresh`,
      { refreshToken },
      { timeout: 10000 }
    ) as { data: Result<{ accessToken: string; refreshToken: string }> }
    const payload = data.data
    if (data.code !== 0 || !payload) return null
    localStorage.setItem('token', payload.accessToken)
    localStorage.setItem('refreshToken', payload.refreshToken)
    return payload.accessToken
  } catch {
    return null
  }
}

// Response interceptor - handle errors
api.interceptors.response.use(
  (response) => {
    // 后端统一响应 Result<T>（契约来自 @mao/contracts）
    const data = response.data as Result<unknown>
    if (data.code !== 0) {
      ElMessage.error(data.message || '请求失败')
      return Promise.reject(new Error(data.message))
    }
    return response.data
  },
  async (error) => {
    if (error.response) {
      const { status, config, data } = error.response
      if (status === 401) {
        // 静默刷新 token 后重试原请求；刷新失败才登出。
        const original = config as AxiosRequestConfig
        const url = original.url || ''
        if (url.includes('/auth/refresh') || url.includes('/auth/login')) {
          forceLogout()
          return Promise.reject(error)
        }
        refreshing = refreshing ?? refreshAccessToken()
        const newToken = await refreshing.finally(() => {
          refreshing = null
        })
        if (newToken && !(original as { _retried?: boolean })._retried) {
          ;(original as { _retried?: boolean })._retried = true
          original.headers = { ...original.headers, Authorization: `Bearer ${newToken}` }
          return api.request(original)
        }
        forceLogout()
      } else {
        ElMessage.error(data?.message || '请求失败')
      }
    } else {
      ElMessage.error('网络错误')
    }
    return Promise.reject(error)
  }
)

function forceLogout() {
  localStorage.removeItem('token')
  localStorage.removeItem('refreshToken')
  window.location.href = '/admin/login'
}
