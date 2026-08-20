import { ACTIVE_PHASES, TERMINAL_PHASES, type WsEvent } from './event-types';

/**
 * 后端按 userId 广播给该用户的所有 WS 连接。CLI 必须按 sessionId + executionId 本地过滤，
 * 否则 desktop 上另一个会话结束会让 -p 提前退出。见设计文档 §7.4。
 */
export function acceptEvent(evt: WsEvent, mySessionId: number, myExecutionId: string | null): boolean {
  if (evt.sessionId != null && evt.sessionId !== mySessionId) return false;
  const eid = evt.data?.executionId;
  if (eid != null && myExecutionId != null && String(eid) !== myExecutionId) return false;
  return true;
}

export function isTerminalStatus(
  evt: WsEvent,
  myExecutionId: string | null,
  seenRunning: boolean,
): boolean {
  if (evt.type !== 'session_status') return false;
  const phase = String(evt.data?.phase ?? '');
  if (!TERMINAL_PHASES.has(phase)) return false;
  const eid = evt.data?.executionId;
  if (eid != null && myExecutionId != null) return String(eid) === myExecutionId;
  if (eid == null && seenRunning) return true;
  if (eid != null && myExecutionId == null) return true;
  return false;
}

export function isRunningPhase(phase: string | null | undefined): boolean {
  return ACTIVE_PHASES.has(String(phase ?? ''));
}

export function eventExecutionId(evt: WsEvent): string | null {
  const eid = evt.data?.executionId;
  return eid == null ? null : String(eid);
}
