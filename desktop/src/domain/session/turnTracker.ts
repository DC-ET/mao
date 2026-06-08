const TURN_TIMEOUT_MS = 30 * 60_000

interface PendingTurn {
  sessionId: string
  eventId?: string
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class TurnAbortError extends Error {
  constructor(message = 'Turn wait aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

const pendingTurns = new Map<string, PendingTurn>()

export function waitForSessionTurn(sessionId: string, eventId?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sid = String(sessionId)
    rejectPendingTurn(sid, new Error('Superseded by a newer turn'))

    const timer = setTimeout(() => {
      pendingTurns.delete(sid)
      reject(new Error('Turn timeout — no terminal session_status within 30 minutes'))
    }, TURN_TIMEOUT_MS)

    pendingTurns.set(sid, { sessionId: sid, eventId, resolve, reject, timer })
  })
}

export function resolveSessionTurn(sessionId: string) {
  const sid = String(sessionId)
  const turn = pendingTurns.get(sid)
  if (!turn) return
  clearTimeout(turn.timer)
  pendingTurns.delete(sid)
  turn.resolve()
}

export function rejectSessionTurn(sessionId: string, err: Error) {
  const sid = String(sessionId)
  const turn = pendingTurns.get(sid)
  if (!turn) return
  clearTimeout(turn.timer)
  pendingTurns.delete(sid)
  turn.reject(err)
}

export function rejectPendingTurn(sessionId: string, err: Error) {
  rejectSessionTurn(sessionId, err)
}

export function abortPendingTurn(sessionId: string) {
  rejectSessionTurn(sessionId, new TurnAbortError())
}

export function hasPendingTurn(sessionId: string): boolean {
  return pendingTurns.has(String(sessionId))
}

