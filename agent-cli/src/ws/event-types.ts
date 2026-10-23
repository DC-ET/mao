/**
 * WS 下行事件信封。对齐来源：backend-ts/src/session/ws/ws-event.ts
 * 信封统一为 { type, sessionId, data }，字段都在 data 里。
 */
export interface WsEvent {
  type: string;
  sessionId: number | null;
  data: Record<string, unknown> | null;
}

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskQuestionOption[];
  multiSelect?: boolean;
}

export interface AskAnswer {
  question: string;
  selectedLabels: string[];
  customInput?: string;
}

export interface TodoItem {
  id?: string | number;
  content?: string;
  status?: string;
}

export const TERMINAL_PHASES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
// 活跃相位与后端唯一口径（backend-ts/src/session/util/session-group-key.ts）、桌面端
// types.ts、契约 shared/contracts 对齐：RESUMING（崩溃恢复/重试执行中）与 CANCELLING
// （取消流程进行中）都是「会话还在跑」，漏列会把恢复中/取消中的会话当成空闲——
// --if-running=fail 不再快速失败、--if-running=cancel 不发取消，REPL 也误报空闲。
export const ACTIVE_PHASES = new Set(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING']);
