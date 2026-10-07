import { parseShanghaiDateTime } from '../auth/auth.service.js';
import type { AuditLog } from '../audit/types.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { javaLocalDateTimeString } from '../common/datetime.js';
import { formatDateTime } from '../common/json.js';
import type { UserRepository } from '../user/types.js';
import type { AgentLookup, Session } from './types.js';
import type { SessionService } from './session.service.js';
import { toMessageVOList, type MessageVO } from './session-vo.js';
import {
  isDuplicateKey,
  newShareToken,
  nowSql,
  type SessionShareRow,
  type SessionShareStore,
} from './session-share.repository.js';

export interface SessionShareVO {
  token: string;
  messageWatermark: number;
  viewCount: number;
  createdAt: string | null;
  expiresAt: string | null;
  lastViewedAt: string | null;
}

export interface ShareViewPayload {
  session: {
    id: number;
    title: string | null;
    agentName: string | null;
    ownerName: string;
    createdAt: string | null;
    sessionType: string | null;
  };
  share: { createdAt: string | null; viewCount: number };
  messages: MessageVO[];
  hasMore: boolean;
  nextBeforeMessageId: number | null;
}

export interface ShareAuditRecorder {
  record(log: AuditLog): Promise<number>;
}

export interface CreateShareInput {
  publicLink?: boolean;
  expiresInDays?: number | null;
}

const TOKEN_INSERT_ATTEMPTS = 3;

export class SessionShareService {
  constructor(
    private readonly shares: SessionShareStore,
    private readonly sessionService: SessionService,
    private readonly users: UserRepository,
    private readonly agents: AgentLookup,
    private readonly audit: ShareAuditRecorder,
    private readonly tokenLinksEnabled: () => Promise<boolean>,
  ) {}

  async getActive(sessionId: number): Promise<SessionShareVO | null> {
    const row = await this.shares.findActiveBySession(sessionId);
    return row == null ? null : toShareVO(row);
  }

  /**
   * 一会话一活跃链接。事务内 FOR UPDATE 后复查：已有未撤销行则原样返回（不改水位、不改过期）。
   * token 唯一键冲突时换 token 重试。
   */
  async create(
    session: Session,
    userId: number,
    input: CreateShareInput = {},
  ): Promise<SessionShareVO> {
    const publicLink = input.publicLink === true;
    let expiresAt: string | null = null;
    if (publicLink) {
      if (!(await this.tokenLinksEnabled())) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '匿名分享链接未开启');
      }
      const days = input.expiresInDays == null ? 7 : input.expiresInDays;
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'expiresInDays 需为 1～365 的整数');
      }
      expiresAt = formatDateTime(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
    }
    const created = await this.shares.transaction(async (tx) => {
      const locked = await tx.lockBySession(session.id!);
      const active = locked.find((row) => row.revokedAt == null);
      if (active) return { row: active, inserted: false };
      const watermark = await this.sessionService.getMaxMessageId(session.id!);
      const row = await insertWithTokenRetry(tx, {
        sessionId: session.id!,
        messageWatermark: watermark,
        createdBy: userId,
        expiresAt,
      });
      return { row, inserted: true };
    });
    if (created.inserted) {
      void this.recordAudit('CREATE', created.row, userId, 'POST', `/v1/sessions/${session.id}/share`);
    }
    return toShareVO(created.row);
  }

  /** 水位取当前未删除消息的最大 id，编辑重发截断后允许回落。 */
  async refresh(sessionId: number): Promise<SessionShareVO> {
    const active = await this.shares.findActiveBySession(sessionId);
    if (active == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '尚未创建分享');
    }
    const watermark = await this.sessionService.getMaxMessageId(sessionId);
    await this.shares.updateWatermark(active.id, watermark);
    return toShareVO({ ...active, messageWatermark: watermark });
  }

  async revoke(sessionId: number, userId: number): Promise<void> {
    const active = await this.shares.findActiveBySession(sessionId);
    if (active == null) return;
    const revokedAt = nowSql();
    await this.shares.revoke(active.id, revokedAt);
    void this.recordAudit('DELETE', { ...active, revokedAt }, userId, 'DELETE', `/v1/sessions/${sessionId}/share`);
  }

  async readView(
    token: string,
    roundLimit: number,
    beforeMessageId: number | null,
    viewerId: number | null,
    path: string,
    publicOnly = false,
  ): Promise<ShareViewPayload> {
    const share = await this.requireReadable(token, publicOnly);
    const session = await this.requireLiveSession(share);
    const parentId = sideTaskParentId(session);
    const page = await this.sessionService.getMessagesByRounds(session.id!, roundLimit, beforeMessageId, {
      maxMessageId: Number(share.messageWatermark),
      excludeSourceSessionId: parentId,
    });
    const visible = withoutParentCopies(page.messages, parentId);
    const changes = await this.sessionService.getFileChangeSummariesByMessageIds(
      session.id!,
      visible.map((m) => m.id!),
    );
    const messages = toMessageVOList(visible, changes).map((message) => {
      message.thinkingContent = null;
      return message;
    });
    const viewCount = Number(share.viewCount ?? 0);
    if (beforeMessageId == null) {
      const viewedAt = nowSql();
      void this.shares.incrementView(share.id, viewedAt).catch((e) => {
        console.error('Failed to increment share view count', e);
      });
      void this.recordAudit('READ', share, viewerId, 'GET', path);
    }
    const owner = await this.users.findById(session.userId);
    const agent = session.agentId != null ? await this.agents.findById(session.agentId) : null;
    return {
      session: {
        id: session.id!,
        title: session.title ?? null,
        agentName: agent?.name ?? null,
        ownerName: owner?.displayName || owner?.username || '用户',
        createdAt: javaLocalDateTimeString(session.createdAt),
        sessionType: session.sessionType ?? null,
      },
      share: {
        createdAt: javaLocalDateTimeString(share.createdAt),
        viewCount,
      },
      messages,
      hasMore: page.hasMore,
      nextBeforeMessageId: page.nextBeforeMessageId,
    };
  }

  private async requireReadable(token: string, publicOnly: boolean): Promise<SessionShareRow> {
    const share = await this.shares.findByToken(token);
    // 登录链接 expires_at 恒为 NULL。公开端点只接受匿名链接，避免开关开启后旧链接被免登录读出。
    const notPublic = publicOnly && (share?.expiresAt == null || share.expiresAt === '');
    if (share == null || share.revokedAt != null || notPublic || isExpired(share.expiresAt)) {
      throw new BusinessException(ErrorCode.SHARE_NOT_FOUND);
    }
    return share;
  }

  private async requireLiveSession(share: SessionShareRow): Promise<Session> {
    let session: Session;
    try {
      session = await this.sessionService.getSession(share.sessionId);
    } catch (e) {
      if (e instanceof BusinessException && e.code === ErrorCode.SESSION_NOT_FOUND.code) {
        throw new BusinessException(ErrorCode.SHARE_NOT_FOUND);
      }
      throw e;
    }
    const owner = await this.users.findById(session.userId);
    if (owner == null || owner.status === 0 || owner.deleted === 1) {
      throw new BusinessException(ErrorCode.SHARE_NOT_FOUND);
    }
    return session;
  }

  private recordAudit(
    action: 'CREATE' | 'READ' | 'DELETE',
    share: SessionShareRow,
    userId: number | null,
    method: string,
    path: string,
  ): void {
    void this.audit.record({
      action,
      objectType: 'session.share',
      objectId: `${share.shareToken.slice(0, 8)}:${share.id}`,
      method,
      path: redactShareToken(path, share.shareToken),
      userId,
      status: 200,
      success: 1,
    }).catch((e) => console.error('Failed to record session share audit', e));
  }
}

