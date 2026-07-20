import { ref, computed, watch, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useSessionStore, type SessionEnvironmentInfo } from '../stores/session'
import { useStreamWS } from './useStreamWS'
import { collectLocalUnsyncedSkills } from '../utils/localSkills'
import { collectAgentsMdContent } from '../utils/agentsMd'
import { mapMessagesWithFileChanges } from '../utils/chatMessage'
import type { ChatMessage, QuestionAnswer } from '../types/chat'

export type {
  ChatMessage,
  FileAttachment,
  MessageSegment,
  ToolCall,
  TodoItem
} from '../types/chat'
export { normalizeMessageRole } from '../types/chat'

import { normalizeImageForUpload, uploadToOss, type StsToken } from '../utils/ossUpload'
import { getUploadConfig, type UploadConfig } from '../utils/storageMode'
import { deriveSessionTitle } from '../utils/sessionTitle'
import { generateUUID } from '../utils/uuid'
import { validateHttpsGitUrl } from '../utils/cloud-project'
import { nowDateTime } from '../utils/datetime'

export interface ApprovalItem {
  requestId: string
  toolName: string
  description: string
  sessionId?: string
  dangerReason?: string
}

// Module-level shared approval queue — ChatPanel + SideChatPanel both consume this.
// IPC listener must close over a stable ref, not a per-useChat() instance.
const pendingApprovals = ref<ApprovalItem[]>([])
let approvalListenerSetup = false

