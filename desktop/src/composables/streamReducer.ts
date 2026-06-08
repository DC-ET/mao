import { useSessionStore, type TaskPhase } from '../stores/session'
import { createAssistantPlaceholder, createOptimisticUserMessage } from '../domain/session/messageFactory'
import { isTerminalPhase } from '../domain/session/phase'
import { rejectSessionTurn, resolveSessionTurn } from '../domain/session/turnTracker'
import { handleSkillSyncRequired, handleToolExecute } from './useLocalToolBridge'

export function reduceStreamEvent(msg: any, send: (msg: any) => void) {
  const sessionStore = useSessionStore()
  const { type, sessionId: rawSid, data } = msg
  const sessionId = rawSid != null ? String(rawSid) : null

  switch (type) {
    case 'connected':
    case 'pong':
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

    case 'session_status':
      if (sessionId) {
        const phase = data.phase as TaskPhase
        sessionStore.updateSessionPhase(sessionId, phase)
        if (data.unread !== undefined) {
          if (sessionId === sessionStore.activeSessionId) {
            sessionStore.markAsRead(sessionId)
          } else {
            sessionStore.updateSession(sessionId, { unread: data.unread })
          }
        }
        if (isTerminalPhase(phase)) {
          sessionStore.setStreaming(sessionId, false)
          resolveSessionTurn(sessionId)
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
      if (sessionId && data?.messageId) {
        sessionStore.updateLastMessageId(sessionId, 'user', String(data.messageId))
      }
      break

    case 'session_snapshot':
      if (sessionId && data?.phase) {
        sessionStore.updateSessionPhase(sessionId, data.phase as TaskPhase)
      }
      break

    case 'skill_sync_required':
      handleSkillSyncRequired(sessionId, data)
      break

    case 'tool_execute':
      handleToolExecute(sessionId, data, send)
      break

    case 'error':
      if (sessionId) {
        sessionStore.updateSessionPhase(sessionId, 'FAILED')
        rejectSessionTurn(sessionId, new Error(data.message || 'Agent 执行异常'))
      }
      break

    case 'queue_updated':
      if (sessionId && data?.queue) {
        sessionStore.setQueueMessages(sessionId, data.queue)
      }
      break

    case 'queue_message_consumed':
      if (sessionId && data) {
        sessionStore.addUserMessage(sessionId, createOptimisticUserMessage(data.content || '', data.images || []))
        if (data.messageId) {
          sessionStore.updateLastMessageId(sessionId, 'user', String(data.messageId))
        }
        sessionStore.addAssistantMessage(sessionId, createAssistantPlaceholder())
      }
      break
  }
}

