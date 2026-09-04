/**
 * 会话生命周期管理：创建/复用/新对话。
 * 复用策略（设计文档 2.2）：仅复用 SDK 自己创建的会话，localStorage 持久化，key 含 agentId。
 */
import type { EmbedCreateSessionRequest, EmbedSessionVO } from '@mao/contracts';
import type { RestClient } from './rest-client';

export interface SessionManagerDeps {
  rest: RestClient;
  agentId: number;
}

function storageKey(agentId: number): string {
  return `mao_embed_session_${agentId}`;
}

export class SessionManager {
  constructor(private readonly deps: SessionManagerDeps) {}

  /**
   * 恢复或创建常驻会话。
   * localStorage 中的会话：归属校验失败 / 已删除（GET 404）→ 清除记录并新建。
   */
  async resolveSession(): Promise<EmbedSessionVO> {
    const stored = this.readStoredSessionId();
    if (stored != null) {
      try {
        const session = await this.deps.rest.request<EmbedSessionVO>('GET', `/sessions/${stored}`);
        return session;
      } catch (err) {
        if (!(err instanceof Error) || (err as { status?: number }).status !== 404) {
          // 网络/服务端异常：不当作会话丢失，向上抛出由 UI 提示重试
          throw err;
        }
        this.clearStoredSessionId();
      }
    }
    return this.createSession();
  }

  async createSession(): Promise<EmbedSessionVO> {
    const body: EmbedCreateSessionRequest = {
      agentId: this.deps.agentId,
      title: '网页助手',
    };
    const session = await this.deps.rest.request<EmbedSessionVO>('POST', '/sessions', { body });
    this.writeStoredSessionId(session.id);
    return session;
  }

  /** “新对话”：不删除旧会话（保留在 desktop 列表），替换本地记录 */
  async startNewSession(): Promise<EmbedSessionVO> {
    const session = await this.createSession();
    return session;
  }

  readStoredSessionId(): number | null {
    try {
      const raw = window.localStorage.getItem(storageKey(this.deps.agentId));
      if (!raw) return null;
      const id = Number(raw);
      return Number.isFinite(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  }

  writeStoredSessionId(id: number) {
    try {
      window.localStorage.setItem(storageKey(this.deps.agentId), String(id));
    } catch {
      /* 隐私模式等场景下 localStorage 不可用：退化为每次新建会话 */
    }
  }

  clearStoredSessionId() {
    try {
      window.localStorage.removeItem(storageKey(this.deps.agentId));
    } catch {
      /* ignore */
    }
  }
}
