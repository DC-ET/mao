import { ref } from 'vue'
import { useSessionStore, type TaskPhase } from '../stores/session'

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
let lastPongAt = 0
const PONG_TIMEOUT_MS = 15_000
let intentionalClose = false
let connectPromise: Promise<void> | null = null
let isReconnecting = false

// Pending sendMessage callbacks — keyed by eventId
const pendingCallbacks = new Map<string, {
  onSending?: () => void
  resolve?: () => void
  reject?: (err: Error) => void
}>()

// Module-level flags to ensure IPC listeners are registered only once
let skillSyncListenerRegistered = false

export function useStreamWS() {
  const sessionStore = useSessionStore()

  // Listen for skill sync completion from main process (register once)
  if (!skillSyncListenerRegistered && typeof window !== 'undefined' && (window as any).electronAPI) {
    skillSyncListenerRegistered = true
    ;(window as any).electronAPI.onSkillSyncComplete?.((data: { sessionId: number; success: boolean; error?: string }) => {
      if (ws?.readyState === WebSocket.OPEN) {
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
        initialConnect = false
        isReconnecting = false
        // Re-subscribe to active session
        if (sessionStore.activeSessionId) {
          send({ type: 'subscribe', sessionId: Number(sessionStore.activeSessionId) })
        }
        // Start heartbeat with pong timeout detection
        lastPongAt = Date.now()
        heartbeatTimer = setInterval(() => {
          if (ws?.readyState !== WebSocket.OPEN) return
          if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
            ws.close()
            return
          }
          ws.send(JSON.stringify({ type: 'ping' }))
        }, 5_000)
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
        if (initialConnect && !isReconnecting) {
          // First-ever connection attempt failed — reject the promise
          initialConnect = false
          connectPromise = null
          reject(new Error('WebSocket connection failed'))
        } else if (!intentionalClose) {
          // Either a reconnect attempt failed, or an established connection dropped
          // In both cases, schedule the next reconnect
          initialConnect = false
          connectPromise = null
          isReconnecting = false
          scheduleReconnect()
        }
      }

      ws!.onerror = () => {
        // onclose will fire after onerror, which handles the reject/reconnect
      }
    })

    return connectPromise
  }

  function disconnect() {
    intentionalClose = true
    isReconnecting = false
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
    isReconnecting = true
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

  function sendMessage(sessionId: string, content: string, eventId: string, images?: string[]) {
    send({
      type: 'send_message',
      sessionId: Number(sessionId),
      data: { content, eventId, images: images || [] }
    })
  }

  function sendEditMessage(sessionId: string, content: string, messageId: string, images?: string[]) {
    send({
      type: 'edit_and_resend',
      sessionId: Number(sessionId),
      messageId: Number(messageId),
      content,
      images: images || []
    })
  }

  function cancel(sessionId: string) {
    send({ type: 'cancel', sessionId: Number(sessionId) })
  }

  function sendAskUserQuestionsResult(sessionId: string, requestId: string, answers: any[]) {
    send({
      type: 'ask_user_questions_result',
      sessionId: Number(sessionId),
      data: { requestId, answers }
    })
  }

  function enqueueMessage(sessionId: string, content: string, eventId: string, images: string[]) {
    send({ type: 'enqueue_message', sessionId: Number(sessionId), data: { content, eventId, images } })
  }

  function insertMessage(sessionId: string, queueId: string) {
    send({ type: 'insert_message', sessionId: Number(sessionId), data: { queueId } })
  }

  function deleteQueueMessage(sessionId: string, queueId: string) {
    send({ type: 'delete_queue_message', sessionId: Number(sessionId), data: { queueId } })
  }

  function reorderQueueMessage(sessionId: string, queueId: string, direction: string) {
    send({ type: 'reorder_queue_message', sessionId: Number(sessionId), data: { queueId, direction } })
  }

  function routeEvent(msg: any) {
    const { type, sessionId: rawSid, data } = msg
    const sessionId = rawSid != null ? String(rawSid) : null

    switch (type) {
      case 'connected':
        break

      case 'pong':
        lastPongAt = Date.now()
        break

      case 'content_delta':
        if (sessionId) sessionStore.appendDelta(sessionId, data.delta)
        break

      case 'tool_call_start':
        if (sessionId) {
          sessionStore.setStreaming(sessionId, false)
          sessionStore.appendToolCallStart(sessionId, data)
        }
        break

      case 'tool_call_args_delta':
        if (sessionId) sessionStore.updateToolCallArgs(sessionId, data)
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

      case 'file_change':
        if (sessionId) {
          sessionStore.appendFileChange(sessionId, {
            path: data.path,
            type: data.type,
            linesAdded: data.lines_added,
            linesDeleted: data.lines_deleted,
            toolCallId: data.tool_call_id
          })
        }
        break

      case 'session_status':
        if (sessionId) {
          sessionStore.updateSessionPhase(sessionId, data.phase as TaskPhase)
          // Sync unread state — skip for active session (user is already viewing)
          if (data.unread !== undefined) {
            if (sessionId === sessionStore.activeSessionId) {
              sessionStore.markAsRead(sessionId)
            } else {
              sessionStore.updateSession(sessionId, { unread: data.unread })
            }
          }
          // Only resolve pending callback on true terminal phases
          const terminalPhases = ['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE']
          if (terminalPhases.includes(data.phase)) {
            sessionStore.setStreaming(sessionId, false)
            sessionStore.clearAskQuestions(sessionId)
            // Agent turn complete — resolve pending callback
            const cb = pendingCallbacks.get(sessionId)
            if (cb) {
              pendingCallbacks.delete(sessionId)
              cb.resolve?.()
            }
          } else if (data.phase === 'RUNNING' || data.phase === 'WAITING_APPROVAL') {
            // Ensure a pending callback exists for running sessions.
            // Covers the case where the user switches away and back — the original
            // callback from sendMessage is lost, but we still need completion tracking.
            if (!pendingCallbacks.has(sessionId)) {
              pendingCallbacks.set(sessionId, {
                resolve: () => {},
                reject: () => {}
              })
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

      case 'thinking_start':
        if (sessionId) {
          sessionStore.setStreaming(sessionId, false)
          sessionStore.setThinking(sessionId, true)
        }
        break

      case 'thinking_end':
        if (sessionId) {
          sessionStore.setStreaming(sessionId, false)
          sessionStore.setThinking(sessionId, false)
        }
        break

      case 'thinking_delta':
        if (sessionId) sessionStore.appendThinkingDelta(sessionId, data.delta)
        break

      case 'message_end':
        if (sessionId) sessionStore.markMessageComplete(sessionId, data)
        break

      case 'user_message_saved':
        // Server returned the real DB ID for a user message — update the optimistic temp ID
        if (sessionId && data?.messageId) {
          sessionStore.updateLastMessageId(sessionId, 'user', String(data.messageId))
        }
        break

      case 'session_snapshot':
        // Session was already running when we subscribed — sync phase so client can show correct UI
        if (sessionId && data?.phase) {
          sessionStore.updateSessionPhase(sessionId, data.phase as TaskPhase)
        }
        break

      case 'skill_sync_required': {
        // Server requests skill sync — trigger main process to download & extract zip
        const syncUrl = data?.syncUrl
        const workspace = data?.workspace
        if (sessionId && syncUrl && typeof window !== 'undefined' && (window as any).electronAPI) {
          const token = localStorage.getItem('token') || ''
          ;(window as any).electronAPI.skillSync?.(Number(sessionId), syncUrl, token, workspace || '')
        } else {
          console.warn('[skill-sync] cannot sync:', { sessionId, syncUrl, hasElectronAPI: !!(window as any).electronAPI })
        }
        break
      }

      case 'tool_execute': {
        if (!sessionId || !data) break
        const { requestId, toolName, arguments: toolArgs, workspace, needApproval, dangerReason } = data
        if (typeof window !== 'undefined' && (window as any).electronAPI?.toolExecute) {
          ;(window as any).electronAPI
            .toolExecute(toolName, toolArgs, requestId, workspace, Number(sessionId), !!needApproval, dangerReason || null)
            .then((response: { requestId: string; result: string | null; error: string | null }) => {
              if (ws?.readyState === WebSocket.OPEN) {
                if (response.error) {
                  ws.send(JSON.stringify({
                    type: 'tool_error',
                    sessionId: Number(sessionId),
                    requestId: response.requestId,
                    error: response.error
                  }))
                } else {
                  ws.send(JSON.stringify({
                    type: 'tool_result',
                    sessionId: Number(sessionId),
                    requestId: response.requestId,
                    result: response.result
                  }))
                }
              }
            })
            .catch((err: Error) => {
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'tool_error',
                  sessionId: Number(sessionId),
                  requestId,
                  error: err.message || 'IPC call failed'
                }))
              }
            })
        } else {
          // Not in Electron — send error back
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'tool_error',
              sessionId: Number(sessionId),
              requestId,
              error: 'Local tool execution not available (not running in Electron)'
            }))
          }
        }
        break
      }

      case 'ask_user_questions': {
        if (sessionId && data) {
          // Clear stale questions — the agent has moved on to a new question
          sessionStore.clearAskQuestions(sessionId)
          sessionStore.appendAskQuestion(sessionId, {
            requestId: data.requestId,
            questions: data.questions || [],
            metadata: data.metadata
          })
        }
        break
      }

      case 'ask_user_questions_cancelled': {
        if (sessionId && data?.requestId) {
          sessionStore.removeAskQuestion(sessionId, data.requestId)
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

      case 'queue_updated': {
        if (sessionId && data?.queue) {
          sessionStore.setQueueMessages(sessionId, data.queue)
        }
        break
      }

      case 'queue_message_consumed': {
        if (sessionId && data) {
          // Add user message with real ID
          sessionStore.addUserMessage(sessionId, {
            id: String(data.messageId),
            role: 'user',
            content: data.content || '',
            createdAt: new Date().toLocaleString(),
            images: data.images && data.images.length > 0 ? data.images : undefined
          })
          // Add empty assistant placeholder
          sessionStore.addAssistantMessage(sessionId, {
            id: `msg_${Date.now()}_assistant`,
            role: 'assistant',
            content: '',
            createdAt: new Date().toLocaleString(),
            toolCalls: [],
            segments: []
          })
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
    sendEditMessage,
    cancel,
    sendAskUserQuestionsResult,
    enqueueMessage,
    insertMessage,
    deleteQueueMessage,
    reorderQueueMessage,
    pendingCallbacks
  }
}
