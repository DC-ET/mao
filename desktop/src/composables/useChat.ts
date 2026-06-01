import { ref, computed, watch, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useSessionStore } from '../stores/session'
import { useStreamWS } from './useStreamWS'
import { mapApiMessagesToChat } from '../utils/chatMessage'

export type {
  ChatMessage,
  FileAttachment,
  MessageSegment,
  ToolCall,
  TodoItem
} from '../types/chat'
export { normalizeMessageRole } from '../types/chat'

import type { FileAttachment } from '../types/chat'

export interface BashApprovalItem {
  requestId: string
  command: string
  sessionId?: string
}

export function useChat(agentId: Ref<string>, executionMode: Ref<string>) {
  const sessionStore = useSessionStore()
  const { connect, subscribe, unsubscribe, sendMessage: wsSendMessage, cancel: wsCancel, pendingCallbacks } = useStreamWS()

  const sending = ref(false)
  const cancelling = ref(false)
  const sessionId = ref<string | null>(null)
  const workspace = ref('')
  const agentName = ref('Agent')
  const startedAt = ref<string | null>(null)

  // Bash approval queue — supports multiple concurrent approvals
  const pendingBashApprovals = ref<BashApprovalItem[]>([])
  let bashApprovalListenerSetup = false

  const isElectron = typeof window !== 'undefined' && (window as any).electronAPI

  // Computed refs from store — reactive to active session
  const messages = computed(() => sessionStore.activeMessages)
  const todos = computed(() => sessionStore.activeTodos)
  const activities = computed(() => sessionStore.activeActivities)
  const contextWindow = computed(() => sessionStore.activeContextWindow)

  function setupBashApprovalListener() {
    if (!isElectron || bashApprovalListenerSetup) return
    bashApprovalListenerSetup = true

    ;(window as any).electronAPI.onBashApprovalRequest((data: { requestId: string; command: string; sessionId?: number }) => {
      const sid = data.sessionId != null ? String(data.sessionId) : undefined
      if (!pendingBashApprovals.value.some(a => a.requestId === data.requestId)) {
        pendingBashApprovals.value.push({ requestId: data.requestId, command: data.command, sessionId: sid })
        if (sid) sessionStore.incrementPendingApproval(sid)
      }
    })

    ;(window as any).electronAPI.onBashApprovalDismiss((data: { requestId: string }) => {
      const item = pendingBashApprovals.value.find(a => a.requestId === data.requestId)
      if (item?.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
      pendingBashApprovals.value = pendingBashApprovals.value.filter(a => a.requestId !== data.requestId)
    })
  }

  // Register bash approval listener globally (once per app lifecycle)
  setupBashApprovalListener()

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

  async function uploadFiles(files: File[]): Promise<FileAttachment[]> {
    if (files.length === 0) return []
    const results: FileAttachment[] = []
    for (const file of files) {
      const formData = new FormData()
      formData.append('file', file)
      if (sessionId.value) {
        formData.append('sessionId', sessionId.value)
      }
      try {
        const { data } = await api.post('/files/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        })
        results.push(data)
      } catch {
        ElMessage.error(`文件 ${file.name} 上传失败`)
      }
    }
    return results
  }

  async function sendMessage(text: string, files?: File[]) {
    if ((!text && (!files || files.length === 0)) || sending.value) return

    sending.value = true
    startedAt.value = new Date().toISOString()
    const uploadedFiles = await uploadFiles(files || [])

    // Build display content
    let displayContent = text
    if (uploadedFiles.length > 0) {
      const fileLinks = uploadedFiles.map(f => `[附件: ${f.originalName || f.name}]`).join(' ')
      displayContent = displayContent ? `${displayContent}\n${fileLinks}` : fileLinks
    }

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

        if (text) {
          sessionStore.updateSession(sessionData.id, {
            title: text.length > 50 ? text.substring(0, 50) : text
          })
        }
      }

      const sid = sessionId.value!
      // Add user message to store
      sessionStore.addUserMessage(sid, {
        id: `msg_${Date.now()}_user`,
        role: 'user',
        content: displayContent,
        createdAt: new Date().toLocaleString(),
        files: uploadedFiles
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
      wsSendMessage(sid, text || '(文件附件)', eventId)

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

  // Watch for CANCELLED phase to clear cancelling flag
  watch(() => sessionStore.activeSession?.phase, (phase) => {
    if (phase === 'CANCELLED' || phase === 'COMPLETED' || phase === 'FAILED' || phase === 'IDLE') {
      cancelling.value = false
    }
  })

  function newSession() {
    if (sessionId.value) {
      unsubscribe(sessionId.value)
    }
    pendingBashApprovals.value = []
    sending.value = false
    sessionId.value = null
    workspace.value = ''
    agentName.value = 'Agent'
    sessionStore.setActiveSession(null)
  }

  function restoreSession(sessionIdVal: string, mode: string, initialWorkspace?: string) {
    // Unsubscribe from previous session
    if (sessionId.value && sessionId.value !== sessionIdVal) {
      unsubscribe(sessionId.value)
    }

    sessionId.value = sessionIdVal
    executionMode.value = mode
    if (initialWorkspace) workspace.value = initialWorkspace
    sessionStore.setActiveSession(sessionIdVal)

    // Subscribe to new session's events
    subscribe(sessionIdVal)

    fetchMessages()
    fetchTodos()
  }

  async function confirmBash(requestId: string, approved: boolean) {
    const item = pendingBashApprovals.value.find(a => a.requestId === requestId)
    if (item?.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
    pendingBashApprovals.value = pendingBashApprovals.value.filter(a => a.requestId !== requestId)
    if (requestId && isElectron) {
      await (window as any).electronAPI.respondBashApproval(requestId, approved)
    }
  }

  function cleanup() {
    if (sessionId.value) {
      unsubscribe(sessionId.value)
    }
    pendingBashApprovals.value = []
  }

  return {
    messages,
    sending,
    cancelling,
    sessionId,
    workspace,
    agentName,
    pendingBashApprovals,
    activities,
    todos,
    contextWindow,
    startedAt,
    sendMessage,
    stopExecution,
    fetchMessages,
    newSession,
    restoreSession,
    confirmBash,
    cleanup
  }
}
