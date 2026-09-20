/**
 * 会话执行中的判定条件，与后端 isActivePhase（backend-ts/src/session/session-vo.ts）口径一致：
 * RUNNING / RESUMING / WAITING_APPROVAL 视为执行中；CANCELLING 是瞬时中间态，
 * 且后端可能在本地乐观取消后补发，不纳入。
 *
 * 供「assistant 气泡是否处于执行中」（重试条 / 流式光标）等展示逻辑复用：
 * 首轮 LLM 即被限流（429）时没有任何 content/thinking 事件，
 * 只有 phase 能证明会话仍在执行，重试条因此能正常显示。
 */
export function isActiveSessionPhase(phase?: string | null): boolean {
  return phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL'
}
