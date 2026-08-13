export interface WsEvent {
  type: string;
  sessionId: number | null;
  data: Record<string, unknown> | null;
}

export function wsEvent(type: string, sessionId: number | null, data: Record<string, unknown>): WsEvent {
  return { type, sessionId, data };
}
