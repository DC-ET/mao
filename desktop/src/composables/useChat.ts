import { ref, computed, watch, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useSessionStore } from '../stores/session'
import { useStreamWS } from './useStreamWS'
import { mapApiMessagesToChat } from '../utils/chatMessage'
import type { ChatMessage } from '../types/chat'

export type {
  ChatMessage,
  FileAttachment,
  MessageSegment,
  ToolCall,
  TodoItem
} from '../types/chat'
export { normalizeMessageRole } from '../types/chat'

import { uploadToOss, type StsToken } from '../utils/ossUpload'

export interface ApprovalItem {
  requestId: string
  toolName: string
  description: string
  sessionId?: string
  dangerReason?: string
}

// Module-level flag to ensure IPC listeners are registered only once
let approvalListenerSetup = false

export function useChat(agentId: Ref<string>, executionMode: Ref<string>) {
  const sessionStore = useSessionStore()
  const { connect, subscribe, unsubscribe, sendMessage: wsSendMessage, sendEditMessage, cancel: wsCancel, enqueueMessage: wsEnqueueMessage, insertMessage: wsInsertMessage, deleteQueueMessage: wsDeleteQueueMessage, reorderQueueMessage: wsReorderQueueMessage, pendingCallbacks } = useStreamWS()

  const sending = ref(false)
  const cancelling = ref(false)
  const switchingSession = ref(false)
  const sendingSessionId = ref<string | null>(null)
  const sessionId = ref<string | null>(null)
  const workspace = ref('')
  const agentName = ref('Agent')
  const startedAt = ref<string | null>(null)

  // Tool approval queue — supports multiple concurrent approvals
  const pendingApprovals = ref<ApprovalItem[]>([])

  const isElectron = typeof window !== 'undefined' && (window as any).electronAPI

  function isActivePhase(phase?: string | null) {
    return phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL' || phase === 'CANCELLING'
  }

  // Computed refs from store — reactive to active session
  const messages = computed(() => sessionStore.activeMessages)
  const todos = computed(() => sessionStore.activeTodos)
  const activities = computed(() => sessionStore.activeActivities)
  const contextWindow = computed(() => sessionStore.activeContextWindow)

  function setupApprovalListener() {
    if (!isElectron || approvalListenerSetup) return
    approvalListenerSetup = true

    ;(window as any).electronAPI.onToolApprovalRequest((data: { requestId: string; toolName: string; description: string; sessionId?: number; dangerReason?: string }) => {
      const sid = data.sessionId != null ? String(data.sessionId) : undefined
      if (!pendingApprovals.value.some(a => a.requestId === data.requestId)) {
        pendingApprovals.value.push({ requestId: data.requestId, toolName: data.toolName, description: data.description, sessionId: sid, dangerReason: data.dangerReason })
        if (sid) sessionStore.incrementPendingApproval(sid)
      }
    })

    ;(window as any).electronAPI.onToolApprovalDismiss((data: { requestId: string }) => {
      const item = pendingApprovals.value.find(a => a.requestId === data.requestId)
      if (item?.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
      pendingApprovals.value = pendingApprovals.value.filter(a => a.requestId !== data.requestId)
    })
  }

  // Register approval listener globally (once per app lifecycle)
  setupApprovalListener()

  async function fetchMessages() {
    if (!sessionId.value) return
    try {
      const { data } = await api.get(`/sessions/${sessionId.value}/messages`)
      sessionStore.setMessages(sessionId.value, mapApiMessagesToChat(data || []))
    } catch {
      // session might not exist yet
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

    // Get STS token from backend
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

  async function sendMessage(text: string, files?: File[]) {
    if ((!text && (!files || files.length === 0)) || sending.value) return

    sending.value = true
    startedAt.value = new Date().toISOString()

    // Upload images to OSS
    const imageUrls = await uploadImages(files || [])

    // Ensure WS connection is established
    await connect()

    try {
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

        const sessionData = await sessionStore.createSession(
          agentId.value,
          executionMode.value,
          workspace.value || undefined
        )
        sessionId.value = sessionData.id
      }

      const sid = sessionId.value!
      // Track which session is sending (set AFTER session creation so ID is correct)
      sendingSessionId.value = sid

      // Clear previous turn's todos
      sessionStore.clearTodos(sid)

      // Update session title from first user message (when title is still the default agent name)
      if (text) {
        const currentSession = sessionStore.sessions.find(s => String(s.id) === String(sid))
        const defaultTitle = agentName.value || 'Agent'
        if (currentSession && (!currentSession.title || currentSession.title === defaultTitle)) {
          const title = text.length > 50 ? text.substring(0, 50) : text
          sessionStore.updateSession(sid, { title })
          api.patch(`/sessions/${sid}`, { title }).catch(() => {})
        }
      }

      // Add user message to store
      sessionStore.addUserMessage(sid, {
        id: `msg_${Date.now()}_user`,
        role: 'user',
        content: text,
        createdAt: new Date().toLocaleString(),
        images: imageUrls.length > 0 ? imageUrls : undefined
      })

      // Add empty assistant message
      sessionStore.addAssistantMessage(sid, {
        id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: '',
        createdAt: new Date().toLocaleString(),
        toolCalls: [],
        segments: []
      })

      // Subscribe to this session's events
      subscribe(sid)

      // Send message via WS
      const eventId = crypto.randomUUID()
      wsSendMessage(sid, text || '', eventId, imageUrls)

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
      // Remove empty assistant message if it was added
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) {
        messages.value.pop()
      }
      ElMessage.error(error?.message || 'Agent 执行中断')
      if (sessionId.value) {
        sessionStore.fetchSession(sessionId.value)
      }
    }
  }

  function stopExecution() {
    if (!sessionId.value) return
    cancelling.value = true
    wsCancel(sessionId.value)
    // Don't resolve callback or set sending=false here.
    // The server will send a CANCELLING session_status event,
    // which resolves the pending callback via routeEvent,
    // causing sendMessage to return and sending to become false naturally.
    // cancelling stays true until the server confirms CANCELLED phase.
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

    // 校验是否是最后一条用户消息
    const msgs = sessionStore.getMessages(sessionId.value)
    const lastUserMsg = [...msgs].reverse().find(m => m.role === 'user')
    if (!lastUserMsg || String(lastUserMsg.id) !== String(messageId)) {
      ElMessage.warning('只能编辑最后一条用户消息')
      return
    }

    // 乐观更新：截断后续消息，更新编辑内容
    sessionStore.truncateMessagesAfter(sessionId.value, messageId)
    sessionStore.updateMessageContent(sessionId.value, messageId, newContent, images.length > 0 ? images : undefined)

    // 添加空 assistant 占位消息
    const placeholderMsg: ChatMessage = {
      id: `msg_${Date.now()}_assistant`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toLocaleString(),
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
      sendEditMessage(sessionId.value, newContent, messageId, images)

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
      cancelling.value = false
      sending.value = false
      sendingSessionId.value = null
      if (sessionId.value && pendingCallbacks.has(sessionId.value)) {
        const cb = pendingCallbacks.get(sessionId.value)
        pendingCallbacks.delete(sessionId.value)
        cb?.resolve?.()
      }
      if (sessionId.value) {
        sessionStore.fetchSession(sessionId.value)
        // Re-fetch messages to replace streamed single-message with API-structured
        // messages, enabling round-based collapse in UI
        fetchMessages()
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
    const imageUrls = files.length > 0 ? await uploadImages(files) : []
    await connect()
    const eventId = crypto.randomUUID()
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

  function clearPendingApprovals() {
    for (const item of pendingApprovals.value) {
      if (item.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
    }
    pendingApprovals.value = []
  }

  function newSession() {
    if (sessionId.value) {
      sessionStore.clearQueueMessages(sessionId.value)
    }
    clearPendingApprovals()
    sending.value = false
    sessionId.value = null
    workspace.value = ''
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
    if (initialWorkspace) workspace.value = initialWorkspace
    sessionStore.setActiveSession(sessionIdVal)

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
      cancelling.value = false
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

  async function confirmApproval(requestId: string, approved: boolean) {
    const item = pendingApprovals.value.find(a => a.requestId === requestId)
    if (item?.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
    pendingApprovals.value = pendingApprovals.value.filter(a => a.requestId !== requestId)
    if (requestId && isElectron) {
      await (window as any).electronAPI.respondToolApproval(requestId, approved)
    }
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
    cancelling,
    sessionId,
    workspace,
    agentName,
    pendingApprovals,
    activities,
    todos,
    contextWindow,
    startedAt,
    sendMessage,
    sendMessageWithQueue,
    editAndResend,
    stopExecution,
    fetchMessages,
    newSession,
    restoreSession,
    confirmApproval,
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
