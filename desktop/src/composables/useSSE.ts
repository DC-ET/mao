import { ref, onUnmounted } from 'vue'
import type { TodoItem, ContextWindowInfo } from '../types/chat'
import { showReloginDialog, doRefreshToken } from '../api'

export interface ToolCallStartData {
  tool_name: string
  tool_input?: Record<string, unknown>
  call_id: string
}

export interface ToolCallResultData {
  call_id: string
  result: string
  status: 'success' | 'error'
  summary?: string
}

export interface ActivityData {
  id?: number
  type: string
  target?: string
  summary: string
  status?: string
}

export interface SSEOptions {
  sessionId: string
  onContentDelta: (delta: string) => void
  onToolCallStart: (data: ToolCallStartData) => void
  onToolCallResult: (data: ToolCallResultData) => void
  onActivity?: (data: ActivityData) => void
  onTodoUpdated?: (data: { todos: TodoItem[] }) => void
  onSessionStatus?: (data: { phase: string }) => void
  onSessionListUpdate?: (data: { sessionId: string; phase: string }) => void
  onContextWindow?: (data: ContextWindowInfo) => void
  onMessageEnd: () => void
  onError: (message: string) => void
}

export function useSSE(options: SSEOptions) {
  let eventSource: EventSource | null = null
  const isConnected = ref(false)

  function start(eventId: string) {
    stop()

    const baseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api'
    const token = localStorage.getItem('token')
    const url = `${baseUrl}/v1/sessions/${options.sessionId}/stream?eventId=${eventId}&token=${token}`

    eventSource = new EventSource(url)
    isConnected.value = true

    eventSource.addEventListener('content_delta', (event) => {
      const data = JSON.parse(event.data)
      options.onContentDelta(data.delta)
    })

    eventSource.addEventListener('tool_call_start', (event) => {
      const data = JSON.parse(event.data)
      let toolInput: Record<string, unknown> | undefined
      const rawArgs = data.arguments ?? data.tool_input
      if (rawArgs != null) {
        if (typeof rawArgs === 'string') {
          try {
            toolInput = JSON.parse(rawArgs)
          } catch {
            toolInput = undefined
          }
        } else if (typeof rawArgs === 'object') {
          toolInput = rawArgs
        }
      }
      options.onToolCallStart({
        tool_name: data.tool_name,
        tool_input: toolInput,
        call_id: data.tool_call_id || data.call_id || `call_${Date.now()}`
      })
    })

    eventSource.addEventListener('tool_call_result', (event) => {
      const data = JSON.parse(event.data)
      options.onToolCallResult({
        call_id: data.tool_call_id || data.call_id,
        result: data.result || '',
        status: data.status || 'success',
        summary: data.summary
      })
    })

    eventSource.addEventListener('activity', (event) => {
      const data = JSON.parse(event.data)
      options.onActivity?.(data)
    })

    eventSource.addEventListener('todo_updated', (event) => {
      const data = JSON.parse(event.data)
      options.onTodoUpdated?.(data)
    })

    eventSource.addEventListener('session_status', (event) => {
      const data = JSON.parse(event.data)
      options.onSessionStatus?.(data)
    })

    eventSource.addEventListener('session_list_update', (event) => {
      const data = JSON.parse(event.data)
      options.onSessionListUpdate?.(data)
    })

    eventSource.addEventListener('context_window', (event) => {
      const data = JSON.parse(event.data)
      options.onContextWindow?.({
        estimated: data.estimated || 0,
        actual: data.actual || 0,
        maxTokens: data.maxTokens || 0
      })
    })

    eventSource.addEventListener('message_end', () => {
      isConnected.value = false
      options.onMessageEnd()
      stop()
    })

    eventSource.addEventListener('error', (event: any) => {
      isConnected.value = false
      let msg = 'Agent 执行中断'
      try {
        const data = JSON.parse(event.data)
        if (data?.message) msg = data.message
      } catch {}
      options.onError(msg)
      stop()
    })

    eventSource.onerror = async () => {
      isConnected.value = false
      try {
        await doRefreshToken()
        // Token refreshed — caller can reconnect with the new token
        options.onError('连接已断开，请重新发送消息')
      } catch {
        showReloginDialog()
      }
      stop()
    }
  }

  function stop() {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    isConnected.value = false
  }

  onUnmounted(stop)

  return {
    start,
    stop,
    isConnected
  }
}
