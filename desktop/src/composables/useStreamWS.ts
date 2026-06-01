import { ref } from 'vue'
import { useSessionStore, type TaskPhase } from '../stores/session'
import { showReloginDialog, doRefreshToken } from '../api'

/// <reference types="vite/client" />

export interface ActivityData {
  id?: number
  type: string
  target?: string
  summary: string
  status?: string
}

// Singleton state — shared across all components
let ws: WebSocket | null = null
const connected = ref(false)
const reconnectDelay = ref(1000)
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let intentionalClose = false
let connectPromise: Promise<void> | null = null

// Pending sendMessage callbacks — keyed by eventId
const pendingCallbacks = new Map<string, {
  onSending?: () => void
  resolve?: () => void
  reject?: (err: Error) => void
}>()

export function useStreamWS() {
  const sessionStore = useSessionStore()

  // Listen for skill sync completion from main process
  if (typeof window !== 'undefined' && (window as any).electronAPI) {
    ;(window as any).electronAPI.onSkillSyncComplete?.((data: { sessionId: number; success: boolean; error?: string }) => {
      console.log('[skill-sync] complete:', data)
      if (ws?.readyState === WebSocket.OPEN) {
        console.log('[skill-sync] sending skill_sync_done')
        ws.send(JSON.stringify({
          type: 'skill_sync_done',
          sessionId: data.sessionId,
          success: data.success,
          error: data.error
        }))
      } else {
        console.warn('[skill-sync] WS not open, cannot send skill_sync_done, readyState=' + ws?.readyState)
      }
    })
  }

  function connect(): Promise<void> {
    if (ws && ws.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }
    if (connectPromise) return connectPromise

    const baseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api'
    const wsBase = baseUrl.replace(/^http/, 'ws').replace(/\/api\/v1$/, '/api')
    const token = localStorage.getItem('token')
    if (!token) return Promise.reject(new Error('No token'))

    const url = `${wsBase}/ws/stream?token=${token}`
    ws = new WebSocket(url)
    intentionalClose = false

    let initialConnect = true

    connectPromise = new Promise<void>((resolve, reject) => {
      ws!.onopen = () => {
        connected.value = true
        reconnectDelay.value = 1000
        connectPromise = null
        // Re-subscribe to active session
        if (sessionStore.activeSessionId) {
          send({ type: 'subscribe', sessionId: Number(sessionStore.activeSessionId) })
        }
        // Start heartbeat
        heartbeatTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 30_000)
        resolve()
      }

      ws!.onmessage = (event) => {
        let msg: any
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        routeEvent(msg)
      }

      ws!.onclose = () => {
        connected.value = false
        stopHeartbeat()
        if (initialConnect) {
          initialConnect = false
          connectPromise = null
          reject(new Error('WebSocket connection failed'))
        } else if (!intentionalClose) {
          scheduleReconnect()
        }
      }

      ws!.onerror = async () => {
        // onclose will fire after onerror, which handles the reject/reconnect
        try {
          await doRefreshToken()
        } catch {
          showReloginDialog()
        }
      }
    })

    return connectPromise
  }

  function disconnect() {
    intentionalClose = true
    stopHeartbeat()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.close()
      ws = null
    }
    connected.value = false
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectDelay.value)
    reconnectDelay.value = Math.min(reconnectDelay.value * 2, 30_000)
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function send(msg: any) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    } else {
      console.warn('[ws] send dropped (not open):', msg.type, 'readyState=' + ws?.readyState)
    }
  }

  function subscribe(sessionId: string | null) {
    if (sessionId) {
      send({ type: 'subscribe', sessionId: Number(sessionId) })
    }
  }

  function unsubscribe(sessionId: string | null) {
    if (sessionId) {
      send({ type: 'unsubscribe', sessionId: Number(sessionId) })
    }
  }

  function sendMessage(sessionId: string, content: string, eventId: string) {
    send({
      type: 'send_message',
      sessionId: Number(sessionId),
      data: { content, eventId }
    })
  }

  function cancel(sessionId: string) {
    send({ type: 'cancel', sessionId: Number(sessionId) })
  }

  function routeEvent(msg: any) {
    const { type, sessionId: rawSid, data } = msg
    const sessionId = rawSid != null ? String(rawSid) : null

    switch (type) {
      case 'connected':
        break

      case 'pong':
        break

      case 'content_delta':
        if (sessionId) sessionStore.appendDelta(sessionId, data.delta)
        break

      case 'tool_call_start':
        if (sessionId) sessionStore.appendToolCallStart(sessionId, data)
        break

      case 'tool_call_result':
        if (sessionId) sessionStore.updateToolCallResult(sessionId, data)
        break

      case 'activity':
        if (sessionId) sessionStore.addActivity(sessionId, data)
        break

      case 'todo_updated':
        if (sessionId) sessionStore.setTodos(sessionId, data.todos || [])
        break

      case 'session_status':
        if (sessionId) {
          sessionStore.updateSessionPhase(sessionId, data.phase as TaskPhase)
          if (data.phase !== 'RUNNING') {
            // Agent turn complete — resolve pending callback
            const cb = pendingCallbacks.get(sessionId)
            if (cb) {
              pendingCallbacks.delete(sessionId)
              cb.resolve?.()
            }
          }
        }
        break

      case 'session_list_update':
        if (sessionId) sessionStore.updateSessionPhase(sessionId, data.phase as TaskPhase)
        break

      case 'context_window':
        if (sessionId) sessionStore.setContextWindow(sessionId, data)
        break

      case 'compaction_start':
        if (sessionId) sessionStore.setCompacting(sessionId, true)
        break

      case 'compaction_end':
        if (sessionId) sessionStore.setCompacting(sessionId, false)
        break

      case 'message_end':
        if (sessionId) sessionStore.markMessageComplete(sessionId, data)
        break

      case 'session_snapshot':
        // Session was already running when we subscribed — the snapshot tells us the current phase
        // Client should fetchMessages() to get the full history
        break

      case 'skill_sync_required': {
        // Server requests skill sync — trigger main process to download & extract zip
        const syncUrl = data?.syncUrl
        console.log('[skill-sync] received skill_sync_required:', { sessionId, syncUrl })
        if (sessionId && syncUrl && typeof window !== 'undefined' && (window as any).electronAPI) {
          const token = localStorage.getItem('token') || ''
          ;(window as any).electronAPI.skillSync?.(Number(sessionId), syncUrl, token)
        } else {
          console.warn('[skill-sync] cannot sync:', { sessionId, syncUrl, hasElectronAPI: !!(window as any).electronAPI })
        }
        break
      }

      case 'error': {
        if (sessionId) {
          sessionStore.updateSessionPhase(sessionId, 'FAILED' as TaskPhase)
          const cb = pendingCallbacks.get(sessionId)
          if (cb) {
            pendingCallbacks.delete(sessionId)
            cb.reject?.(new Error(data.message || 'Agent 执行异常'))
          }
        }
        break
      }
    }
  }

  // Don't disconnect on component unmount — WS is global

  return {
    connected,
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    sendMessage,
    cancel,
    pendingCallbacks
  }
}
