import { computed, ref, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useSessionStore } from '../stores/session'
import { useStreamWS } from './useStreamWS'
import { mapApiMessagesToChat } from '../utils/chatMessage'
import { uploadToOss, type StsToken } from '../utils/ossUpload'
import { createAssistantPlaceholder, createOptimisticUserMessage } from '../domain/session/messageFactory'
import { isActivePhase } from '../domain/session/phase'
import { abortPendingTurn, waitForSessionTurn } from '../domain/session/turnTracker'
import { respondToolApproval } from './useLocalToolBridge'

export type {
  ChatMessage,
  FileAttachment,
  MessageSegment,
  ToolCall,
  TodoItem
} from '../types/chat'
export { normalizeMessageRole } from '../types/chat'

export function useChat(agentId: Ref<string>, executionMode: Ref<string>) {
  const sessionStore = useSessionStore()
  const {
    connect,
    subscribe,
    unsubscribe,
    sendMessage: wsSendMessage,
    sendEditMessage,
    cancel: wsCancel,
    enqueueMessage: wsEnqueueMessage,
    insertMessage: wsInsertMessage,
    deleteQueueMessage: wsDeleteQueueMessage,
    reorderQueueMessage: wsReorderQueueMessage
  } = useStreamWS()

  const localPendingSessionId = ref<string | null>(null)
  const localCancellingSessionId = ref<string | null>(null)
  const switchingSession = ref(false)
  const sessionId = ref<string | null>(null)
  const workspace = ref('')
  const agentName = ref('Agent')
  const startedAt = ref<string | null>(null)
  const refreshingMessages = ref(false)

  const isElectron = typeof window !== 'undefined' && (window as any).electronAPI

  const messages = computed(() => sessionStore.activeMessages)
  const todos = computed(() => sessionStore.activeTodos)
  const activities = computed(() => sessionStore.activeActivities)
  const contextWindow = computed(() => sessionStore.activeContextWindow)
  const pendingApprovals = computed(() => sessionStore.activeApprovalItems)
  const serverPhase = computed(() => sessionStore.activeSession?.phase)
  const effectivePhase = computed(() => {
    const phase = serverPhase.value
    if (localPendingSessionId.value === sessionStore.activeSessionId && !isActivePhase(phase)) {
      return 'RUNNING'
    }
    return phase || 'IDLE'
  })
  const sending = computed(() =>
    isActivePhase(serverPhase.value) || localPendingSessionId.value === sessionStore.activeSessionId
  )
  const cancelling = computed(() =>
    serverPhase.value === 'CANCELLING' || localCancellingSessionId.value === sessionStore.activeSessionId
  )
  const isActive = computed(() => isActivePhase(serverPhase.value))

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

  async function fetchQueue() {
    if (!sessionId.value) return
    try {
      const { data } = await api.get(`/sessions/${sessionId.value}/queue`)
      sessionStore.setQueueMessages(sessionId.value, data || [])
    } catch {
      // ignore
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
      await fetchTodos()
    } catch {
      // ignore
    }
  }

  async function uploadImages(files: File[]): Promise<string[]> {
    if (files.length === 0) return []

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

  async function refreshAfterCompletion() {
    if (!sessionId.value) return
    refreshingMessages.value = true
    try {
      await sessionStore.fetchSession(sessionId.value)
      await fetchMessages()
    } finally {
      refreshingMessages.value = false
    }
  }

  async function executeWithCompletion(sid: string, action: (eventId: string) => void, errorMessage: string) {
    startedAt.value = new Date().toISOString()
    localPendingSessionId.value = sid

    try {
      await connect()
      subscribe(sid)
      const eventId = crypto.randomUUID()
      const turnPromise = waitForSessionTurn(sid, eventId)
      action(eventId)
      await turnPromise

      if (startedAt.value) {
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.durationMs = Date.now() - new Date(startedAt.value).getTime()
        }
        startedAt.value = null
      }

      await refreshAfterCompletion()
    } catch (error: any) {
      if (error?.name === 'AbortError') return
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) {
        messages.value.pop()
      }
      ElMessage.error(error?.message || errorMessage)
      if (sessionId.value) {
        await sessionStore.fetchSession(sessionId.value)
      }
    } finally {
      if (localPendingSessionId.value === sid) localPendingSessionId.value = null
      if (localCancellingSessionId.value === sid) localCancellingSessionId.value = null
      startedAt.value = null
    }
  }

  async function ensureSession(): Promise<string | null> {
    if (sessionId.value) return sessionId.value

    if (executionMode.value === 'LOCAL' && isElectron && !workspace.value) {
      const dir = await (window as any).electronAPI.selectDirectory()
      if (dir) workspace.value = dir
      else return null
    }

    const sessionData = await sessionStore.createSession(
      agentId.value,
      executionMode.value,
      workspace.value || undefined
    )
    sessionId.value = String(sessionData.id)
    sessionStore.setActiveSession(sessionId.value)
    return sessionId.value
  }

  async function sendMessage(text: string, files?: File[]) {
    if ((!text && (!files || files.length === 0)) || sending.value) return

    try {
      const imageUrls = await uploadImages(files || [])
      const sid = await ensureSession()
      if (!sid) return

      sessionStore.clearTodos(sid)

      if (text) {
        const currentSession = sessionStore.sessions.find(s => String(s.id) === String(sid))
        const defaultTitle = agentName.value || 'Agent'
        if (currentSession && (!currentSession.title || currentSession.title === defaultTitle)) {
          const title = text.length > 50 ? text.substring(0, 50) : text
          sessionStore.updateSession(sid, { title })
          api.patch(`/sessions/${sid}`, { title }).catch(() => {})
        }
      }

      sessionStore.addUserMessage(sid, createOptimisticUserMessage(text, imageUrls))
      sessionStore.addAssistantMessage(sid, createAssistantPlaceholder())

      await executeWithCompletion(
        sid,
        (eventId) => wsSendMessage(sid, text || '', eventId, imageUrls),
        'Agent 执行中断'
      )
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        ElMessage.error(error?.message || 'Agent 执行中断')
      }
      if (localPendingSessionId.value === sessionId.value) localPendingSessionId.value = null
    }
  }

  function stopExecution() {
    if (!sessionId.value) return
    localCancellingSessionId.value = sessionId.value
    wsCancel(sessionId.value)
  }

  async function editAndResend(messageId: string, newContent: string, images: string[] = []) {
    if (!sessionId.value) return
    if (sending.value) {
      ElMessage.warning('会话正在执行中，无法编辑')
      return
    }

    const sid = sessionId.value
    const msgs = sessionStore.getMessages(sid)
    const lastUserMsg = [...msgs].reverse().find(m => m.role === 'user')
    if (!lastUserMsg || String(lastUserMsg.id) !== String(messageId)) {
      ElMessage.warning('只能编辑最后一条用户消息')
      return
    }

    sessionStore.truncateMessagesAfter(sid, messageId)
    sessionStore.updateMessageContent(sid, messageId, newContent, images.length > 0 ? images : undefined)
    sessionStore.appendMessage(sid, createAssistantPlaceholder())

    await executeWithCompletion(
      sid,
      () => sendEditMessage(sid, newContent, messageId, images),
      '编辑重新发送失败'
    )
  }

  async function sendMessageWithQueue(text: string, files: File[]) {
    if (isActive.value) {
      await enqueueMessage(text, files)
    } else {
      await sendMessage(text, files)
    }
  }

  async function enqueueMessage(text: string, files: File[]) {
    if (!sessionId.value) return
    const imageUrls = files.length > 0 ? await uploadImages(files) : []
    await connect()
    const eventId = crypto.randomUUID()
    wsEnqueueMessage(sessionId.value, text, eventId, imageUrls)
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

  function newSession() {
    if (sessionId.value) {
      sessionStore.clearQueueMessages(sessionId.value)
    }
    if (localPendingSessionId.value) abortPendingTurn(localPendingSessionId.value)
    localPendingSessionId.value = null
    localCancellingSessionId.value = null
    sessionId.value = null
    workspace.value = ''
    agentName.value = 'Agent'
    sessionStore.setActiveSession(null)
  }

  async function restoreSession(sessionIdVal: string, mode: string, initialWorkspace?: string) {
    switchingSession.value = true

    try {
      if (sessionId.value && sessionId.value !== sessionIdVal) {
        unsubscribe(sessionId.value)
      }

      sessionId.value = sessionIdVal
      executionMode.value = mode
      if (initialWorkspace) workspace.value = initialWorkspace
      sessionStore.setActiveSession(sessionIdVal)

      try {
        await connect()
      } catch {
        // WS connect failed (e.g. no token) — subscribe will be retried on reconnect
      }
      subscribe(sessionIdVal)

      await Promise.all([
        shouldPreserveLiveMessages(sessionIdVal) ? Promise.resolve() : fetchMessages(),
        fetchTodos(),
        fetchQueue()
      ])
    } finally {
      switchingSession.value = false
    }
  }

  function shouldPreserveLiveMessages(sid: string): boolean {
    const msgs = sessionStore.getMessages(sid)
    const last = msgs[msgs.length - 1]
    const hasPlaceholder = last?.role === 'assistant' && !last.content && !(last.toolCalls?.length)
    const isLocalPending = localPendingSessionId.value === sid
    const isStreaming = sessionStore.activeSessionId === sid && (sessionStore.activeStreaming || sessionStore.activeThinking)
    return isLocalPending || (hasPlaceholder && isActivePhase(sessionStore.activeSession?.phase) && isStreaming)
  }

  async function confirmApproval(requestId: string, approved: boolean) {
    const item = sessionStore.getApproval(requestId)
    sessionStore.removeApproval(requestId)
    try {
      await respondToolApproval(item, approved)
    } catch (error: any) {
      if (item) sessionStore.addApproval(item)
      ElMessage.error(error?.message || '审批响应失败')
    }
  }

  function cleanup() {
    if (sessionId.value) {
      unsubscribe(sessionId.value)
    }
    if (localPendingSessionId.value) {
      abortPendingTurn(localPendingSessionId.value)
      localPendingSessionId.value = null
    }
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
    effectivePhase,
    refreshingMessages,
    localPendingSessionId,
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
    isActive,
    insertQueueMessage,
    deleteQueueMessage,
    reorderQueueMessage,
    fetchQueue,
    switchingSession
  }
}
