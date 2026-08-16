/**
 * 会话消息搜索契约（桌面端搜索框消费）。
 * 后端 `/v1/sessions/search` 响应项；前端历史命名为 SessionSearchItem，结构与此一致。
 */
export interface MessageSearchItem {
  id: number;
  title?: string | null;
  sessionType?: string | null;
  parentSessionId?: number | null;
  updatedAt?: string | null;
  phase?: string | null;
  agentName?: string | null;
  snippet?: string | null;
}
