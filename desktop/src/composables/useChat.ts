import { ref, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useSSE, type ToolCallStartData, type ToolCallResultData, type ActivityData } from './useSSE'
import { useSessionStore } from '../stores/session'

export interface FileAttachment {
  id: string
  name: string
  originalName?: string
}

export interface ToolCall {
  id: string
  name: string
  input?: Record<string, any>
  result?: string
  summary?: string
  status: 'pending' | 'running' | 'success' | 'error'
  isExpanded: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  files?: FileAttachment[]
  toolCalls?: ToolCall[]
}

/** 后端存 USER/ASSISTANT，前端 UI 使用小写 role */
export function normalizeMessageRole(role: string): ChatMessage['role'] {
  const r = (role || '').toLowerCase()
  if (r === 'user' || r === 'assistant' || r === 'system') return r
  return 'assistant'
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

  // Bash confirmation
  const pendingBashCommand = ref('')
  let pendingBashResolve: ((approved: boolean) => void) | null = null

  const isElectron = typeof window !== 'undefined' && (window as any).electronAPI

  // SSE composable — created lazily
  let sse: ReturnType<typeof useSSE> | null = null

  function createSSE() {
    if (!sessionId.value) return
    sse = useSSE({
      sessionId: sessionId.value,
      onContentDelta(delta) {
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg && normalizeMessageRole(lastMsg.role) === 'assistant') {
          lastMsg.content += delta
        }
      },
      onToolCallStart(data: ToolCallStartData) {
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg && normalizeMessageRole(lastMsg.role) === 'assistant') {
          if (!lastMsg.toolCalls) lastMsg.toolCalls = []
          lastMsg.toolCalls.push({
            id: data.call_id,
            name: data.tool_name,
            input: data.tool_input,
            status: 'running',
            isExpanded: true
          })
        }
      },
      onToolCallResult(data: ToolCallResultData) {
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg?.toolCalls) {
          const call = lastMsg.toolCalls.find(c => c.id === data.call_id)
          if (call) {
            call.result = data.result
            call.status = data.status
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
      onMessageEnd() {
        sending.value = false
      },
      onError() {
        sending.value = false
      }
    })
  }

  async function fetchMessages() {
    if (!sessionId.value) return
    try {
      const { data } = await api.get(`/sessions/${sessionId.value}/messages`)
      messages.value = (data || []).map((m: any) => ({
        ...m,
        id: String(m.id ?? `msg_${Date.now()}_${Math.random()}`),
        role: normalizeMessageRole(m.role),
        toolCalls: m.toolCalls || []
      }))
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

  async function connectLocalWebSocket(sessionIdVal: string, token: string): Promise<void> {
    if (!isElectron) throw new Error('Not running in Electron')

    const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api'
    const wsBase = apiBase.replace(/^http/, 'ws').replace(/\/api$/, '') + '/api'

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
        if (!data.connected) {
          ElMessage.warning('本地执行连接已断开，正在重连...')
        }
      })

      ;(window as any).electronAPI.connectLocalSession(sessionIdVal, token, wsBase)
    })
  }

  async function sendMessage(text: string, files?: File[]) {
    if ((!text && (!files || files.length === 0)) || sending.value) return

    // For LOCAL mode, ensure workspace
    if (executionMode.value === 'LOCAL' && isElectron) {
      if (!workspace.value) {
        const dir = await (window as any).electronAPI.selectDirectory()
        if (dir) workspace.value = dir
        else return
      }
    }

    sending.value = true
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
      // Create session if needed
      if (!sessionId.value) {
        const sessionData = await sessionStore.createSession(
          agentId.value,
          executionMode.value,
          workspace.value || undefined
        )
        sessionId.value = sessionData.id

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
        toolCalls: []
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
    if (executionMode.value === 'LOCAL' && isElectron) {
      ;(window as any).electronAPI.disconnectLocalSession()
      wsConnected.value = false
    }
    sessionId.value = null
    workspace.value = ''
    messages.value = []
    activities.value = []
    sessionStore.setActiveSession(null)
  }

  function restoreSession(sessionIdVal: string, mode: string) {
    sessionId.value = sessionIdVal
    executionMode.value = mode
    sessionStore.setActiveSession(sessionIdVal)
    fetchMessages()

    // Reconnect WebSocket for LOCAL mode
    if (mode === 'LOCAL' && isElectron) {
      const token = localStorage.getItem('token') || ''
      connectLocalWebSocket(sessionIdVal, token).catch(() => {
        ElMessage.warning('本地客户端连接失败，请检查桌面应用')
      })
    }
  }

  function confirmBash(approved: boolean) {
    pendingBashCommand.value = ''
    if (pendingBashResolve) {
      pendingBashResolve(approved)
      pendingBashResolve = null
    }
  }

  function cleanup() {
    sse?.stop()
    if (executionMode.value === 'LOCAL' && isElectron) {
      ;(window as any).electronAPI.disconnectLocalSession()
      ;(window as any).electronAPI.removeWsConnectionChangeListener()
      ;(window as any).electronAPI.removeToolRequestListener()
    }
  }

  return {
    messages,
    sending,
    sessionId,
    wsConnected,
    workspace,
    agentName,
    pendingBashCommand,
    activities,
    sendMessage,
    fetchMessages,
    newSession,
    restoreSession,
    confirmBash,
    cleanup
  }
}
