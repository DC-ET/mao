/**
 * 全局消息搜索契约。`/v1/sessions/search` 按会话分组返回命中消息。
 */

/** 单条命中消息 */
export interface MessageSearchHit {
  messageId: number;
  role: string;
  snippet: string;
  createdAt: string | null;
}

/** 按会话分组的搜索结果 */
export interface MessageSearchGroup {
  sessionId: number;
  title?: string | null;
  sessionType?: string | null;
  parentSessionId?: number | null;
  /** 边路会话所属的根主会话 id；主会话即自身 id；孤儿缺省 null */
  rootSessionId?: number | null;
  updatedAt?: string | null;
  phase?: string | null;
  status?: string | null;
  agentId?: number | null;
  agentName?: string | null;
  /** 可见命中条数。抽样里有假命中被丢掉时等于实际展示条数，否则为 SQL 总命中数（可大于 hits.length） */
  hitCount: number;
  hits: MessageSearchHit[];
}

export interface MessageSearchResult {
  items: MessageSearchGroup[];
  total: number;
  page: number;
  size: number;
  path: 'FULLTEXT' | 'LIKE';
}
