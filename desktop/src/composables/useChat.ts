import { ref, computed, watch, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useSessionStore } from '../stores/session'
import { useStreamWS } from './useStreamWS'
import { mapApiMessagesToChat } from '../utils/chatMessage'
import type { ChatMessage, ApprovalItem } from '../types/chat'
import { waitForSessionTurn, hasPendingTurn, onTurnSettled } from '../domain/session/turnTracker'
import { isExecutingPhase, isActivePhase } from '../domain/session/phase'

export type {
  ChatMessage,
  FileAttachment,
  MessageSegment,
  ToolCall,
  TodoItem
} from '../types/chat'
export { normalizeMessageRole } from '../types/chat'

import { uploadToOss, type StsToken } from '../utils/ossUpload'

// Module-level flag to ensure IPC listeners are registered only once
let approvalListenerSetup = false

export function useChat(agentId: Ref<string>, executionMode: Ref<string>) {
  const sessionStore = useSessionStore()
  const { connect, subscribe, unsubscribe, sendMessage: wsSendMessage, sendEditMessage, cancel: wsCancel, enqueueMessage: wsEnqueueMessage, insertMessage: wsInsertMessage, deleteQueueMessage: wsDeleteQueueMessage, reorderQueueMessage: wsReorderQueueMessage } = useStreamWS()

  const localPendingSessionId = ref<string | null>(null)
  const localCancellingSessionId = ref<string | null>(null)
  const sessionId = ref<string | null>(null)
  const workspace = ref('')
  const agentName = ref('Agent')
  const startedAt = ref<string | null>(null)

  // Tool approval queue — supports multiple concurrent approvals
  const pendingApprovals = ref<ApprovalItem[]>([])

  const isElectron = typeof window !== 'undefined' && (window as any).electronAPI

  // Derived state — phase is the single source of truth from the server.
  // localPendingSessionId covers the window between "user clicked send" and "server returned RUNNING".
  const activePhase = computed(() => sessionStore.activeSession?.phase ?? 'IDLE')

  const sending = computed(() => {
    const activeId = sessionStore.activeSessionId
    return isExecutingPhase(activePhase.value) ||
      (!!activeId && localPendingSessionId.value === String(activeId))
  })

  const cancelling = computed(() => {
    const activeId = sessionStore.activeSessionId
    return activePhase.value === 'CANCELLING' ||
      (!!activeId && localCancellingSessionId.value === String(activeId))
  })

  const isActive = computed(() => isActivePhase(activePhase.value))

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

  /**
   * Shared helper: connect, subscribe, await turn completion, handle duration + error.
   * Callers handle session creation, message setup, and localPendingSessionId.
   */
  async function executeWithCompletion(
    action: (eventId: string) => void,
    options?: { errorMessage?: string }
  ) {
    const sid = sessionId.value
    if (!sid) return

    startedAt.value = new Date().toISOString()
    await connect()
    subscribe(sid)
    const eventId = crypto.randomUUID()

    try {
      action(eventId)
      await waitForSessionTurn(sid, eventId)

      // localPendingSessionId is cleared by onTurnSettled callback
      if (startedAt.value) {
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.durationMs = Date.now() - new Date(startedAt.value).getTime()
        }
        startedAt.value = null
      }
    } catch (error: any) {
      // Fallback cleanup — onTurnSettled handles the normal case
      if (localPendingSessionId.value === sid || localPendingSessionId.value === '__creating__') {
        localPendingSessionId.value = null
      }
      // Remove empty assistant message if it was added
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) {
        messages.value.pop()
      }
      ElMessage.error(options?.errorMessage || error?.message || '执行中断')
    }
  }

  async function sendMessage(text: string, files?: File[]) {
    if ((!text && (!files || files.length === 0)) || sending.value) return

    // Set local pending before any async work to prevent duplicate submissions
    localPendingSessionId.value = sessionId.value || '__creating__'

    try {
      // Upload images to OSS
      const imageUrls = await uploadImages(files || [])

      // Ensure WS connection is established
      await connect()

      // Create session if needed
      if (!sessionId.value) {
        if (executionMode.value === 'LOCAL' && isElectron && !workspace.value) {
          const dir = await (window as any).electronAPI.selectDirectory()
          if (dir) workspace.value = dir
          else {
            localPendingSessionId.value = null
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
      localPendingSessionId.value = sid

      // Clear previous turn's todos
      sessionStore.clearTodos(sid)

      // Update session title from first user message
      if (text) {
        const currentSession = sessionStore.sessions.find(s => String(s.id) === String(sid))
        const defaultTitle = agentName.value || 'Agent'
        if (currentSession && (!currentSession.title || currentSession.title === defaultTitle)) {
          const title = text.length > 50 ? text.substring(0, 50) : text
          sessionStore.updateSession(sid, { title })
          api.patch(`/sessions/${sid}`, { title }).catch(() => {})
        }
      }

      // Add optimistic messages
      sessionStore.addUserMessage(sid, {
        id: `msg_${Date.now()}_user`,
        role: 'user',
        content: text,
        createdAt: new Date().toLocaleString(),
        images: imageUrls.length > 0 ? imageUrls : undefined
      })
      sessionStore.addAssistantMessage(sid, {
        id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: '',
        createdAt: new Date().toLocaleString(),
        toolCalls: [],
        segments: []
      })

      subscribe(sid)

      await executeWithCompletion((eventId) => {
        wsSendMessage(sid, text || '', eventId, imageUrls)
      })

      // Refresh session to pick up server-generated title/summary
      if (sessionId.value) {
        sessionStore.fetchSession(sessionId.value)
        fetchMessages()
      }
    } catch (error: any) {
      // Safety net: ensure localPendingSessionId is always cleared on failure.
      // executeWithCompletion has its own catch, but errors before it (connect,
      // uploadImages, createSession) would leave localPendingSessionId set,
      // making `sending` permanently true and blocking all subsequent messages.
      if (localPendingSessionId.value) {
        localPendingSessionId.value = null
      }
      // Remove empty assistant placeholder if it was added
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) {
        messages.value.pop()
      }
      ElMessage.error(error?.message || '消息发送失败')
    }
  }

  function stopExecution() {
    if (!sessionId.value) {
      // Session still being created (__creating__) — just clear pending so UI unlocks
      localPendingSessionId.value = null
      return
    }
    localCancellingSessionId.value = sessionId.value
    wsCancel(sessionId.value)
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

    localPendingSessionId.value = sessionId.value

    await executeWithCompletion(() => {
      sendEditMessage(sessionId.value!, newContent, messageId, images)
    }, {
      errorMessage: '编辑重新发送失败'
    })

    // Refresh session
    if (sessionId.value) {
      sessionStore.fetchSession(sessionId.value)
      fetchMessages()
    }
  }

  // Watch phase changes for state sync.
  // This watcher fires both on actual phase transitions AND when activeSession
  // changes (e.g. null → session). The latter triggers with whatever phase the
  // session currently has (often IDLE), which would incorrectly reset sending.
  // Guard: only handle transitions where oldPhase is defined (real phase change).
  // Lightweight phase watcher — only handles queue auto-consume.
  // Terminal handling is done by turnTracker (routeEvent calls resolveSessionTurn).
  // sending/cancelling are computed from phase + localPendingSessionId.
  watch(() => sessionStore.activeSession?.phase, (phase, oldPhase) => {
    if (oldPhase === undefined) return  // session switch, not a phase change
    if (phase === oldPhase) return      // no change

    // Queue auto-consume: phase jumps COMPLETED→RUNNING when backend starts
    // the next queued message. Register a new pending turn so the completion
    // is properly tracked.
    if ((phase === 'RUNNING' || phase === 'WAITING_APPROVAL') &&
        sessionId.value && !hasPendingTurn(sessionId.value)) {
      waitForSessionTurn(sessionId.value)
    }
  })

  // Clean up local pending/cancelling state when a turn settles
  const disposeTurnSettled = onTurnSettled((sid) => {
    if (localPendingSessionId.value === sid) localPendingSessionId.value = null
    if (localCancellingSessionId.value === sid) localCancellingSessionId.value = null
    // Refresh active session messages after turn completes
    if (sid === sessionStore.activeSessionId) {
      sessionStore.fetchSession(sid)
      fetchMessages()
    }
  })

  // --- Message Queue ---

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
    localPendingSessionId.value = null
    localCancellingSessionId.value = null
    sessionId.value = null
    workspace.value = ''
    agentName.value = 'Agent'
    sessionStore.setActiveSession(null)
  }

  async function restoreSession(sessionIdVal: string, mode: string, initialWorkspace?: string, preserveLiveMessages = false) {
    // Unsubscribe from previous session
    if (sessionId.value && sessionId.value !== sessionIdVal) {
      unsubscribe(sessionId.value)
    }

    sessionId.value = sessionIdVal
    executionMode.value = mode
    if (initialWorkspace) workspace.value = initialWorkspace
    sessionStore.setActiveSession(sessionIdVal)

    // Restore pending turn tracking for active sessions.
    // Covers queue auto-consume: when one turn completes and the backend
    // automatically starts the next queued message, phase goes COMPLETED→RUNNING.
    const phase = sessionStore.activeSession?.phase
    if (isActivePhase(phase) && !hasPendingTurn(sessionIdVal)) {
      waitForSessionTurn(sessionIdVal)
    }

    // sending/cancelling are computed from activePhase + localPending/CancellingSessionId.
    // No manual sync needed — computed properties derive automatically.

    // Ensure WS connection is established before subscribing
    try {
      await connect()
    } catch {
      // WS connect failed (e.g. no token) — subscribe will be retried on reconnect
    }
    subscribe(sessionIdVal)

    if (!preserveLiveMessages) {
      fetchMessages()
    }
    fetchTodos()
    fetchQueue()
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
    disposeTurnSettled()
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
    localPendingSessionId
  }
}
