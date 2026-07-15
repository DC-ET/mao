import axios, { type InternalAxiosRequestConfig } from 'axios'
import { ElMessage } from 'element-plus'
import { useLoginDialog } from '../composables/useLoginDialog'
import { getRefreshToken, getToken, setTokens } from '../utils/auth-storage'

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

let isReloginShowing = false
let isRefreshing = false
let pendingRequests: Array<(token: string) => void> = []

function showReloginDialog() {
  if (isReloginShowing) return
  isReloginShowing = true
  const { open } = useLoginDialog()
  open({
    onSuccess: () => { isReloginShowing = false },
    onDismiss: () => { isReloginShowing = false }
  })
}

export async function doRefreshToken(): Promise<string> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) throw new Error('No refresh token')

  const baseURL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1'
  const resp = await axios.post(`${baseURL}/auth/refresh`, { refreshToken })
  const { data } = resp.data

  await setTokens(data.accessToken, data.refreshToken)
  return data.accessToken
}

// Request interceptor - add token
api.interceptors.request.use(
  (config) => {
    const token = getToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor - handle errors with token refresh
api.interceptors.response.use(
  (response) => {
    const { data } = response
    if (data.code !== 0) {
      ElMessage.error(data.message || '请求失败')
      const err = new Error(data.message || '请求失败') as Error & { toastShown?: boolean }
      err.toastShown = true
      return Promise.reject(err)
    }
    return data
  },
  async (error) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean; skipErrorToast?: boolean }

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true

      if (isRefreshing) {
        // Another request is already refreshing — queue this one
        return new Promise((resolve) => {
          pendingRequests.push((newToken: string) => {
            originalRequest.headers.Authorization = `Bearer ${newToken}`
            resolve(api(originalRequest))
          })
        })
      }

      isRefreshing = true
      try {
        const newToken = await doRefreshToken()
        // Retry all queued requests with the new token
        pendingRequests.forEach(cb => cb(newToken))
        pendingRequests = []
        // Retry the original request
        originalRequest.headers.Authorization = `Bearer ${newToken}`
        return api(originalRequest)
      } catch {
        pendingRequests = []
        showReloginDialog()
        return Promise.reject(error)
      } finally {
        isRefreshing = false
      }
    }

    if (error.response) {
      const { status, data } = error.response
      if (status === 403) {
        showReloginDialog()
      } else if (status !== 401) {
        ElMessage.error(data?.message || '请求失败')
        if (error && typeof error === 'object') {
          (error as Error & { toastShown?: boolean }).toastShown = true
        }
      }
    } else if (!originalRequest.skipErrorToast) {
      ElMessage.error('网络错误')
    }
    return Promise.reject(error)
  }
)

export interface GitCredential {
  id: number
  domain: string
  accessToken: string
  description?: string
  createdAt?: string
  updatedAt?: string
}

export async function getGitCredentials(): Promise<GitCredential[]> {
  const { data } = await api.get('/user/git-credentials')
  return data
}

export async function createGitCredential(payload: {
  domain: string
  accessToken: string
  description?: string
}): Promise<GitCredential> {
  const { data } = await api.post('/user/git-credentials', payload)
  return data
}

export async function updateGitCredential(
  id: number,
  payload: { accessToken?: string; description?: string }
): Promise<GitCredential> {
  const { data } = await api.put(`/user/git-credentials/${id}`, payload)
  return data
}

export async function deleteGitCredential(id: number): Promise<void> {
  await api.delete(`/user/git-credentials/${id}`)
}

export type NotificationChannel = 'DINGTALK' | 'FEISHU'

export interface TaskNotificationPreference {
  enabled: boolean
  channel: NotificationChannel | null
  webhookConfigured: boolean
  maskedWebhook: string | null
}

export async function getTaskNotificationPreference(): Promise<TaskNotificationPreference> {
  const { data } = await api.get('/user-preferences/task-notification')
  return data
}

export async function saveTaskNotificationPreference(payload: {
  enabled: boolean
  channel: NotificationChannel | null
  webhookUrl?: string
}): Promise<TaskNotificationPreference> {
  const { data } = await api.put('/user-preferences/task-notification', payload)
  return data
}

export async function testTaskNotification(payload: {
  channel: NotificationChannel
  webhookUrl?: string
}): Promise<void> {
  await api.post('/user-preferences/task-notification/test', payload)
}
