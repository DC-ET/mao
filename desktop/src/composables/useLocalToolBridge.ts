import { useSessionStore, type ApprovalItem } from '../stores/session'

let approvalListenerRegistered = false
let skillSyncListenerRegistered = false

function isElectronAvailable(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

export function registerApprovalListeners() {
  if (!isElectronAvailable() || approvalListenerRegistered) return
  approvalListenerRegistered = true
  const sessionStore = useSessionStore()

  ;(window as any).electronAPI.onToolApprovalRequest((data: {
    requestId: string
    toolName: string
    description: string
    sessionId?: number
    dangerReason?: string
  }) => {
    sessionStore.addApproval({
      requestId: data.requestId,
      toolName: data.toolName,
      description: data.description,
      sessionId: data.sessionId != null ? String(data.sessionId) : undefined,
      dangerReason: data.dangerReason
    })
  })

  ;(window as any).electronAPI.onToolApprovalDismiss((data: { requestId: string }) => {
    sessionStore.removeApproval(data.requestId)
  })
}

export function registerSkillSyncListener(send: (msg: any) => void) {
  if (!isElectronAvailable() || skillSyncListenerRegistered) return
  skillSyncListenerRegistered = true

  ;(window as any).electronAPI.onSkillSyncComplete?.((data: { sessionId: number; success: boolean; error?: string }) => {
    send({
      type: 'skill_sync_done',
      sessionId: data.sessionId,
      success: data.success,
      error: data.error
    })
  })
}

export async function respondToolApproval(item: ApprovalItem | undefined, approved: boolean) {
  if (!item || !isElectronAvailable()) return
  await (window as any).electronAPI.respondToolApproval(item.requestId, approved)
}

export function handleSkillSyncRequired(sessionId: string | null, data: any) {
  const syncUrl = data?.syncUrl
  const workspace = data?.workspace
  if (sessionId && syncUrl && isElectronAvailable()) {
    const token = localStorage.getItem('token') || ''
    ;(window as any).electronAPI.skillSync?.(Number(sessionId), syncUrl, token, workspace || '')
  } else {
    console.warn('[skill-sync] cannot sync:', { sessionId, syncUrl, hasElectronAPI: isElectronAvailable() })
  }
}

export function handleToolExecute(sessionId: string | null, data: any, send: (msg: any) => void) {
  if (!sessionId || !data) return
  const { requestId, toolName, arguments: toolArgs, workspace, needApproval, dangerReason } = data

  if (isElectronAvailable() && (window as any).electronAPI?.toolExecute) {
    ;(window as any).electronAPI
      .toolExecute(toolName, toolArgs, requestId, workspace, Number(sessionId), !!needApproval, dangerReason || null)
      .then((response: { requestId: string; result: string | null; error: string | null }) => {
        if (response.error) {
          send({
            type: 'tool_error',
            sessionId: Number(sessionId),
            requestId: response.requestId,
            error: response.error
          })
        } else {
          send({
            type: 'tool_result',
            sessionId: Number(sessionId),
            requestId: response.requestId,
            result: response.result
          })
        }
      })
      .catch((err: Error) => {
        send({
          type: 'tool_error',
          sessionId: Number(sessionId),
          requestId,
          error: err.message || 'IPC call failed'
        })
      })
  } else {
    send({
      type: 'tool_error',
      sessionId: Number(sessionId),
      requestId,
      error: 'Local tool execution not available (not running in Electron)'
    })
  }
}

