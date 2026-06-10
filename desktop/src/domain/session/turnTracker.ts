interface PendingTurn {
  sessionId: string
  eventId?: string
  resolve: () => void
  reject: (err: Error) => void
}

const pendingTurns = new Map<string, PendingTurn>()
const terminalListeners = new Set<(sessionId: string) => void>()

export function waitForSessionTurn(sessionId: string, eventId?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pendingTurns.set(String(sessionId), { sessionId: String(sessionId), eventId, resolve, reject })
  })
}

export function resolveSessionTurn(sessionId: string) {
  const sid = String(sessionId)
  const turn = pendingTurns.get(sid)
  if (turn) {
    pendingTurns.delete(sid)
    turn.resolve()
  }
  terminalListeners.forEach(listener => listener(sid))
}

export function rejectSessionTurn(sessionId: string, err: Error) {
  const sid = String(sessionId)
  const turn = pendingTurns.get(sid)
  if (turn) {
    pendingTurns.delete(sid)
    turn.reject(err)
  }
  terminalListeners.forEach(listener => listener(sid))
}

export function hasPendingTurn(sessionId: string): boolean {
  return pendingTurns.has(String(sessionId))
}

export function onTurnSettled(listener: (sessionId: string) => void): () => void {
  terminalListeners.add(listener)
  return () => terminalListeners.delete(listener)
}
