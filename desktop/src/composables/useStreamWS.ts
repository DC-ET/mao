import { ref } from 'vue'
import { useSessionStore, type TaskPhase } from '../stores/session'
import { api } from '../api'
import { getToken } from '../utils/auth-storage'
import { nowDateTime } from '../utils/datetime'
import { mapCompactionEvents } from '../utils/chatMessage'
import { isAndroidCapacitor } from '../utils/capacitor'

/// <reference types="vite/client" />

export interface ActivityData {
  id?: number
  type: string
  target?: string
  summary: string
  status?: string
}

// A local (not-yet-uploaded) skill from ~/.agents/skills, reported for LOCAL-mode tasks only
export interface LocalSkillReport {
  name: string
  description: string
  folderName: string
}

// Singleton state — shared across all components
let ws: WebSocket | null = null
const connected = ref(false)
const reconnectDelay = ref(1000)
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastServerMessageAt = 0
const SERVER_SILENCE_TIMEOUT_MS = 30_000
let intentionalClose = false
let connectPromise: Promise<void> | null = null
let isReconnecting = false

// Active execution ID per session — used to discard stale stream events after cancel
const activeExecutionIds = new Map<string, string>()
// Last cancelled execution ID per session — filters stragglers after clearActiveExecution
const cancelledExecutionIds = new Map<string, string>()
// Session-level gate: after cancel, drop ALL stream events until next RUNNING sets an executionId.
// Covers the race where stop happens before session_status carries executionId (events without id).
const suppressedStreamSessions = new Set<string>()
// Sessions the client intends to receive stream events for (main + side tasks).
// Restored on every reconnect — server subscriptions do not survive a new WS.
const subscribedSessionIds = new Set<string>()

export function setActiveExecution(sessionId: string, executionId: string) {
  cancelledExecutionIds.delete(sessionId)
  suppressedStreamSessions.delete(sessionId)
  activeExecutionIds.set(sessionId, executionId)
}

export function clearActiveExecution(sessionId: string) {
  const active = activeExecutionIds.get(sessionId)
  if (active) {
    cancelledExecutionIds.set(sessionId, active)
  }
  activeExecutionIds.delete(sessionId)
  suppressedStreamSessions.add(sessionId)
}

function isStaleExecution(sessionId: string, data: any): boolean {
  if (suppressedStreamSessions.has(sessionId)) {
    return true
  }
  const active = activeExecutionIds.get(sessionId)
  if (!active) {
    const cancelled = cancelledExecutionIds.get(sessionId)
    if (cancelled && data?.executionId === cancelled) return true
    return false
  }
  if (!data?.executionId) return false
  return data.executionId !== active
}

const STREAM_EVENT_TYPES = new Set([
  'content_delta', 'tool_call_start', 'tool_call_args_delta', 'tool_call_result',
  'thinking_start', 'thinking_end', 'thinking_delta', 'message_end',
  'file_change', 'activity', 'compaction_start', 'compaction_end', 'compaction_marker',
  'context_window', 'llm_waiting', 'llm_stream_reset', 'llm_retry', 'session_already_running', 'error'
])

function refreshQueue(sessionId: string) {
  const store = useSessionStore()
  api.get(`/sessions/${sessionId}/queue`)
    .then(({ data }) => store.setQueueMessages(sessionId, data || []))
    .catch(() => {})
}
const pendingCallbacks = new Map<string, {
  onSending?: () => void
  resolve?: () => void
  reject?: (err: Error) => void
}>()

// 消息保存确认的回调机制
type MessageSavedCallback = (sessionId: string, messageId: string) => void
const messageSavedCallbacks = new Map<string, MessageSavedCallback>()

// Module-level flags to ensure IPC listeners are registered only once
let skillSyncListenerRegistered = false

/** skill_sync_done payloads waiting for WS to become OPEN (reconnect during sync). */
const pendingSkillSyncDones = new Map<number, {
  sessionId: number
  success: boolean
  error?: string
}>()

function sendOrQueueSkillSyncDone(data: { sessionId: number; success: boolean; error?: string }) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'skill_sync_done',
      sessionId: data.sessionId,
      success: data.success,
      error: data.error
    }))
    pendingSkillSyncDones.delete(data.sessionId)
    return
  }
  console.warn(
    '[skill-sync] WS not open, queue skill_sync_done for flush on reconnect, readyState=' + ws?.readyState
  )
  pendingSkillSyncDones.set(data.sessionId, data)
}

