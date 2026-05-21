import { ref, onUnmounted } from 'vue'

export interface ToolCallStartData {
  tool_name: string
  tool_input?: Record<string, any>
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
  onSessionStatus?: (data: { phase: string }) => void
  onMessageEnd: () => void
  onError: (error: Event) => void
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
      options.onToolCallStart({
        tool_name: data.tool_name,
        tool_input: data.tool_input,
        call_id: data.call_id || `call_${Date.now()}`
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

    eventSource.addEventListener('session_status', (event) => {
      const data = JSON.parse(event.data)
      options.onSessionStatus?.(data)
    })

    eventSource.addEventListener('message_end', () => {
      isConnected.value = false
      options.onMessageEnd()
      stop()
    })

    eventSource.addEventListener('error', (event) => {
      isConnected.value = false
      options.onError(event)
      stop()
    })

    eventSource.onerror = () => {
      isConnected.value = false
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
