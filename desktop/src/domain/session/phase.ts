import type { TaskPhase } from '../../stores/session'

export function isActivePhase(phase?: TaskPhase | null): boolean {
  return phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL' || phase === 'CANCELLING'
}

export function isTerminalPhase(phase?: TaskPhase | null): boolean {
  return phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED' || phase === 'IDLE'
}

export function isCancellablePhase(phase?: TaskPhase | null): boolean {
  return phase === 'RUNNING' || phase === 'WAITING_APPROVAL' || phase === 'CANCELLING'
}