function flushPendingSkillSyncDones() {
  if (pendingSkillSyncDones.size === 0) return
  if (ws?.readyState !== WebSocket.OPEN) return
  const pending = Array.from(pendingSkillSyncDones.values())
  pendingSkillSyncDones.clear()
  for (const data of pending) {
    ws.send(JSON.stringify({
      type: 'skill_sync_done',
      sessionId: data.sessionId,
      success: data.success,
      error: data.error
    }))
  }
  console.info(`[skill-sync] flushed ${pending.length} pending skill_sync_done after reconnect`)
}

function isElectronClient(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

export function useStreamWS() {
  const sessionStore = useSessionStore()

  // Listen for skill sync completion from main process (register once)
  if (!skillSyncListenerRegistered && isElectronClient()) {
    skillSyncListenerRegistered = true
    ;(window as any).electronAPI.onSkillSyncComplete?.((data: { sessionId: number; success: boolean; error?: string }) => {
      sendOrQueueSkillSyncDone(data)
    })
  }

  function connect(): Promise<void> {
    if (ws && ws.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }
    if (connectPromise) return connectPromise

    const wsBase = import.meta.env.VITE_WS_BASE_URL || import.meta.env.VITE_API_BASE_URL?.replace(/^http/, 'ws').replace(/\/api\/v1$/, '/api') || 'ws://localhost:9080/api'
    const token = getToken()
    if (!token) return Promise.reject(new Error('No token'))

    const client = isAndroidCapacitor() ? 'android' : (isElectronClient() ? 'electron' : 'browser')
    const url = `${wsBase}/ws/stream?token=${token}&client=${client}`
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
        // Re-subscribe all tracked sessions (main + open side tasks).
        // Server-side subscriptions are tied to the previous socket and are lost on reconnect.
        const toResubscribe = new Set(subscribedSessionIds)
        if (sessionStore.activeSessionId) {
          toResubscribe.add(String(sessionStore.activeSessionId))
        }
        for (const sid of toResubscribe) {
          subscribedSessionIds.add(sid)
          send({ type: 'subscribe', sessionId: Number(sid) })
          refreshQueue(sid)
        }
        // Flush skill_sync_done that completed while WS was down (LOCAL skill sync race)
        flushPendingSkillSyncDones()
        // 聚焦数据已加载过：重连后静默重拉全量 ACTIVE，保证断线期间变化不丢失
        if (sessionStore.focusLoaded) {
          void sessionStore.fetchFocusSessions(true)
        }
        // Start heartbeat. Any server message proves the connection is alive; allow enough
        // time for a delayed pong when the shared outbound queue is busy with stream events.
        lastServerMessageAt = Date.now()
        heartbeatTimer = setInterval(() => {
          if (ws?.readyState !== WebSocket.OPEN) return
          if (Date.now() - lastServerMessageAt > SERVER_SILENCE_TIMEOUT_MS) {
            ws.close()
            return
          }
          ws.send(JSON.stringify({ type: 'ping' }))
        }, 5_000)
        resolve()
      }

      ws!.onmessage = (event) => {
        lastServerMessageAt = Date.now()
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
        // 断线后内存中的瞬时 LLM 重试状态已不可信，全部清理避免重连后残留过期提示
        sessionStore.clearAllLlmRetry()
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
    // 关闭已订阅会话在桌面端的 MCP 连接（stdio 子进程 / HTTP 会话）
    const mcpSessionIds = Array.from(subscribedSessionIds)
    subscribedSessionIds.clear()
    if (mcpSessionIds.length > 0 && typeof window !== 'undefined' && (window as any).electronAPI?.mcpClose) {
      mcpSessionIds.forEach((sid) => {
        ;(window as any).electronAPI.mcpClose?.(Number(sid)).catch?.((err: Error) =>
          console.warn('[mcp-close] failed for session', sid, err?.message))
      })
    }
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

  async function sendReliable(msg: any): Promise<boolean> {
    const trySend = (): boolean => {
      const socket = ws
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg))
        return true
      }
      return false
    }

    if (trySend()) {
      return true
    }
    try {
      await connect()
    } catch {
      console.warn('[ws] sendReliable failed to reconnect for', msg.type)
      return false
    }
    if (trySend()) {
      return true
    }
    console.warn('[ws] sendReliable dropped after reconnect:', msg.type, 'readyState=' + ws?.readyState)
    return false
  }

  function resetSessionStreamState(sessionId: string) {
    sessionStore.setStreaming(sessionId, false)
    sessionStore.setThinking(sessionId, false)
    sessionStore.clearLlmRetry(sessionId)
    sessionStore.clearAskQuestions(sessionId)
    clearActiveExecution(sessionId)
  }

  function subscribe(sessionId: string | null) {
    if (sessionId) {
      subscribedSessionIds.add(String(sessionId))
      send({ type: 'subscribe', sessionId: Number(sessionId) })
    }
  }

  function unsubscribe(sessionId: string | null) {
    if (sessionId) {
      subscribedSessionIds.delete(String(sessionId))
      send({ type: 'unsubscribe', sessionId: Number(sessionId) })
    }
  }

  async function sendMessage(sessionId: string, content: string, eventId: string, images?: string[], localSkills?: LocalSkillReport[], agentsMdContent?: string, modelId?: number): Promise<boolean> {
    const payload = {
      type: 'send_message',
      sessionId: Number(sessionId),
      data: {
        content,
        eventId,
        images: images || [],
        ...(modelId != null ? { modelId } : {}),
        ...(localSkills && localSkills.length > 0 ? { localSkills } : {}),
        ...(agentsMdContent ? { agentsMdContent } : {})
      }
    }
    send(payload)
    return true
  }

  async function sendEditMessage(sessionId: string, content: string, messageId: string, images?: string[], localSkills?: LocalSkillReport[], agentsMdContent?: string): Promise<boolean> {
    const payload = {
      type: 'edit_and_resend',
      sessionId: Number(sessionId),
      messageId: Number(messageId),
      content,
      images: images || [],
      ...(localSkills && localSkills.length > 0 ? { localSkills } : {}),
      ...(agentsMdContent ? { agentsMdContent } : {})
    }
    send(payload)
    return true
  }

  function cancel(sessionId: string) {
    send({ type: 'cancel', sessionId: Number(sessionId) })
  }

  async function sendAskUserQuestionsResult(sessionId: string, requestId: string, answers: any[]): Promise<boolean> {
    return sendReliable({
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

  async function sendToolApproval(sessionId: string, requestId: string, approved: boolean): Promise<boolean> {
    return sendReliable({
      type: 'tool_approval',
      sessionId: Number(sessionId),
      requestId,
      approved
    })
  }

  async function createSideSession(
    parentSessionId: string,
    content: string,
    inheritContext: boolean,
    modelId?: number,
    localSkills?: LocalSkillReport[],
    agentsMdContent?: string,
    images?: string[]
  ): Promise<boolean> {
    const payload = {
      type: 'create_side_session',
      sessionId: Number(parentSessionId),
      data: {
        content,
        inheritContext,
        images: images || [],
        ...(modelId != null ? { modelId } : {}),
        ...(localSkills && localSkills.length > 0 ? { localSkills } : {}),
        ...(agentsMdContent ? { agentsMdContent } : {})
      }
    }
    send(payload)
    return true
  }

  function routeEvent(msg: any) {
    const { type, sessionId: rawSid, data } = msg
    const sessionId = rawSid != null ? String(rawSid) : null

    if (sessionId && STREAM_EVENT_TYPES.has(type) && isStaleExecution(sessionId, data)) {
      return
    }

    switch (type) {
      case 'connected':
        break

      case 'pong':
        break

      case 'content_delta':
        if (sessionId) {
          sessionStore.appendDelta(sessionId, data.delta)
          sessionStore.clearLlmRetry(sessionId)
        }
        break

      case 'tool_call_start':
        if (sessionId) {
          sessionStore.setStreaming(sessionId, false)
          sessionStore.appendToolCallStart(sessionId, data)
          sessionStore.clearLlmRetry(sessionId)
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
            toolCallId: data.tool_call_id,
            diffMode: data.diff_mode,
            beforeContent: data.before_content,
            afterContent: data.after_content,
            patchContent: data.patch_content,
            patchTruncated: Boolean(data.patch_truncated),
            diffUnavailableReason: data.diff_unavailable_reason
          })
        }
        break

      case 'session_status':
        if (sessionId) {
          const phase = data.phase as TaskPhase
          const terminalPhases = ['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE']

          if (phase === 'RUNNING' && data.executionId) {
            setActiveExecution(sessionId, data.executionId)
          }

          // Ignore stale CANCELLING after local optimistic cancel
          if (phase === 'CANCELLING' && !activeExecutionIds.has(sessionId)) {
            break
          }

          if (terminalPhases.includes(phase) && isStaleExecution(sessionId, data)) {
            break
          }

          sessionStore.updateSessionPhase(sessionId, phase)
          sessionStore.updateSideTaskPhase(Number(sessionId), phase)
          sessionStore.updateSubagentPhase(Number(sessionId), phase)
          // Sync unread state — skip for active session (user is already viewing)
          if (data.unread !== undefined) {
            if (sessionId === sessionStore.activeSessionId) {
              sessionStore.markAsRead(sessionId)
            } else {
              sessionStore.updateSession(sessionId, { unread: data.unread })
              // 边路任务会话不在主列表：unread 单独落到 SideTask 缓存（左侧任务栏圆点）
              sessionStore.updateSideTaskUnread(Number(sessionId), data.unread)
            }
          }
          if (terminalPhases.includes(phase)) {
            sessionStore.setStreaming(sessionId, false)
            sessionStore.setThinking(sessionId, false)
            sessionStore.clearLlmRetry(sessionId)
            sessionStore.clearAskQuestions(sessionId)
            if (phase === 'CANCELLED' || phase === 'COMPLETED' || phase === 'FAILED') {
              clearActiveExecution(sessionId)
            }
            const cb = pendingCallbacks.get(sessionId)
            if (cb) {
              pendingCallbacks.delete(sessionId)
              cb.resolve?.()
            }
          } else if (phase === 'RUNNING' || phase === 'WAITING_APPROVAL') {
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

      case 'compaction_marker':
        if (sessionId && data) {
          const events = mapCompactionEvents([data as Record<string, unknown>])
          if (events[0]) sessionStore.addCompactionEvent(sessionId, events[0])
        }
        break

      case 'thinking_start':
        if (sessionId) {
          sessionStore.setStreaming(sessionId, false)
          sessionStore.setThinking(sessionId, true)
          // 重试成功后首个事件可能是 thinking_start，清除过期重试提示
          sessionStore.clearLlmRetry(sessionId)
        }
        break

      case 'thinking_end':
        if (sessionId) {
          sessionStore.setStreaming(sessionId, false)
          sessionStore.setThinking(sessionId, false)
          sessionStore.clearLlmRetry(sessionId)
        }
        break

      case 'thinking_delta':
        if (sessionId) {
          sessionStore.appendThinkingDelta(sessionId, data.delta)
          sessionStore.clearLlmRetry(sessionId)
        }
        break

      case 'llm_waiting':
        if (sessionId && data) {
          sessionStore.setLlmRetry(sessionId, {
            phase: data.phase,
            elapsedSeconds: data.elapsedSeconds
          })
        }
        break

      case 'llm_stream_reset':
        if (sessionId) {
          sessionStore.resetStreamingAssistantMessage(sessionId)
        }
        break

      case 'llm_retry':
        if (sessionId && data) {
          sessionStore.setLlmRetry(sessionId, {
            reason: data.reason,
            statusCode: data.statusCode,
            attempt: data.attempt,
            maxRetries: data.maxRetries,
            delaySeconds: data.delaySeconds
          })
        }
        break

      case 'session_already_running':
        if (sessionId) {
          const cb = pendingCallbacks.get(sessionId)
          if (cb) {
            pendingCallbacks.delete(sessionId)
            cb.reject?.(new Error(data?.message || '该任务仍在运行'))
          }
        }
        break

      case 'message_end':
        if (sessionId) {
          sessionStore.markMessageComplete(sessionId, data)
          sessionStore.clearLlmRetry(sessionId)
        }
        break

      case 'user_message_saved':
        // Desktop send: update optimistic temp ID.
        // Weixin/remote: append the inbound user message so open sessions stream live.
        if (sessionId && data?.messageId) {
          if (data.source === 'weixin' || data.source === 'scheduled') {
            sessionStore.addUserMessage(sessionId, {
              id: String(data.messageId),
              role: 'user',
              content: typeof data.content === 'string' ? data.content : '',
              createdAt: nowDateTime(),
              images: Array.isArray(data.images) && data.images.length > 0
                ? data.images as string[]
                : undefined
            })
            sessionStore.ensureStreamingAssistantMessage(sessionId)
          } else {
            sessionStore.updateLastMessageId(sessionId, 'user', String(data.messageId))
          }
          // 调用注册的消息保存回调
          messageSavedCallbacks.forEach((callback) => {
            callback(sessionId, String(data.messageId))
          })
        }
        break

      case 'session_snapshot':
        // Session was already running when we subscribed — sync phase so client can show correct UI
        if (sessionId && data?.phase) {
          if (data.executionId) setActiveExecution(sessionId, data.executionId)
          sessionStore.updateSessionPhase(sessionId, data.phase as TaskPhase)
          sessionStore.updateSideTaskPhase(Number(sessionId), data.phase as TaskPhase)
          sessionStore.updateSubagentPhase(Number(sessionId), data.phase as TaskPhase)
        }
        break

      case 'session_tree_status':
        // Side Task 状态变化后，父任务的任务树聚合信号（tree*）实时推送（聚焦模式重排）
        if (sessionId && data) {
          sessionStore.updateSessionTreeSignals(String(sessionId), {
            treePendingApprovalCount: data.treePendingApprovalCount,
            treePendingQuestionCount: data.treePendingQuestionCount,
            treeUnread: data.treeUnread,
            treeRunning: data.treeRunning,
            treeFailed: data.treeFailed,
          })
        }
        break

      case 'side_session_created':
        // Side task session created — dispatch custom event for SideChatPanel to handle
        if (sessionId && data?.sideSessionId && data?.title) {
          window.dispatchEvent(new CustomEvent('side_session_created', {
            detail: {
              parentSessionId: sessionId,
              sideSessionId: data.sideSessionId,
              title: data.title
            }
          }))
          // Subscribe to the new side session for stream events
          subscribe(String(data.sideSessionId))
        }
        break

      case 'subagent_session_created':
        if (sessionId && data?.childSessionId) {
          window.dispatchEvent(new CustomEvent('subagent_session_created', {
            detail: {
              parentSessionId: sessionId,
              childSessionId: data.childSessionId,
              title: data.title || '子代理',
              agentType: data.agentType || '',
              task: data.task || '',
              toolCallId: data.toolCallId || ''
            }
          }))
          subscribe(String(data.childSessionId))
        }
        break

      case 'skill_sync_required': {
        // Server requests skill sync — trigger main process to download & extract zip
        const syncUrl = data?.syncUrl
        const workspace = data?.workspace
        if (sessionId && syncUrl && isElectronClient()) {
          const token = getToken() || ''
          const apiBase = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1')
            .replace(/\/v1\/?$/, '')
          ;(window as any).electronAPI.skillSync?.(Number(sessionId), syncUrl, token, workspace || '', apiBase)
        } else {
          console.warn('[skill-sync] cannot sync:', { sessionId, syncUrl, hasElectronAPI: isElectronClient() })
        }
        break
      }

      case 'mcp_sync_required': {
        // Server requests MCP sync — main process connects to MCP servers and lists tools
        const servers = data?.servers
        const syncId = data?.syncId
        const reportToServer = (reports: Array<{ name: string; connected: boolean; tools: unknown[]; error: string | null }>) => {
          sendReliable({
            type: 'mcp_tools_report',
            sessionId: Number(sessionId),
            syncId: syncId || null,
            servers: reports
          }).catch((err: Error) => console.error('[mcp-sync] report failed:', err?.message))
        }
        if (sessionId && Array.isArray(servers) && isElectronClient()) {
          ;(window as any).electronAPI
            .mcpSync?.(Number(sessionId), servers)
            .then((resp: { reports?: Array<{ name: string; connected: boolean; tools: unknown[]; error: string | null }> }) => {
              reportToServer(resp?.reports || [])
            })
            .catch((err: Error) => {
              console.error('[mcp-sync] failed:', err)
              reportToServer((servers as Array<{ name: string }>).map((s) => ({
                name: s?.name,
                connected: false,
                tools: [],
                error: err instanceof Error ? err.message : 'MCP sync failed'
              })))
            })
        } else {
          console.warn('[mcp-sync] cannot sync:', { sessionId, hasServers: Array.isArray(servers), hasElectronAPI: isElectronClient() })
          if (sessionId) {
            // 非 Electron 或无法连接：上报全部失败，让服务端降级处理
            reportToServer((Array.isArray(servers) ? servers : []).map((s: { name: string }) => ({
              name: s?.name,
              connected: false,
              tools: [],
              error: 'Electron MCP client unavailable'
            })))
          }
        }
        break
      }

      case 'tool_execute': {
        if (!sessionId || !data) break
        const { requestId, toolName, arguments: toolArgs, workspace, needApproval, dangerReason } = data
        if (typeof window !== 'undefined' && (window as any).electronAPI?.toolExecute) {
          ;(window as any).electronAPI
            .toolExecute(toolName, toolArgs, requestId, workspace, Number(sessionId), !!needApproval, dangerReason || null)
            .then(async (response: { requestId: string; result: string | null; error: string | null }) => {
              if (response.error) {
                await sendReliable({
                  type: 'tool_error',
                  sessionId: Number(sessionId),
                  requestId: response.requestId,
                  error: response.error
                })
              } else {
                await sendReliable({
                  type: 'tool_result',
                  sessionId: Number(sessionId),
                  requestId: response.requestId,
                  result: response.result
                })
              }
            })
            .catch(async (err: Error) => {
              await sendReliable({
                type: 'tool_error',
                sessionId: Number(sessionId),
                requestId,
                error: err.message || 'IPC call failed'
              })
            })
        }
        // Non-Electron clients (browser tabs) silently ignore — let Electron handle it
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
          const message = (data?.message && String(data.message)) || 'Agent 执行异常'
          sessionStore.setExecutionError(sessionId, message)
          sessionStore.updateSessionPhase(sessionId, 'FAILED' as TaskPhase)
          sessionStore.updateSideTaskPhase(Number(sessionId), 'FAILED' as TaskPhase)
          sessionStore.updateSubagentPhase(Number(sessionId), 'FAILED' as TaskPhase)
          resetSessionStreamState(sessionId)
          const cb = pendingCallbacks.get(sessionId)
          if (cb) {
            pendingCallbacks.delete(sessionId)
            // Banner already shows the error — skip ephemeral toast in useChat catch
            const err = new Error(message) as Error & { toastShown?: boolean }
            err.toastShown = true
            cb.reject?.(err)
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
          sessionStore.addUserMessage(sessionId, {
            id: String(data.messageId),
            role: 'user',
            content: typeof data.content === 'string' ? data.content : '',
            createdAt: nowDateTime(),
            images: data.images && data.images.length > 0 ? data.images : undefined
          })
          sessionStore.ensureStreamingAssistantMessage(sessionId)
          refreshQueue(sessionId)
        }
        break
      }
    }
  }

  // 消息保存确认的回调注册函数
  function onMessageSaved(callback: MessageSavedCallback): string {
    const callbackId = `callback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    messageSavedCallbacks.set(callbackId, callback)
    return callbackId
  }

  function offMessageSaved(callbackId: string) {
    messageSavedCallbacks.delete(callbackId)
  }

  /** 当前 WS readyState；未建立/已登出（ws 为 null）时返回 -1，供回前台恢复检测区分「从未连接」与「已断开」。 */
  function getReadyState(): number {
    return ws?.readyState ?? -1
  }

  // Don't disconnect on component unmount — WS is global

  return {
    connected,
    connect,
    disconnect,
    getReadyState,
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
    sendToolApproval,
    createSideSession,
    pendingCallbacks,
    setActiveExecution,
    clearActiveExecution,
    onMessageSaved,
    offMessageSaved
  }
}
