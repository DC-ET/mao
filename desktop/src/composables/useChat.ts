import { ref, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useSSE, type ToolCallStartData, type ToolCallResultData, type ActivityData } from './useSSE'
import { useSessionStore, type TaskPhase } from '../stores/session'
import {
  appendTextDelta,
  appendToolCallStart,
  mapApiMessagesToChat
} from '../utils/chatMessage'

export type {
  ChatMessage,
  FileAttachment,
  MessageSegment,
  ToolCall,
  TodoItem
} from '../types/chat'
export { normalizeMessageRole } from '../types/chat'

import type { ChatMessage, FileAttachment, ToolCall, TodoItem, ContextWindowInfo } from '../types/chat'

export interface BashApprovalItem {
  requestId: string
  command: string
}
import { normalizeMessageRole } from '../types/chat'

function inferResultStatus(result: string): ToolCall['status'] {
  const text = result || ''
  // Try JSON-based detection: {"error": ...} or {"exit_code": non-zero}
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj === 'object') {
      if (obj.error) return 'error'
      if (typeof obj.exit_code === 'number' && obj.exit_code !== 0) return 'error'
    }
  } catch {
    // Not JSON — fall back to plain text heuristic
  }
  if (text.startsWith('Tool execution failed')) return 'error'
  return 'success'
}

