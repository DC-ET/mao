import axios, { type InternalAxiosRequestConfig } from 'axios'
import { ElMessage } from 'element-plus'
import type { InboxItem, InboxKind, InboxListResult, InboxPreference, InboxSource, NotificationChannel, Result, TaskNotificationPreference } from '@mao/contracts'
import { redirectToLogin } from '../utils/login-redirect'
import { useAuthStore } from '../stores/auth'
import { getRefreshToken, getToken, setTokens } from '../utils/auth-storage'
import type { SessionSearchItem } from '../types/chat'

/** 强制下线：动态引入 router（避免模块加载期创建路由，破坏 Node 环境单测）。 */
async function forceRelogin(): Promise<void> {
  await useAuthStore().clearLocalSession()
  const { default: router } = await import('../router')
  redirectToLogin(router)
}

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

/** 登录页自身的请求（/auth/*），失败只展示表单错误，不得触发强制下线跳转。 */
function isAuthPath(url?: string): boolean {
  return !!url && /\/auth\/(login|refresh|feishu)/.test(url)
}

let isRefreshing = false
let pendingRequests: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = []

export async function doRefreshToken(): Promise<string> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) throw new Error('No refresh token')

  const baseURL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1'
  const resp = await axios.post<Result<{ accessToken: string; refreshToken: string }>>(
    `${baseURL}/auth/refresh`,
    { refreshToken }
  )
  const { data } = resp.data
  if (!data) throw new Error('Refresh failed: empty data')

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
      const err = new Error(data.message || '请求失败') as Error & { toastShown?: boolean; code?: number }
      err.toastShown = true
      err.code = data.code
      return Promise.reject(err)
    }
    return data
  },
  async (error) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean; skipErrorToast?: boolean }

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true

      if (isAuthPath(originalRequest.url)) {
        // 登录/刷新接口自身的 401 交给调用方处理
        return Promise.reject(error)
      }

      if (isRefreshing) {
        // Another request is already refreshing — queue this one
        return new Promise((resolve, reject) => {
          pendingRequests.push({
            resolve: (newToken: string) => {
              originalRequest.headers.Authorization = `Bearer ${newToken}`
              resolve(api(originalRequest))
            },
            reject
          })
        })
      }

      isRefreshing = true
      try {
        const newToken = await doRefreshToken()
        // isRefreshing 必须在 flush 排队请求之前复位：若等重试请求完成才复位，
        // 窗口期内到达的 401 会继续入队，但队列已被 flush，这些请求将永久挂起
        isRefreshing = false
        // Retry all queued requests with the new token
        pendingRequests.forEach(cb => cb.resolve(newToken))
        pendingRequests = []
        // Retry the original request
        originalRequest.headers.Authorization = `Bearer ${newToken}`
        return api(originalRequest)
      } catch (refreshError) {
        isRefreshing = false
        // refresh 失败必须 reject 排队请求，否则调用方 await 永久挂起
        pendingRequests.forEach(cb => cb.reject(refreshError))
        pendingRequests = []
        // refresh 失败：清本地会话并回登录页（redirectToLogin 自带防抖与「已在登录页」判断）
        void forceRelogin()
        return Promise.reject(error)
      }
    }

    if (error.response) {
      const { status, data } = error.response
      if (status === 403) {
        // 403 是已登录无权限，不是未登录：只提示，不踢回登录页
        ElMessage.error(data?.message || '无权限执行该操作')
        if (error && typeof error === 'object') {
          (error as Error & { toastShown?: boolean }).toastShown = true
        }
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

export type { NotificationChannel, TaskNotificationPreference }

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

export interface WeixinPreference {
  voiceReply: boolean
}

export async function getWeixinPreference(): Promise<WeixinPreference> {
  const { data } = await api.get('/user-preferences/weixin')
  return data
}

export async function saveWeixinPreference(payload: {
  voiceReply: boolean
}): Promise<WeixinPreference> {
  const { data } = await api.put('/user-preferences/weixin', payload)
  return data
}

export interface McpServerPreferenceItem {
  id: number
  /** 服务器来源：GLOBAL=全局服务器，USER=用户私有服务器 */
  scope: string
  name: string
  description: string | null
  serverType: string
  /** 服务器状态：ENABLED | DISABLED */
  status: string
  /** 用户级启用状态：true=启用（含未单独配置跟随全局），false=用户已停用或管理员已停用 */
  userEnabled: boolean
}

/** 获取当前用户可用的 MCP 服务器及其用户级启用状态（客户端设置页）。 */
export async function getMcpServerPreferences(): Promise<McpServerPreferenceItem[]> {
  const { data } = await api.get('/mcp-servers/preferences')
  return data
}

/** 保存单个 MCP 服务器的用户级启用/停用偏好。 */
export async function saveMcpServerPreference(serverId: number, enabled: boolean): Promise<void> {
  await api.put('/mcp-servers/preferences', { items: [{ serverId, enabled }] })
}

export interface McpServerConfig {
  id: number
  userId: number
  name: string
  description: string | null
  serverType: string
  command: string | null
  argsJson: string | null
  url: string | null
  status: string
}

export interface SaveMcpServerPayload {
  name: string
  description?: string
  serverType: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

export interface McpToolItem {
  serverId: number
  serverName: string
  toolName: string
  description: string
}

/** 获取当前用户的私有 MCP 服务器列表。 */
export async function getMyMcpServers(): Promise<McpServerConfig[]> {
  const { data } = await api.get('/mcp-servers/me')
  return data
}

/** 创建用户私有 MCP 服务器。 */
export async function createMyMcpServer(payload: SaveMcpServerPayload): Promise<McpServerConfig> {
  const { data } = await api.post('/mcp-servers/me', payload)
  return data
}

/** 编辑用户私有 MCP 服务器。 */
export async function updateMyMcpServer(id: number, payload: SaveMcpServerPayload): Promise<McpServerConfig> {
  const { data } = await api.put(`/mcp-servers/me/${id}`, payload)
  return data
}

/** 删除用户私有 MCP 服务器。 */
export async function deleteMyMcpServer(id: number): Promise<void> {
  await api.delete(`/mcp-servers/me/${id}`)
}

/** 测试用户私有 MCP 服务器连接，返回服务器暴露的工具清单。 */
export async function testMyMcpServer(id: number): Promise<McpToolItem[]> {
  const { data } = await api.post(`/mcp-servers/me/${id}/test`)
  return data
}

// ─── 会话消息搜索 ───

/** 按用户消息内容搜索会话（主会话 + 边路会话），最多返回 20 条。 */
export async function searchSessions(keyword: string, options?: { signal?: AbortSignal }): Promise<SessionSearchItem[]> {
  const { data } = await api.get('/sessions/search', {
    params: { keyword },
    signal: options?.signal,
    skipErrorToast: true
  } as any)
  return data?.items ?? []
}

// ─── 站内收件箱 ───

export type { InboxItem, InboxKind, InboxListResult, InboxPreference, InboxSource }

/** 收件箱列表（分页 page + size，unreadOnly 只看未读）。 */
export async function fetchInboxList(params?: {
  page?: number
  size?: number
  unreadOnly?: boolean
}): Promise<InboxListResult> {
  const { data } = await api.get('/inbox', { params })
  return data
}

/** 徽标数据源：服务端 COUNT 为唯一权威，前端禁止本地累加。 */
export async function fetchInboxUnreadCount(): Promise<{ unreadCount: number }> {
  const { data } = await api.get('/inbox/unread-count')
  return data
}

export async function markInboxItemRead(id: number): Promise<void> {
  await api.post(`/inbox/${id}/read`)
}

export async function markInboxAllRead(): Promise<void> {
  await api.post('/inbox/read-all')
}

export async function removeInboxItem(id: number): Promise<void> {
  await api.delete(`/inbox/${id}`)
}

export async function getInboxPreference(): Promise<InboxPreference> {
  const { data } = await api.get('/inbox/preferences')
  return data
}

export async function saveInboxPreference(payload: InboxPreference): Promise<InboxPreference> {
  const { data } = await api.put('/inbox/preferences', payload)
  return data
}

// ─── 消息点踩反馈 ───

export type FeedbackReason = 'WRONG_RESULT' | 'SLOW_RESPONSE' | 'NOT_SOLVED' | 'OTHER'

/** 提交（或覆盖）某条 assistant 消息的点踩。 */
export async function dislikeMessage(messageId: number, reason: FeedbackReason): Promise<void> {
  await api.put(`/feedback/messages/${messageId}/dislike`, { reason })
}
/** 取消某条消息的点踩。 */
export async function cancelDislikeMessage(messageId: number): Promise<void> {
  await api.delete(`/feedback/messages/${messageId}/dislike`)
}

/** 拉取当前用户在指定会话内已点踩的消息 ID 列表（用于会话历史回显）。 */
export async function fetchDislikedMessageIds(sessionId: number): Promise<number[]> {
  const { data } = await api.get('/feedback/messages/disliked-ids', { params: { sessionId } })
  return data?.ids ?? []
}

// ─── 长期记忆（跨会话记忆） ───

export type MemoryScope = 'USER' | 'PROJECT'
export type MemoryStatus = 'ACTIVE' | 'DISMISSED'
export type MemorySource = 'AUTO' | 'MANUAL'

export interface MemoryItem {
  id: number
  scope: MemoryScope
  projectKey: string | null
  content: string
  source: MemorySource
  status: MemoryStatus
  originSessionId: number | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface MemoryPage {
  records: MemoryItem[]
  total: number
  current: number
  size: number
}

export interface MemoryListParams {
  page?: number
  pageSize?: number
  scope?: MemoryScope | null
  projectKey?: string | null
  status?: MemoryStatus | null
}

export async function listMemories(params: MemoryListParams = {}): Promise<MemoryPage> {
  const { data } = await api.get('/memory', { params })
  return data
}

export async function createMemory(payload: { scope: MemoryScope; content: string; projectKey?: string | null }): Promise<MemoryItem> {
  const { data } = await api.post('/memory', payload)
  return data
}

export async function updateMemory(
  id: number,
  payload: { content?: string; status?: MemoryStatus }
): Promise<MemoryItem> {
  const { data } = await api.patch(`/memory/${id}`, payload)
  return data
}

export async function deleteMemory(id: number): Promise<void> {
  await api.delete(`/memory/${id}`)
}

/** 会话最近一次压缩摘要的现值（技术方案 5.5）。 */
export interface SessionCompactionSummary {
  summaryText: string | null
  lastCompactedMsgId: number | null
  compactCount: number | null
  compactModel: string | null
  updatedAt: string | null
}

/** 读取会话压缩摘要现值；无压缩记录时后端 data 缺省，返回 null。 */
export async function getSessionCompaction(sessionId: number | string): Promise<SessionCompactionSummary | null> {
  const { data } = await api.get(`/sessions/${sessionId}/compaction`)
  return (data ?? null) as SessionCompactionSummary | null
}

/** 切换单会话长期记忆注入开关（技术方案 5.1，下一次执行生效）。 */
export async function setSessionMemoryInjectionDisabled(sessionId: number | string, disabled: boolean): Promise<void> {
  await api.patch(`/sessions/${sessionId}`, { memoryInjectionDisabled: disabled })
}

export async function getMemorySettings(): Promise<{ autoCaptureEnabled: boolean }> {
  const { data } = await api.get('/memory/settings')
  return data
}

export async function saveMemorySettings(autoCaptureEnabled: boolean): Promise<void> {
  await api.patch('/memory/settings', { autoCaptureEnabled })
}

export async function listMemoryProjects(): Promise<string[]> {
  const { data } = await api.get('/memory/projects')
  return data?.projects ?? []
}

// ─── 开放接口（API Token / Webhook 触发器 / 出站订阅） ───

export interface ApiTokenView {
  id: number
  name: string
  tokenPrefix: string
  scopes: string[]
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string | null
}

export interface IssuedApiToken extends ApiTokenView {
  plainToken: string
}

export interface WebhookTriggerView {
  id: number
  name: string
  agentId: number
  sessionId: number | null
  enabled: boolean
  url: string | null
  pathToken?: string
  consecutiveFailures: number
  lastFiredAt: string | null
  createdAt: string | null
}

export interface CreatedWebhookTrigger {
  id: number
  pathToken: string
  plainSecret: string
  url: string
}

export interface OutboundSubscriptionView {
  id: number
  event: string
  targetUrl: string
  enabled: boolean
  createdAt: string | null
}

export interface CreatedOutboundSubscription {
  id: number
  event: string
  targetUrl: string
  plainSecret: string
}

export interface OutboundDeliveryView {
  id: number
  event: string
  status: string
  attemptCount: number
  lastHttpStatus: number | null
  lastError: string | null
  createdAt: string | null
  sentAt: string | null
}

export async function listApiTokens(): Promise<ApiTokenView[]> {
  const { data } = await api.get('/open/tokens')
  return data ?? []
}

export async function issueApiToken(payload: { name: string; scopes: string[] }): Promise<IssuedApiToken> {
  const { data } = await api.post('/open/tokens', payload)
  return data
}

export async function revokeApiToken(id: number): Promise<void> {
  await api.delete(`/open/tokens/${id}`)
}

export async function listWebhookTriggers(): Promise<WebhookTriggerView[]> {
  const { data } = await api.get('/open/triggers')
  return data ?? []
}

export async function createWebhookTrigger(payload: { name: string; agentId: number; sessionId?: number | null }): Promise<CreatedWebhookTrigger> {
  const { data } = await api.post('/open/triggers', payload)
  return data
}

export async function updateWebhookTrigger(id: number, payload: { name?: string; agentId?: number; sessionId?: number | null; enabled?: boolean }): Promise<void> {
  await api.put(`/open/triggers/${id}`, payload)
}

export async function deleteWebhookTrigger(id: number): Promise<void> {
  await api.delete(`/open/triggers/${id}`)
}

export async function rotateWebhookTriggerSecret(id: number): Promise<{ plainSecret: string }> {
  const { data } = await api.post(`/open/triggers/${id}/rotate-secret`)
  return data
}

export async function listOutboundSubscriptions(): Promise<OutboundSubscriptionView[]> {
  const { data } = await api.get('/open/subscriptions')
  return data ?? []
}

export async function createOutboundSubscription(payload: { event: string; targetUrl: string }): Promise<CreatedOutboundSubscription> {
  const { data } = await api.post('/open/subscriptions', payload)
  return data
}

export async function setOutboundSubscriptionEnabled(id: number, enabled: boolean): Promise<void> {
  await api.put(`/open/subscriptions/${id}`, { enabled })
}

export async function deleteOutboundSubscription(id: number): Promise<void> {
  await api.delete(`/open/subscriptions/${id}`)
}

export async function listOutboundDeliveries(subscriptionId: number): Promise<OutboundDeliveryView[]> {
  const { data } = await api.get(`/open/subscriptions/${subscriptionId}/deliveries`)
  return data ?? []
}

export interface SessionShareInfo {
  token: string
  messageWatermark: number
  viewCount: number
  createdAt?: string | null
  expiresAt?: string | null
  lastViewedAt?: string | null
}

export async function getSessionShare(sessionId: string): Promise<SessionShareInfo | null> {
  const { data } = await api.get(`/sessions/${sessionId}/share`)
  return data ?? null
}

export async function createSessionShare(
  sessionId: string,
  payload: { publicLink?: boolean; expiresInDays?: number } = {},
): Promise<SessionShareInfo> {
  const { data } = await api.post(`/sessions/${sessionId}/share`, payload)
  return data
}

export async function refreshSessionShare(sessionId: string): Promise<SessionShareInfo> {
  const { data } = await api.put(`/sessions/${sessionId}/share`)
  return data
}

export async function revokeSessionShare(sessionId: string): Promise<void> {
  await api.delete(`/sessions/${sessionId}/share`)
}
