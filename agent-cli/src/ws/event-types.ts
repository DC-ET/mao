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
export const ACTIVE_PHASES = new Set(['RUNNING', 'WAITING_APPROVAL']);