export function useChat(agentId: Ref<string>, executionMode: Ref<string>) {
  const sessionStore = useSessionStore()

  const messages = ref<ChatMessage[]>([])
  const sending = ref(false)
  const sessionId = ref<string | null>(null)
  const wsConnected = ref(false)
  const workspace = ref('')
  const agentName = ref('Agent')
  const activities = ref<ActivityData[]>([])
  const todos = ref<TodoItem[]>([])
  const contextWindow = ref<ContextWindowInfo | null>(null)
  const startedAt = ref<string | null>(null)

  // Bash approval queue — supports multiple concurrent approvals
  const pendingBashApprovals = ref<BashApprovalItem[]>([])
  let bashApprovalListenerSetup = false

  const isElectron = typeof window !== 'undefined' && (window as any).electronAPI

  function setupBashApprovalListener() {
    if (!isElectron || bashApprovalListenerSetup) return
    bashApprovalListenerSetup = true

    ;(window as any).electronAPI.onBashApprovalRequest((data: { requestId: string; command: string }) => {
      // Avoid duplicates from re-delivery
      if (!pendingBashApprovals.value.some(a => a.requestId === data.requestId)) {
        pendingBashApprovals.value.push({ requestId: data.requestId, command: data.command })
      }
    })

    ;(window as any).electronAPI.onBashApprovalDismiss((data: { requestId: string }) => {
      pendingBashApprovals.value = pendingBashApprovals.value.filter(a => a.requestId !== data.requestId)
    })
  }

  // SSE composable — created lazily
  let sse: ReturnType<typeof useSSE> | null = null

  function createSSE() {
    if (!sessionId.value) return
    sse = useSSE({
      sessionId: sessionId.value,
      onContentDelta(delta) {
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg && normalizeMessageRole(lastMsg.role) === 'assistant') {
          appendTextDelta(lastMsg, delta)
        }
      },
      onToolCallStart(data: ToolCallStartData) {
        // Skip todo tool calls — they are displayed in the sidebar progress panel
        if (data.tool_name === 'todo') return
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg && normalizeMessageRole(lastMsg.role) === 'assistant') {
          appendToolCallStart(lastMsg, {
            id: data.call_id,
            name: data.tool_name,
            input: data.tool_input,
            status: 'running',
            isExpanded: false
          })
        }
      },
      onToolCallResult(data: ToolCallResultData) {
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg?.toolCalls) {
          const call = lastMsg.toolCalls.find(c => c.id === data.call_id)
          if (call) {
            call.result = data.result
            call.status = data.status || inferResultStatus(data.result)
            call.isExpanded = false
            if (data.summary) call.summary = data.summary
          }
        }
      },
      onActivity(data: ActivityData) {
        activities.value.push(data)
        // Keep only last 100 activities
        if (activities.value.length > 100) {
          activities.value = activities.value.slice(-100)
        }
      },
      onTodoUpdated(data: { todos: TodoItem[] }) {
        todos.value = data.todos || []
      },
      onContextWindow(data: ContextWindowInfo) {
        contextWindow.value = data
      },
      onSessionStatus(data: { phase: string }) {
        if (sessionId.value) {
          sessionStore.updateSessionPhase(sessionId.value, data.phase as TaskPhase)
        }
      },
      onSessionListUpdate(data: { sessionId: string; phase: string }) {
        // Update other sessions' phase in the sidebar list in real-time
        if (data.sessionId !== sessionId.value) {
          sessionStore.updateSessionPhase(data.sessionId, data.phase as TaskPhase)
        }
      },
      onMessageEnd() {
        sending.value = false
        // Set duration for the last assistant message
        if (startedAt.value) {
          const lastMsg = messages.value[messages.value.length - 1]
          if (lastMsg && normalizeMessageRole(lastMsg.role) === 'assistant') {
            lastMsg.durationMs = Date.now() - new Date(startedAt.value).getTime()
          }
          startedAt.value = null
        }
        // Refresh session to pick up server-generated title/summary
        if (sessionId.value) {
          sessionStore.fetchSession(sessionId.value)
        }
      },
      onError(message: string) {
        sending.value = false
        // Remove empty assistant bubble left by the failed stream
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) {
          messages.value.pop()
        }
        ElMessage.error(message || 'Agent 执行中断')
        // Refresh session to pick up FAILED phase from server
        if (sessionId.value) {
          sessionStore.fetchSession(sessionId.value)
        }
      }
    })
  }

  async function fetchMessages() {
    if (!sessionId.value) return
    try {
      const { data } = await api.get(`/sessions/${sessionId.value}/messages`)
      messages.value = mapApiMessagesToChat(data || [])
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

  let explicitDisconnect = false

  async function connectLocalWebSocket(sessionIdVal: string, token: string): Promise<void> {
    if (!isElectron) throw new Error('Not running in Electron')

    const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api'
    const wsBase = apiBase.replace(/^http/, 'ws').replace(/\/api$/, '') + '/api'

    // Remove previous listener to avoid accumulation
    ;(window as any).electronAPI.removeWsConnectionChangeListener()

    return new Promise((resolve, reject) => {
      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          reject(new Error('WebSocket connection timeout'))
        }
      }, 10000)

      ;(window as any).electronAPI.onWsConnectionChange((data: any) => {
        wsConnected.value = data.connected
        if (data.workspace) workspace.value = data.workspace
        if (data.connected && !resolved) {
          resolved = true
          clearTimeout(timeout)
          resolve()
        }
        if (!data.connected && !explicitDisconnect) {
          ElMessage.warning('本地执行连接已断开，正在重连...')
        }
      })

      setupBashApprovalListener()
      explicitDisconnect = false
      ;(window as any).electronAPI.connectLocalSession(sessionIdVal, token, wsBase)
    })
  }

  async function sendMessage(text: string, files?: File[]) {
    if ((!text && (!files || files.length === 0)) || sending.value) return

    sending.value = true
    activities.value = []
    startedAt.value = new Date().toISOString()
    const uploadedFiles = await uploadFiles(files || [])

    // Build display content
    let displayContent = text
    if (uploadedFiles.length > 0) {
      const fileLinks = uploadedFiles.map(f => `[附件: ${f.originalName || f.name}]`).join(' ')
      displayContent = displayContent ? `${displayContent}\n${fileLinks}` : fileLinks
    }

    // Add user message
    messages.value.push({
      id: `msg_${Date.now()}_user`,
      role: 'user',
      content: displayContent,
      createdAt: new Date().toLocaleString(),
      files: uploadedFiles
    })

    try {
      // Create session if needed (e.g. "new task" from within TaskView)
      if (!sessionId.value) {
        // Ensure workspace is set for LOCAL mode before creating session
        if (executionMode.value === 'LOCAL' && isElectron && !workspace.value) {
          const dir = await (window as any).electronAPI.selectDirectory()
          if (dir) workspace.value = dir
          else {
            sending.value = false
            messages.value.pop()
            return
          }
        }

        const sessionData = await sessionStore.createSession(
          agentId.value,
          executionMode.value,
          workspace.value || undefined
        )
        sessionId.value = sessionData.id

        // Optimistic title: show user's first message in sidebar immediately
        if (text) {
          sessionStore.updateSession(sessionData.id, {
            title: text.length > 50 ? text.substring(0, 50) : text
          })
        }

        // Connect WebSocket for LOCAL mode
        if (executionMode.value === 'LOCAL') {
          const token = localStorage.getItem('token') || ''
          try {
            await connectLocalWebSocket(sessionData.id, token)
          } catch (e: any) {
            ElMessage.error('本地客户端连接失败: ' + e.message)
            sending.value = false
            return
          }
        }
      }

      // Add empty assistant message
      messages.value.push({
        id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: '',
        createdAt: new Date().toLocaleString(),
        toolCalls: [],
        segments: []
      })

      // Build payload
      const payload: any = { content: text || '(文件附件)' }
      if (uploadedFiles.length > 0) {
        payload.fileIds = uploadedFiles.map(f => f.id)
      }

      // Send message
      const response = await api.post(`/sessions/${sessionId.value}/messages`, payload)

      // Start SSE stream
      createSSE()
      sse!.start(response.data.eventId)
    } catch (error: any) {
      sending.value = false
      // Remove empty assistant message if it was added
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg?.role === 'assistant' && !lastMsg.content) {
        messages.value.pop()
      }
      if (error?.response?.data?.message) {
        ElMessage.error(error.response.data.message)
      }
    }
  }

  function newSession() {
    // Stop SSE stream and disconnect WebSocket
    cleanup()
    // Reset execution state
    sending.value = false
    sessionId.value = null
    workspace.value = ''
    messages.value = []
    activities.value = []
    todos.value = []
    contextWindow.value = null
    agentName.value = 'Agent'
    sessionStore.setActiveSession(null)
  }

  async function fetchTodos() {
    if (!sessionId.value) return
    try {
      const { data } = await api.get(`/sessions/${sessionId.value}/todos`)
      todos.value = data || []
    } catch {
      // session might not exist yet
    }
  }

  function restoreSession(sessionIdVal: string, mode: string, initialWorkspace?: string) {
    sessionId.value = sessionIdVal
    executionMode.value = mode
    if (initialWorkspace) workspace.value = initialWorkspace
    sessionStore.setActiveSession(sessionIdVal)
    fetchMessages()
    fetchTodos()

    // Reconnect WebSocket for LOCAL mode
    if (mode === 'LOCAL' && isElectron) {
      setupBashApprovalListener()
      const token = localStorage.getItem('token') || ''
      connectLocalWebSocket(sessionIdVal, token).catch(() => {
        ElMessage.warning('本地客户端连接失败，请检查桌面应用')
      })
    }
  }

  async function confirmBash(requestId: string, approved: boolean) {
    pendingBashApprovals.value = pendingBashApprovals.value.filter(a => a.requestId !== requestId)
    if (requestId && isElectron) {
      await (window as any).electronAPI.respondBashApproval(requestId, approved)
    }
  }

  function cleanup() {
    sse?.stop()
    if (executionMode.value === 'LOCAL' && isElectron) {
      explicitDisconnect = true
      ;(window as any).electronAPI.disconnectLocalSession()
      ;(window as any).electronAPI.removeWsConnectionChangeListener()
      ;(window as any).electronAPI.removeBashApprovalRequestListener?.()
      ;(window as any).electronAPI.removeBashApprovalDismissListener?.()
      bashApprovalListenerSetup = false
    }
    pendingBashApprovals.value = []
  }

  return {
    messages,
    sending,
    sessionId,
    wsConnected,
    workspace,
    agentName,
    pendingBashApprovals,
    activities,
    todos,
    contextWindow,
    startedAt,
    sendMessage,
    fetchMessages,
    newSession,
    restoreSession,
    confirmBash,
    cleanup
  }
}