async function insertWithTokenRetry(
  tx: SessionShareStore,
  input: { sessionId: number; messageWatermark: number; createdBy: number; expiresAt: string | null },
): Promise<SessionShareRow> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TOKEN_INSERT_ATTEMPTS; attempt++) {
    const shareToken = newShareToken();
    try {
      const id = await tx.insert({
        sessionId: input.sessionId,
        shareToken,
        messageWatermark: input.messageWatermark,
        createdBy: input.createdBy,
        viewCount: 0,
        expiresAt: input.expiresAt,
      });
      return {
        id,
        sessionId: input.sessionId,
        shareToken,
        messageWatermark: input.messageWatermark,
        createdBy: input.createdBy,
        viewCount: 0,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: nowSql(),
      };
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new BusinessException(ErrorCode.INTERNAL_ERROR);
}

function toShareVO(row: SessionShareRow): SessionShareVO {
  return {
    token: row.shareToken,
    messageWatermark: Number(row.messageWatermark ?? 0),
    viewCount: Number(row.viewCount ?? 0),
    createdAt: javaLocalDateTimeString(row.createdAt),
    expiresAt: javaLocalDateTimeString(row.expiresAt),
    lastViewedAt: javaLocalDateTimeString(row.lastViewedAt),
  };
}

function redactShareToken(path: string, token: string): string {
  if (!token) return path;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return path.replace(new RegExp(escaped, 'ig'), '{token}');
}

function sideTaskParentId(session: Session): number | null {
  if (session.sessionType !== 'SIDE_TASK' || session.parentSessionId == null) return null;
  const id = Number(session.parentSessionId);
  return Number.isFinite(id) ? id : null;
}

function withoutParentCopies<T extends { sourceSessionId?: number | null }>(rows: T[], parentId: number | null): T[] {
  if (parentId == null) return rows;
  return rows.filter((row) => row.sourceSessionId == null || Number(row.sourceSessionId) !== parentId);
}

function isExpired(expiresAt: string | null | undefined): boolean {
  if (expiresAt == null || expiresAt === '') return false;
  const parsed = parseShanghaiDateTime(expiresAt);
  if (!Number.isFinite(parsed)) return true;
  return parsed <= Date.now();
}
