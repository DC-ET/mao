import type { TaskPhase } from '../../stores/session'

/** 后端正在执行的 phase（agent 在跑或正在取消） */
export const EXECUTING_PHASES = new Set<TaskPhase>(['RUNNING', 'RESUMING', 'CANCELLING'])
/** session 处于活跃状态（包括等待审批），可用于判断是否走队列路径 */
export const ACTIVE_PHASES = new Set<TaskPhase>(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])
export const TERMINAL_PHASES = new Set<TaskPhase>(['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE'])

/** 后端正在执行（不含 WAITING_APPROVAL），用于 sending computed */
export function isExecutingPhase(phase?: TaskPhase | null): boolean {
  return !!phase && EXECUTING_PHASES.has(phase)
}

export function isActivePhase(phase?: TaskPhase | null): boolean {
  return !!phase && ACTIVE_PHASES.has(phase)
}

export function isTerminalPhase(phase?: TaskPhase | null): boolean {
  return !!phase && TERMINAL_PHASES.has(phase)
}
