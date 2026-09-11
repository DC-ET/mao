/**
 * 会话生命周期管理：创建/复用/新对话。
 * 复用策略（设计文档 2.2）：仅复用 SDK 自己创建的会话，localStorage 持久化，key 含 agentId。
 */
import type { EmbedCreateSessionRequest, EmbedSessionPage, EmbedSessionVO } from '@mao/contracts';
import { ApiError } from './rest-client';
import type { RestClient } from './rest-client';

export interface SessionManagerDeps {
  rest: RestClient;
  agentId: number;
  scope?: () => string;
}

function storageKey(agentId: number, scope: string): string {
  return `mao_embed_session_${scope}_${agentId}`;
}

/** 后端业务码：会话不存在 */
const CODE_SESSION_NOT_FOUND = 3002;
/** 后端业务码：无权访问（归属校验失败，HTTP 403） */
const CODE_FORBIDDEN = 1002;

/**
 * 会话记录是否已失效（应清除 localStorage 并新建）。
 * 后端 handleError 语义：业务异常走 HTTP 200 + body.code，仅 1002/403 提升为 HTTP 403，
 * 因此不能用 HTTP 404 判定（后端从不返回 404）。
 */
function isSessionGone(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code === CODE_SESSION_NOT_FOUND || err.code === CODE_FORBIDDEN) return true;
  return err.status === 403 || err.status === 404;
}

export class SessionManager {
  constructor(private readonly deps: SessionManagerDeps) {}

  /**
   * 恢复或创建常驻会话。
   * localStorage 中的会话：已删除（code 3002）/ 归属校验失败（code 1002 或 HTTP 403）→ 清除记录并新建。
   */
  async resolveSession(): Promise<EmbedSessionVO> {
    const stored = this.readStoredSessionId();
    if (stored != null) {
      try {
        const session = await this.deps.rest.request<EmbedSessionVO>('GET', `/sessions/${stored}`);
        return session;
      } catch (err) {
        if (!isSessionGone(err)) {
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
      source: 'embed',
    };
    const session = await this.deps.rest.request<EmbedSessionVO>('POST', '/sessions', { body });
    this.writeStoredSessionId(session.id);
    return session;
  }

  /**
   * 历史会话列表：仅当前 agent、SDK 创建（source=embed）的主会话，updated_at 倒序。
   */
  async listSessions(offset = 0, limit = 20): Promise<EmbedSessionPage> {
    return this.deps.rest.request<EmbedSessionPage>(
      'GET',
      `/sessions?source=embed&agentId=${this.deps.agentId}&offset=${offset}&limit=${limit}`,
    );
  }

  /**
   * 存量常驻会话惰性标记：恢复的会话若还是 web 来源，补标为 embed（后端幂等）。
   * 失败不阻断恢复流程——列表里缺它只是少一条记录，聊天不受影响。
   */
  async markSourceEmbed(session: EmbedSessionVO): Promise<void> {
    if (session.source === 'embed') return;
    try {
      await this.deps.rest.request<EmbedSessionVO>('PUT', `/sessions/${session.id}/source`, {
        body: { source: 'embed' },
      });
    } catch {
      /* 静默降级 */
    }
  }

  /** “新对话”：不删除旧会话（保留在 desktop 列表），替换本地记录 */
  async startNewSession(): Promise<EmbedSessionVO> {
    const session = await this.createSession();
    return session;
  }

  /** 历史列表切换：目标会话已存在，仅更新本地常驻指针 */
  adoptSession(session: EmbedSessionVO): void {
    this.writeStoredSessionId(session.id);
  }

  readStoredSessionId(): number | null {
    try {
      const raw = window.localStorage.getItem(storageKey(this.deps.agentId, this.deps.scope?.() ?? 'isolated'));
      if (!raw) return null;
      const id = Number(raw);
      return Number.isFinite(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  }

  writeStoredSessionId(id: number) {
    try {
      window.localStorage.setItem(storageKey(this.deps.agentId, this.deps.scope?.() ?? 'isolated'), String(id));
    } catch {
      /* 隐私模式等场景下 localStorage 不可用：退化为每次新建会话 */
    }
  }

  clearStoredSessionId() {
    try {
      window.localStorage.removeItem(storageKey(this.deps.agentId, this.deps.scope?.() ?? 'isolated'));
    } catch {
      /* ignore */
    }
  }
}