function ensureApprovalListener() {
  if (typeof window === 'undefined' || !(window as any).electronAPI || approvalListenerSetup) return
  approvalListenerSetup = true

  ;(window as any).electronAPI.onToolApprovalRequest((data: { requestId: string; toolName: string; description: string; sessionId?: number; dangerReason?: string }) => {
    const sessionStore = useSessionStore()
    const sid = data.sessionId != null ? String(data.sessionId) : undefined
    if (!pendingApprovals.value.some(a => a.requestId === data.requestId)) {
      pendingApprovals.value.push({ requestId: data.requestId, toolName: data.toolName, description: data.description, sessionId: sid, dangerReason: data.dangerReason })
      if (sid) sessionStore.incrementPendingApproval(sid)
    }
  })

  ;(window as any).electronAPI.onToolApprovalDismiss((data: { requestId: string }) => {
    const sessionStore = useSessionStore()
    const item = pendingApprovals.value.find(a => a.requestId === data.requestId)
    if (item?.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
    pendingApprovals.value = pendingApprovals.value.filter(a => a.requestId !== data.requestId)
  })
}

/** Shared tool-approval queue for main chat and side tasks. */
export function useToolApprovals() {
  const sessionStore = useSessionStore()
  const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI
  ensureApprovalListener()

  async function confirmApproval(requestId: string, approved: boolean) {
    const item = pendingApprovals.value.find(a => a.requestId === requestId)
    if (item?.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
    pendingApprovals.value = pendingApprovals.value.filter(a => a.requestId !== requestId)
    if (requestId && isElectron) {
      await (window as any).electronAPI.respondToolApproval(requestId, approved)
    }
  }

  function clearPendingApprovals() {
    const items = pendingApprovals.value.slice()
    pendingApprovals.value = []
    for (const item of items) {
      if (item.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
      // Reject in main process so requestToolApproval() Promises do not hang forever.
      if (item.requestId && isElectron) {
        void (window as any).electronAPI.respondToolApproval(item.requestId, false)
      }
    }
  }

  return { pendingApprovals, confirmApproval, clearPendingApprovals }
}

const FILE_REF_PATTERN = /@\{([^}]+)\}@/g

export function useChat(agentId: Ref<string>, executionMode: Ref<string>, selectedModelId?: Ref<number | undefined>, permissionLevel?: Ref<string>) {
  const sessionStore = useSessionStore()
  const { connect, subscribe, unsubscribe, sendMessage: wsSendMessage, sendEditMessage, cancel: wsCancel, sendAskUserQuestionsResult, enqueueMessage: wsEnqueueMessage, insertMessage: wsInsertMessage, deleteQueueMessage: wsDeleteQueueMessage, reorderQueueMessage: wsReorderQueueMessage, pendingCallbacks, setActiveExecution, clearActiveExecution, onMessageSaved, offMessageSaved } = useStreamWS()
  const { pendingApprovals, confirmApproval, clearPendingApprovals } = useToolApprovals()

  const sending = ref(false)
  const initializingWorkspace = ref(false)
  const initializingWorkspaceLabel = ref('')
  const switchingSession = ref(false)
  const sendingSessionId = ref<string | null>(null)
  const sessionId = ref<string | null>(null)
  const workspace = ref('')
  const cloudProjectKey = ref('')
  const workspaceMode = ref<string>('new')
  const gitCloneUrl = ref('')
  const gitBranch = ref('')
  const cloudProjects = ref<Array<{ name: string; path: string; isGit: boolean }>>([])
  const agentName = ref('Agent')
  const startedAt = ref<string | null>(null)

  const isElectron = typeof window !== 'undefined' && (window as any).electronAPI

  function isActivePhase(phase?: string | null) {
    return phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL'
  }

  // Computed refs from store — reactive to active session
  const messages = computed(() => sessionStore.activeMessages)
  const todos = computed(() => sessionStore.activeTodos)
  const activities = computed(() => sessionStore.activeActivities)
  const contextWindow = computed(() => sessionStore.activeContextWindow)

  async function fetchMessages() {
    if (!sessionId.value) return
    sessionStore.clearMessagePageState(sessionId.value)
    try {
      const { data } = await api.get(`/sessions/${sessionId.value}/messages`, { params: { roundLimit: 5 } })
      const raw: Array<Record<string, unknown>> = data?.messages || []
      const { messages, allChanges } = mapMessagesWithFileChanges(raw)
      sessionStore.setMessages(sessionId.value, messages)
      sessionStore.setFileChanges(sessionId.value, allChanges)
      sessionStore.setMessagePageState(
        sessionId.value,
        Boolean(data?.hasMore),
        data?.nextBeforeMessageId != null ? String(data.nextBeforeMessageId) : null
      )
    } catch {
      // session might not exist yet
    }
  }

  async function loadOlderMessages() {
    if (!sessionId.value) return false
    const sid = sessionId.value
    if (sessionStore.activeMessageLoadingOlder || !sessionStore.activeMessageHasMore || !sessionStore.activeMessageNextBeforeId) {
      return false
    }
    sessionStore.setLoadingOlderMessages(sid, true)
    try {
      const { data } = await api.get(`/sessions/${sid}/messages`, {
        params: { roundLimit: 5, beforeMessageId: sessionStore.activeMessageNextBeforeId }
      })
      const raw: Array<Record<string, unknown>> = data?.messages || []
      const { messages: olderMessages, allChanges } = mapMessagesWithFileChanges(raw)
      sessionStore.prependMessages(sid, olderMessages)
      const existingChanges = sessionStore.activeFileChanges
      sessionStore.setFileChanges(sid, [...allChanges, ...existingChanges])
      sessionStore.setMessagePageState(
        sid,
        Boolean(data?.hasMore),
        data?.nextBeforeMessageId != null ? String(data.nextBeforeMessageId) : null
      )
      return olderMessages.length > 0
    } catch {
      return false
    } finally {
      sessionStore.setLoadingOlderMessages(sid, false)
    }
  }

  async function fetchTodos() {
    if (!sessionId.value) return
    try {
      const { data } = await api.get(`/sessions/${sessionId.value}/todos`)
      sessionStore.setTodos(sessionId.value, data || [])
    } catch {
      // session might not exist yet
    }
  }

  async function updateTodoManually(todoId: number, action: 'start' | 'complete' | 'delete') {
    if (!sessionId.value) return
    const statusMap: Record<string, string> = {
      start: 'in_progress',
      complete: 'completed'
    }
    try {
      if (action === 'delete') {
        await api.delete(`/sessions/${sessionId.value}/todos/${todoId}`)
      } else {
        await api.patch(`/sessions/${sessionId.value}/todos/${todoId}`, { status: statusMap[action] })
      }
      // Refresh todos after update
      await fetchTodos()
    } catch {
      // ignore
    }
  }

  async function uploadImages(files: File[]): Promise<string[]> {
    if (files.length === 0) return []

    // Get upload config to determine storage mode
    const config: UploadConfig = await getUploadConfig()

    if (config.storageMode === 'local') {
      // Local storage mode: upload via server API, backend returns absolute Nginx URL
      const urls: string[] = []
      for (const file of files) {
        try {
          const normalized = await normalizeImageForUpload(file)
          const formData = new FormData()
          formData.append('file', normalized)
          if (sessionId.value) {
            formData.append('sessionId', String(sessionId.value))
          }
          const { data } = await api.post('/files/upload', formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
          })
          urls.push(data.url)
        } catch {
          ElMessage.error(`图片 ${file.name} 上传失败`)
        }
      }
      return urls
    }

    // OSS mode: get STS token and upload to OSS
    let stsToken: StsToken
    try {
      const { data } = await api.post('/oss/sts-token', {
        sessionId: sessionId.value ? Number(sessionId.value) : null
      })
      stsToken = data
    } catch {
      ElMessage.error('获取上传凭证失败')
      return []
    }

    // Upload each file to OSS
    const urls: string[] = []
    for (const file of files) {
      try {
        const url = await uploadToOss(file, stsToken)
        urls.push(url)
      } catch {
        ElMessage.error(`图片 ${file.name} 上传失败`)
      }
    }
    return urls
  }

  function resolveWorkspaceInitLabel(): string {
    if (executionMode.value === 'CLOUD' && workspaceMode.value === 'git' && gitCloneUrl.value) {
      return '正在克隆仓库...（可能需要 1-2 分钟）'
    }
    if (executionMode.value === 'CLOUD') {
      return '正在初始化工作区...'
    }
    return '正在创建任务...'
  }

  async function sendMessage(text: string, files?: File[]) {
    if ((!text && (!files || files.length === 0)) || sending.value) return

    sending.value = true
    startedAt.value = new Date().toISOString()

    if (executionMode.value === 'LOCAL' && !isElectron) {
      ElMessage.error('浏览器端不支持本地模式，请使用桌面客户端创建本地任务')
      sending.value = false
      return
    }

    try {
      // Upload images to OSS
      const imageUrls = await uploadImages(files || [])

      // Ensure WS connection is established
      await connect()

      // Defensive fallback: if sessionId is lost (e.g. after returning from settings),
      // recover from the store's activeSessionId before creating a new session
      if (!sessionId.value && sessionStore.activeSessionId) {
        sessionId.value = sessionStore.activeSessionId
        const active = sessionStore.activeSession
        if (active) {
          agentId.value = String(active.agentId)
          if (active.workspace) workspace.value = active.workspace
          if (active.agentName) agentName.value = active.agentName
        }
      }

      // Create session if needed
      if (!sessionId.value) {
        if (executionMode.value === 'LOCAL' && isElectron && !workspace.value) {
          const dir = await (window as any).electronAPI.selectDirectory()
          if (dir) workspace.value = dir
          else {
            sending.value = false
            return
          }
        }

        let environmentInfo: SessionEnvironmentInfo | undefined
        if (executionMode.value === 'LOCAL' && isElectron && (window as any).electronAPI?.getEnvironmentInfo) {
          environmentInfo = await (window as any).electronAPI.getEnvironmentInfo(workspace.value || undefined)
        }

        if (executionMode.value === 'CLOUD' && workspaceMode.value === 'git') {
          const gitError = validateHttpsGitUrl(gitCloneUrl.value)
          if (gitError) {
            ElMessage.error(gitError)
            sending.value = false
            return
          }
        }

        initializingWorkspace.value = true
        initializingWorkspaceLabel.value = resolveWorkspaceInitLabel()
        try {
          const sessionData = await sessionStore.createSession(
            agentId.value,
            executionMode.value,
            executionMode.value === 'LOCAL' ? workspace.value || undefined : undefined,
            environmentInfo,
            selectedModelId?.value,
            permissionLevel?.value,
            executionMode.value === 'CLOUD' ? cloudProjectKey.value || undefined : undefined,
            executionMode.value === 'CLOUD' ? workspaceMode.value : undefined,
            executionMode.value === 'CLOUD' && workspaceMode.value === 'git' ? gitCloneUrl.value : undefined,
            executionMode.value === 'CLOUD' && workspaceMode.value === 'git' ? (gitBranch.value || undefined) : undefined
          )
          sessionId.value = sessionData.id
          if (sessionData.workspace) {
            workspace.value = sessionData.workspace
          }
          if (sessionData.agentName) {
            agentName.value = sessionData.agentName
          }
        } finally {
          initializingWorkspace.value = false
          initializingWorkspaceLabel.value = ''
        }
      }

      const sid = sessionId.value!
      // Track which session is sending (set AFTER session creation so ID is correct)
      sendingSessionId.value = sid

      // Clear previous turn's todos / execution error banner
      sessionStore.clearTodos(sid)
      sessionStore.clearExecutionError(sid)

      // Update session title from first user message (when title is still the default)
      const currentSession = sessionStore.sessions.find(s => String(s.id) === String(sid))
      if (currentSession && (!currentSession.title || currentSession.title === '未命名会话')) {
        let derivedTitle = '任务'
        if (text) {
          derivedTitle = await deriveSessionTitle(text)
        } else if (imageUrls.length > 0) {
          derivedTitle = '图片消息'
        }
        sessionStore.updateSession(sid, { title: derivedTitle })
        api.patch(`/sessions/${sid}`, { title: derivedTitle }).catch(() => {})
      }

      // Add user message to store
      sessionStore.addUserMessage(sid, {
        id: `msg_${Date.now()}_user`,
        role: 'user',
        content: text,
        createdAt: nowDateTime(),
        images: imageUrls.length > 0 ? imageUrls : undefined
      })

      // Add empty assistant message
      sessionStore.addAssistantMessage(sid, {
        id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: '',
        createdAt: nowDateTime(),
        toolCalls: [],
        segments: []
      })

      // Subscribe to this session's events
      subscribe(sid)

      // Resolve file reference relative paths to absolute paths
      let resolvedText = text || ''
      if (resolvedText.includes('@{') && workspace.value) {
        FILE_REF_PATTERN.lastIndex = 0
        resolvedText = resolvedText.replace(FILE_REF_PATTERN, (_, relPath) => {
          const absPath = workspace.value.replace(/\/$/, '') + '/' + relPath.replace(/^\//, '')
          return `@{${absPath}}@`
        })
      }

      // Send message via WS
      const eventId = generateUUID()
      setActiveExecution(sid, eventId)
      const localSkills = await collectLocalUnsyncedSkills(executionMode.value, isElectron)
      const agentsMdContent = await collectAgentsMdContent(workspace.value, executionMode.value, isElectron)
      wsSendMessage(sid, resolvedText, eventId, imageUrls, localSkills, agentsMdContent)

      // Wait for completion (session_status reaches COMPLETED/FAILED)
      await new Promise<void>((resolve, reject) => {
        pendingCallbacks.set(sessionId.value!, { resolve, reject })
      })

      sending.value = false
      if (startedAt.value) {
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.durationMs = Date.now() - new Date(startedAt.value).getTime()
        }
        startedAt.value = null
      }
      // Refresh session to pick up server-generated title/summary
      if (sessionId.value) {
        sessionStore.fetchSession(sessionId.value)
        // Re-fetch messages so that the API-structured messages replace the
        // live-streamed single-message, enabling round-based collapse in UI
        fetchMessages()
      }
    } catch (error: any) {
      sending.value = false
      initializingWorkspace.value = false
      initializingWorkspaceLabel.value = ''
      // Remove empty assistant message if it was added
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) {
        messages.value.pop()
      }
      if (!(error as Error & { toastShown?: boolean }).toastShown) {
        const failedBeforeSession = !sessionId.value
        ElMessage.error(
          error?.response?.data?.message
          || error?.message
          || (failedBeforeSession ? '任务创建失败' : 'Agent 执行中断')
        )
      }
      if (sessionId.value) {
        sessionStore.fetchSession(sessionId.value)
      }
    }
  }

  /**
   * 发送消息并等待消息保存确认
   * @returns true 表示消息已发出（可清空输入框）；false 表示发送失败（保留输入以便重试）
   */
  async function sendMessageAndWaitForSave(text: string, files?: File[]): Promise<boolean> {
    if ((!text && (!files || files.length === 0)) || sending.value) return false

    sending.value = true
    startedAt.value = new Date().toISOString()

    if (executionMode.value === 'LOCAL' && !isElectron) {
      ElMessage.error('浏览器端不支持本地模式，请使用桌面客户端创建本地任务')
      sending.value = false
      return false
    }

    try {
      // Upload images to OSS
      const imageUrls = await uploadImages(files || [])

      // Ensure WS connection is established
      await connect()

      // Defensive fallback: if sessionId is lost (e.g. after returning from settings),
      // recover from the store's activeSessionId before creating a new session
      if (!sessionId.value && sessionStore.activeSessionId) {
        sessionId.value = sessionStore.activeSessionId
        const active = sessionStore.activeSession
        if (active) {
          agentId.value = String(active.agentId)
          if (active.workspace) workspace.value = active.workspace
          if (active.agentName) agentName.value = active.agentName
        }
      }

      // Create session if needed
      if (!sessionId.value) {
        if (executionMode.value === 'LOCAL' && isElectron && !workspace.value) {
          const dir = await (window as any).electronAPI.selectDirectory()
          if (dir) workspace.value = dir
          else {
            sending.value = false
            return false
          }
        }

        let environmentInfo: SessionEnvironmentInfo | undefined
        if (executionMode.value === 'LOCAL' && isElectron && (window as any).electronAPI?.getEnvironmentInfo) {
          environmentInfo = await (window as any).electronAPI.getEnvironmentInfo(workspace.value || undefined)
        }

        if (executionMode.value === 'CLOUD' && workspaceMode.value === 'git') {
          const gitError = validateHttpsGitUrl(gitCloneUrl.value)
          if (gitError) {
            ElMessage.error(gitError)
            sending.value = false
            return false
          }
        }

        initializingWorkspace.value = true
        initializingWorkspaceLabel.value = resolveWorkspaceInitLabel()
        try {
          const sessionData = await sessionStore.createSession(
            agentId.value,
            executionMode.value,
            executionMode.value === 'LOCAL' ? workspace.value || undefined : undefined,
            environmentInfo,
            selectedModelId?.value,
            permissionLevel?.value,
            executionMode.value === 'CLOUD' ? cloudProjectKey.value || undefined : undefined,
            executionMode.value === 'CLOUD' ? workspaceMode.value : undefined,
            executionMode.value === 'CLOUD' && workspaceMode.value === 'git' ? gitCloneUrl.value : undefined,
            executionMode.value === 'CLOUD' && workspaceMode.value === 'git' ? (gitBranch.value || undefined) : undefined
          )
          sessionId.value = sessionData.id
          if (sessionData.workspace) {
            workspace.value = sessionData.workspace
          }
          if (sessionData.agentName) {
            agentName.value = sessionData.agentName
          }
        } finally {
          initializingWorkspace.value = false
          initializingWorkspaceLabel.value = ''
        }
      }

      const sid = sessionId.value!
      // Track which session is sending (set AFTER session creation so ID is correct)
      sendingSessionId.value = sid

      // Clear previous turn's todos / execution error banner
      sessionStore.clearTodos(sid)
      sessionStore.clearExecutionError(sid)

      // Update session title from first user message (when title is still the default)
      const currentSession = sessionStore.sessions.find(s => String(s.id) === String(sid))
      if (currentSession && (!currentSession.title || currentSession.title === '未命名会话')) {
        let derivedTitle = '任务'
        if (text) {
          derivedTitle = await deriveSessionTitle(text)
        } else if (imageUrls.length > 0) {
          derivedTitle = '图片消息'
        }
        sessionStore.updateSession(sid, { title: derivedTitle })
        api.patch(`/sessions/${sid}`, { title: derivedTitle }).catch(() => {})
      }

      // Add user message to store
      sessionStore.addUserMessage(sid, {
        id: `msg_${Date.now()}_user`,
        role: 'user',
        content: text,
        createdAt: nowDateTime(),
        images: imageUrls.length > 0 ? imageUrls : undefined
      })

      // Add empty assistant message
      sessionStore.addAssistantMessage(sid, {
        id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: '',
        createdAt: nowDateTime(),
        toolCalls: [],
        segments: []
      })

      // Subscribe to this session's events
      subscribe(sid)

      // Resolve file reference relative paths to absolute paths
      let resolvedText = text || ''
      if (resolvedText.includes('@{') && workspace.value) {
        FILE_REF_PATTERN.lastIndex = 0
        resolvedText = resolvedText.replace(FILE_REF_PATTERN, (_, relPath) => {
          const absPath = workspace.value.replace(/\/$/, '') + '/' + relPath.replace(/^\//, '')
          return `@{${absPath}}@`
        })
      }

      // Send message via WS
      const eventId = generateUUID()
      setActiveExecution(sid, eventId)
      const localSkills = await collectLocalUnsyncedSkills(executionMode.value, isElectron)
      const agentsMdContent = await collectAgentsMdContent(workspace.value, executionMode.value, isElectron)
      wsSendMessage(sid, resolvedText, eventId, imageUrls, localSkills, agentsMdContent)

      // 等待消息保存确认后立即返回，解锁输入框；Agent 在后台继续执行
      // 完成后的 sending / 刷新由 phase watcher 处理
      await new Promise<void>((resolve) => {
        const callbackId = onMessageSaved((callbackSessionId: string, _messageId: string) => {
          if (callbackSessionId === sid) {
            offMessageSaved(callbackId)
            resolve()
          }
        })
        // 设置超时，避免永远等待
        setTimeout(() => {
          offMessageSaved(callbackId)
          resolve()
        }, 5000)
      })

      // 保存确认后按实际 phase 同步 sending：
      // - Agent 尚未进入 RUNNING 时复位，避免误显示停止按钮
      // - 若 RUNNING 已先到达则保持 true；后续由 phase watcher 接管
      // 必须用本次发送的 sid，而非 activeSession（等待期间用户可能已切走会话）
      if (String(sessionId.value) === String(sid)) {
        sending.value = isActivePhase(sessionStore.getSessionPhase(sid))
      }

      // Fire-and-forget：记录本轮执行耗时（不阻塞返回）
      if (!pendingCallbacks.has(sid)) {
        new Promise<void>((resolve, reject) => {
          pendingCallbacks.set(sid, { resolve, reject })
        }).then(() => {
          if (startedAt.value) {
            const lastMsg = messages.value[messages.value.length - 1]
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.durationMs = Date.now() - new Date(startedAt.value).getTime()
            }
            startedAt.value = null
          }
        }).catch(() => {
          startedAt.value = null
        })
      }
      return true
    } catch (error: any) {
      sending.value = false
      initializingWorkspace.value = false
      initializingWorkspaceLabel.value = ''
      // Remove empty assistant message if it was added
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) {
        messages.value.pop()
      }
      if (!(error as Error & { toastShown?: boolean }).toastShown) {
        const failedBeforeSession = !sessionId.value
        ElMessage.error(
          error?.response?.data?.message
          || error?.message
          || (failedBeforeSession ? '任务创建失败' : 'Agent 执行中断')
        )
      }
      if (sessionId.value) {
        sessionStore.fetchSession(sessionId.value)
      }
      return false
    }
  }

  function stopExecution() {
    if (!sessionId.value) return
    const sid = sessionId.value

    clearActiveExecution(sid)
    wsCancel(sid)

    sending.value = false
    sendingSessionId.value = null
    startedAt.value = null

    sessionStore.setThinking(sid, false)
    sessionStore.setStreaming(sid, false)
    sessionStore.setCompacting(sid, false)
    sessionStore.clearAskQuestions(sid)
    sessionStore.updateSessionPhase(sid, 'CANCELLED')

    fetchQueue()

    const cb = pendingCallbacks.get(sid)
    if (cb) {
      pendingCallbacks.delete(sid)
      cb.resolve?.()
    }
  }

  /**
   * 编辑最后一条用户消息并重新发送
   */
  async function editAndResend(messageId: string, newContent: string, images: string[] = []) {
    if (!sessionId.value) return

    // 校验状态
    if (sending.value) {
      ElMessage.warning('会话正在执行中，无法编辑')
      return
    }

    sessionStore.clearExecutionError(sessionId.value)

    // 校验是否是最后一条用户消息
    const msgs = sessionStore.getMessages(sessionId.value)
    const lastUserMsg = [...msgs].reverse().find(m => m.role === 'user')
    if (!lastUserMsg || String(lastUserMsg.id) !== String(messageId)) {
      ElMessage.warning('只能编辑最后一条用户消息')
      return
    }

    // 未显式传入图片时保留原消息图片
    const imagesToSend = images.length > 0 ? images : (lastUserMsg.images ?? [])

    // 乐观更新：截断后续消息，更新编辑内容
    sessionStore.truncateMessagesAfter(sessionId.value, messageId)
    sessionStore.updateMessageContent(
      sessionId.value,
      messageId,
      newContent,
      imagesToSend.length > 0 ? imagesToSend : undefined
    )

    // 添加空 assistant 占位消息
    const placeholderMsg: ChatMessage = {
      id: `msg_${Date.now()}_assistant`,
      role: 'assistant',
      content: '',
      createdAt: nowDateTime(),
      toolCalls: [],
      segments: []
    }
    sessionStore.appendMessage(sessionId.value, placeholderMsg)

    sending.value = true
    startedAt.value = new Date().toISOString()

    try {
      // Ensure WS connection is established
      await connect()

      // Subscribe to this session's events
      subscribe(sessionId.value)

      // 通过 WS 发送编辑请求
      const localSkills = await collectLocalUnsyncedSkills(executionMode.value, isElectron)
      const agentsMdContent = await collectAgentsMdContent(workspace.value, executionMode.value, isElectron)
      sendEditMessage(sessionId.value, newContent, messageId, imagesToSend, localSkills, agentsMdContent)

      // Wait for completion
      await new Promise<void>((resolve, reject) => {
        pendingCallbacks.set(sessionId.value!, { resolve, reject })
      })

      sending.value = false
      if (startedAt.value) {
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.durationMs = Date.now() - new Date(startedAt.value).getTime()
        }
        startedAt.value = null
      }
      // Refresh session
      if (sessionId.value) {
        sessionStore.fetchSession(sessionId.value)
        fetchMessages()
      }
    } catch (error: any) {
      sending.value = false
      // Remove empty assistant message if it was added
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) {
        messages.value.pop()
      }
      ElMessage.error(error?.message || '编辑重新发送失败')
      if (sessionId.value) {
        sessionStore.fetchSession(sessionId.value)
      }
    }
  }

  // Watch phase changes for state sync.
  // This watcher fires both on actual phase transitions AND when activeSession
  // changes (e.g. null → session). The latter triggers with whatever phase the
  // session currently has (often IDLE), which would incorrectly reset sending.
  // Guard: only handle transitions where oldPhase is defined (real phase change).
  watch(() => sessionStore.activeSession?.phase, (phase, oldPhase) => {
    // Skip during session switches — restoreSession handles state sync
    if (switchingSession.value) return
    // Skip if this is a session switch, not a phase change (oldPhase is undefined)
    if (oldPhase === undefined) return

    // Skip if phase didn't actually change
    if (phase === oldPhase) return

    if (phase === 'CANCELLED' || phase === 'COMPLETED' || phase === 'FAILED' || phase === 'IDLE') {
      sending.value = false
      sendingSessionId.value = null
      if (sessionId.value && pendingCallbacks.has(sessionId.value)) {
        const cb = pendingCallbacks.get(sessionId.value)
        pendingCallbacks.delete(sessionId.value)
        cb?.resolve?.()
      }
      if (sessionId.value) {
        sessionStore.fetchSession(sessionId.value)
        fetchMessages()
        fetchQueue()
      }
    } else if (phase === 'RUNNING' || phase === 'WAITING_APPROVAL') {
      // Auto-sync sending state (covers queue auto-consume case)
      if (!sending.value) {
        sending.value = true
        startedAt.value = new Date().toISOString()
        if (sessionId.value && !pendingCallbacks.has(sessionId.value)) {
          new Promise<void>((resolve, reject) => {
            pendingCallbacks.set(sessionId.value!, { resolve, reject })
          }).then(() => {
            sending.value = false
            startedAt.value = null
          }).catch(() => {
            sending.value = false
            startedAt.value = null
          })
        }
      }
    }
  })

  // --- Message Queue ---

  const isActive = computed(() => {
    const phase = sessionStore.activeSession?.phase
    return phase === 'RUNNING' || phase === 'WAITING_APPROVAL'
  })

  async function sendMessageWithQueue(text: string, files: File[]) {
    if (isActive.value) {
      await enqueueMessage(text, files)
    } else {
      await sendMessage(text, files)
    }
  }

  async function enqueueMessage(text: string, files: File[]) {
    if (sessionId.value) sessionStore.clearExecutionError(sessionId.value)
    const imageUrls = files.length > 0 ? await uploadImages(files) : []
    await connect()
    const eventId = generateUUID()
    wsEnqueueMessage(sessionId.value || '', text, eventId, imageUrls)
  }

  async function insertQueueMessage(queueId: string) {
    if (!sessionId.value) return
    await connect()
    wsInsertMessage(sessionId.value, queueId)
  }

  async function deleteQueueMessage(queueId: string) {
    if (!sessionId.value) return
    await connect()
    wsDeleteQueueMessage(sessionId.value, queueId)
  }

  async function reorderQueueMessage(queueId: string, direction: 'up' | 'down') {
    if (!sessionId.value) return
    await connect()
    wsReorderQueueMessage(sessionId.value, queueId, direction)
  }

  async function fetchQueue() {
    if (!sessionId.value) return
    try {
      const { data } = await api.get(`/sessions/${sessionId.value}/queue`)
      sessionStore.setQueueMessages(sessionId.value, data || [])
    } catch {
      // ignore
    }
  }

  function newSession() {
    if (sessionId.value) {
      sessionStore.clearQueueMessages(sessionId.value)
    }
    clearPendingApprovals()
    sending.value = false
    sessionId.value = null
    workspace.value = ''
    cloudProjectKey.value = ''
    workspaceMode.value = 'new'
    gitCloneUrl.value = ''
    gitBranch.value = ''
    agentName.value = 'Agent'
    sessionStore.setActiveSession(null)
  }

  async function restoreSession(sessionIdVal: string, mode: string, initialWorkspace?: string) {
    // Suppress phase watcher during session switch to prevent stale phase
    // from resetting sending/cancelling state
    switchingSession.value = true

    // Unsubscribe from previous session
    if (sessionId.value && sessionId.value !== sessionIdVal) {
      unsubscribe(sessionId.value)
    }

    sessionId.value = sessionIdVal
    executionMode.value = mode
    sessionStore.setActiveSession(sessionIdVal)

    // Read session data from the store — loadSession updates the store before
    // triggering this watcher, so the data is guaranteed to be fresh
    const session = sessionStore.activeSession
    if (session?.workspace) {
      workspace.value = session.workspace
    } else if (initialWorkspace) {
      workspace.value = initialWorkspace
    }
    cloudProjectKey.value = session?.projectKey && session.workspace?.includes('/projects/')
      ? session.projectKey
      : ''

    // Sync agent name from session data
    if (session?.agentName) {
      agentName.value = session.agentName
    }

    // Sync agentId from session data — critical for existing sessions
    if (session?.agentId) {
      agentId.value = String(session.agentId)
    }

    // Sync sending state with the session's actual phase
    const phase = sessionStore.activeSession?.phase
    const active = isActivePhase(phase)
    const hasCachedMessages = sessionStore.getMessages(sessionIdVal).length > 0
    if (active) {
      sending.value = true
      if (hasCachedMessages) {
        sessionStore.ensureStreamingAssistantMessage(sessionIdVal)
      }
      // Register a pending callback so stopExecution() works and session_status can resolve it
      if (!pendingCallbacks.has(sessionIdVal)) {
        new Promise<void>((resolve, reject) => {
          pendingCallbacks.set(sessionIdVal, { resolve, reject })
        }).then(() => {
          sending.value = false
          startedAt.value = null
        }).catch(() => {
          sending.value = false
          startedAt.value = null
        })
      }
    } else {
      sending.value = false
    }

    // Ensure WS connection is established before subscribing
    try {
      await connect()
    } catch {
      // WS connect failed (e.g. no token) — subscribe will be retried on reconnect
    }
    subscribe(sessionIdVal)

    if (!active || !hasCachedMessages) {
      fetchMessages().then(() => {
        if (isActivePhase(sessionStore.activeSession?.phase)) {
          sessionStore.ensureStreamingAssistantMessage(sessionIdVal)
        }
      })
    }
    fetchTodos()
    fetchQueue()

    // Resume phase watcher after session switch is complete
    switchingSession.value = false
  }

  function submitQuestionAnswer(requestId: string, answers: QuestionAnswer[]) {
    if (!sessionId.value) return
    sendAskUserQuestionsResult(sessionId.value, requestId, answers)
    sessionStore.removeAskQuestion(sessionId.value, requestId)
  }

  function cleanup() {
    if (sessionId.value) {
      unsubscribe(sessionId.value)
    }
    clearPendingApprovals()
  }

  return {
    messages,
    sending,
    initializingWorkspace,
    initializingWorkspaceLabel,
    sessionId,
    workspace,
    cloudProjectKey,
    workspaceMode,
    gitCloneUrl,
    gitBranch,
    cloudProjects,
    agentName,
    pendingApprovals,
    activities,
    todos,
    contextWindow,
    startedAt,
    sendMessage,
    sendMessageAndWaitForSave,
    sendMessageWithQueue,
    editAndResend,
    stopExecution,
    fetchMessages,
    loadOlderMessages,
    newSession,
    restoreSession,
    confirmApproval,
    submitQuestionAnswer,
    updateTodoManually,
    fetchTodos,
    cleanup,
    // Queue
    isActive,
    insertQueueMessage,
    deleteQueueMessage,
    reorderQueueMessage,
    fetchQueue,
    switchingSession,
    sendingSessionId
  }
}
