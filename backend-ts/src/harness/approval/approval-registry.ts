import type { SessionMapper, SessionService, StreamingWsRegistry } from '../deps.js';
import { wsEvent } from '../deps.js';
import { harnessLog } from '../log.js';
import type { ApprovalHint } from './approval-hint.js';

/**
 * 审批广播参数上限（字节）。超过只广播前缀，全文仍只出现在发给执行端的 `tool_execute` 里，
 * 避免一次 write_file / edit_file 把整份文件正文推到该账号的所有端。
 */
export const APPROVAL_ARGUMENTS_BROADCAST_LIMIT = 8192;

/** 近期结果缓存：客户端重发投票时用来补发一次回声（覆盖投票帧 / 回声帧单向丢失）。 */
const RECENT_RESOLUTION_TTL_MS = 10 * 60 * 1000;
const RECENT_RESOLUTION_LIMIT = 200;

/** 登记审批时由调用方（LocalToolExecutor）提供的展示上下文。 */
export interface ApprovalContext {
  toolName: string;
  arguments: string;
  workspace: string;
  dangerReason: string | null;
}

/** 广播 / 重放用的审批请求载荷（arguments 已截断）。 */
export interface ApprovalRequestPayload {
  requestId: string;
  toolName: string;
  arguments: string;
  argumentsTruncated: boolean;
  workspace: string;
  dangerReason?: string;
  approvalHint?: ApprovalHint;
  deviceName?: string;
}

/** 认领结果：removed=false 表示这次调用输掉了仲裁，不得再建规则 / 广播。 */
export interface ApprovalClaim {
  removed: boolean;
  hint: ApprovalHint | null;
}

export interface ApprovalClaimDecision {
  approved: boolean | null;
  alwaysAllow: boolean;
}

export interface RecentResolution {
  approved: boolean | null;
  alwaysAllow: boolean;
}

interface ApprovalAnnouncement {
  requestId: string;
  sessionId: number;
  userId: number | null;
  deviceId: string | null;
  deviceName: string | null;
  toolName: string;
  arguments: string;
  argumentsTruncated: boolean;
  workspace: string;
  dangerReason: string | null;
  approvalHint: ApprovalHint | null;
  announcedAt: number;
}

/** 按 UTF-8 字节截断，且不切开多字节字符 / 代理对。 */
export function truncateApprovalArguments(
  raw: string,
  limit = APPROVAL_ARGUMENTS_BROADCAST_LIMIT,
): { text: string; truncated: boolean } {
  if (typeof raw !== 'string' || raw.length === 0) return { text: '', truncated: false };
  if (Buffer.byteLength(raw, 'utf8') <= limit) return { text: raw, truncated: false };
  let bytes = 0;
  let out = '';
  for (const ch of raw) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > limit) break;
    bytes += size;
    out += ch;
  }
  return { text: out, truncated: true };
}

export class ApprovalRegistry {
  private readonly pending = new Map<number, Set<string>>();
  /** 「总是允许」hint 存储会话内挂起的审批请求，key = `${sessionId}:${requestId}`。 */
  private readonly hints = new Map<string, ApprovalHint>();
  /** 待审批公告（广播 / 订阅重放 / 撤卡广播都用它），key 同 hints。 */
  private readonly announcements = new Map<string, ApprovalAnnouncement>();
  /** 已认领请求的近期结果，供客户端重发投票时补发回声。 */
  private readonly recentResolutions = new Map<string, RecentResolution & { at: number }>();

  constructor(
    private readonly sessionService: SessionService,
    private readonly sessionMapper: SessionMapper,
    private readonly streamingWsRegistry: StreamingWsRegistry,
  ) {}

  async register(
    sessionId: number | null,
    requestId: string | null,
    hint?: ApprovalHint | null,
    context?: ApprovalContext | null,
  ): Promise<void> {
    if (sessionId == null || requestId == null) return;
    const key = this.keyOf(sessionId, requestId);
    if (hint != null) {
      // 同 requestId 重发场景下后写覆盖前写；unregister/takeHint 时清除
      this.hints.set(key, hint);
    }
    let ids = this.pending.get(sessionId);
    if (!ids) {
      ids = new Set();
      this.pending.set(sessionId, ids);
    }
    const first = ids.size === 0;
    ids.add(requestId);
    if (first) {
      const entered = await this.sessionService.enterWaitingApproval(sessionId);
      if (entered) await this.publishPhase(sessionId, 'WAITING_APPROVAL');
      harnessLog('debug', `Session ${sessionId} entered WAITING_APPROVAL (requestId=${requestId}, entered=${entered})`);
    }
    if (context != null && !this.announcements.has(key)) {
      await this.announce(sessionId, requestId, hint ?? null, context);
    }
  }

  /**
   * 认领 + 收尾。同步段（首个 await 之前）完成摘除、取 hint、删公告、写近期结果，
   * 因此并发两帧只有先跑到这里的那个 removed=true；输的调用拿不到 hint，也不广播。
   * 摘除成功时在相位恢复之后广播 `tool_approval_resolved`（执行端据此放行 / 撤卡）。
   */
  async unregister(
    sessionId: number | null,
    requestId: string | null,
    decision?: ApprovalClaimDecision | null,
  ): Promise<ApprovalClaim> {
    if (sessionId == null || requestId == null) return { removed: false, hint: null };
    const key = this.keyOf(sessionId, requestId);
    const ids = this.pending.get(sessionId);
    if (!ids || !ids.has(requestId)) return { removed: false, hint: null };

    ids.delete(requestId);
    const hint = this.hints.get(key) ?? null;
    if (hint) this.hints.delete(key);
    const announcement = this.announcements.get(key) ?? null;
    this.announcements.delete(key);
    const empty = ids.size === 0;
    if (empty) this.pending.delete(sessionId);
    this.recentResolutions.set(key, {
      approved: decision?.approved ?? null,
      alwaysAllow: decision?.alwaysAllow === true,
      at: Date.now(),
    });
    this.pruneRecentResolutions();

    // 以下都是异步副作用；认领本身已经在上面同步完成
    if (empty) {
      const restored = await this.sessionService.restoreRunningAfterApproval(sessionId);
      if (restored) await this.publishPhase(sessionId, 'RUNNING');
    }
    if (announcement != null) {
      const payload: Record<string, unknown> = {
        requestId,
        approved: decision?.approved ?? null,
      };
      if (decision?.alwaysAllow === true) payload.alwaysAllow = true;
      this.broadcastResolved(announcement, payload);
    }
    return { removed: true, hint };
  }

  /**
   * 取回并清除 hint（恰好一次消费）。
   * 认领改造后 handleToolApproval 不再调用它（hint 从 unregister 的返回值取），保留给测试与历史调用点。
   */
  takeHint(sessionId: number, requestId: string): ApprovalHint | null {
    const key = this.keyOf(sessionId, requestId);
    const hint = this.hints.get(key) ?? null;
    if (hint) this.hints.delete(key);
    return hint;
  }

  /** 这一条审批是否还挂着。插入升级行之后用来判断人是否已经在插入期间点过。 */
  has(sessionId: number | null, requestId: string | null): boolean {
    if (sessionId == null || requestId == null) return false;
    return this.pending.get(sessionId)?.has(requestId) ?? false;
  }

  countForSession(sessionId: number | null): number {
    if (sessionId == null) return 0;
    return this.pending.get(sessionId)?.size ?? 0;
  }

  countForSessionIds(sessionIds: Iterable<number> | null): Map<number, number> {
    const result = new Map<number, number>();
    if (!sessionIds) return result;
    for (const sid of sessionIds) {
      const c = this.countForSession(sid);
      if (c > 0) result.set(sid, c);
    }
    return result;
  }

  /** 订阅重放：该会话当前所有待审批请求（arguments 已截断）。 */
  getPendingForSession(sessionId: number): ApprovalRequestPayload[] {
    const payloads: ApprovalRequestPayload[] = [];
    for (const announcement of this.announcements.values()) {
      if (announcement.sessionId !== sessionId) continue;
      payloads.push(this.toPayload(announcement));
    }
    return payloads;
  }

  /** 已认领请求的近期结果；客户端重发投票时用来只对该连接补发一次回声。 */
  getRecentResolution(sessionId: number, requestId: string): RecentResolution | null {
    const key = this.keyOf(sessionId, requestId);
    const hit = this.recentResolutions.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > RECENT_RESOLUTION_TTL_MS) {
      this.recentResolutions.delete(key);
      return null;
    }
    return { approved: hit.approved, alwaysAllow: hit.alwaysAllow };
  }

  private async announce(
    sessionId: number,
    requestId: string,
    hint: ApprovalHint | null,
    context: ApprovalContext,
  ): Promise<void> {
    const session = await this.sessionMapper.selectById(sessionId);
    if (!session) return;
    let userId = session.userId ?? null;
    if (userId == null && session.sessionType === 'SUBAGENT' && session.parentSessionId != null) {
      const parent = await this.sessionMapper.selectById(session.parentSessionId);
      userId = parent?.userId ?? null;
    }
    if (userId == null) {
      // 没有归属就只保留本地审批行为，不广播
      harnessLog('warn', `Skip approval broadcast: session ${sessionId} has no userId`);
      return;
    }
    const { text, truncated } = truncateApprovalArguments(context.arguments);
    const announcement: ApprovalAnnouncement = {
      requestId,
      sessionId,
      userId,
      deviceId: session.targetDeviceId ?? null,
      deviceName: session.targetDeviceName ?? null,
      toolName: context.toolName,
      arguments: text,
      argumentsTruncated: truncated,
      workspace: context.workspace ?? '',
      dangerReason: context.dangerReason ?? null,
      approvalHint: hint,
      announcedAt: Date.now(),
    };
    this.announcements.set(this.keyOf(sessionId, requestId), announcement);
    this.streamingWsRegistry.send(
      userId,
      wsEvent('tool_approval_request', sessionId, { ...this.toPayload(announcement) }),
    );
  }

  private broadcastResolved(announcement: ApprovalAnnouncement, payload: Record<string, unknown>): void {
    const userId = announcement.userId;
    if (userId == null) return;
    this.streamingWsRegistry.send(
      userId,
      wsEvent('tool_approval_resolved', announcement.sessionId, payload),
    );
  }

  private toPayload(announcement: ApprovalAnnouncement): ApprovalRequestPayload {
    const payload: ApprovalRequestPayload = {
      requestId: announcement.requestId,
      toolName: announcement.toolName,
      arguments: announcement.arguments,
      argumentsTruncated: announcement.argumentsTruncated,
      workspace: announcement.workspace,
    };
    if (announcement.dangerReason != null) payload.dangerReason = announcement.dangerReason;
    if (announcement.approvalHint != null) payload.approvalHint = announcement.approvalHint;
    if (announcement.deviceName != null) payload.deviceName = announcement.deviceName;
    return payload;
  }

  private pruneRecentResolutions(): void {
    if (this.recentResolutions.size <= RECENT_RESOLUTION_LIMIT) {
      const now = Date.now();
      for (const [key, value] of this.recentResolutions) {
        if (now - value.at > RECENT_RESOLUTION_TTL_MS) this.recentResolutions.delete(key);
      }
      return;
    }
    const now = Date.now();
    for (const [key, value] of this.recentResolutions) {
      if (now - value.at > RECENT_RESOLUTION_TTL_MS) this.recentResolutions.delete(key);
    }
    // Map 按插入序迭代：超上限时从最旧的开始删
    while (this.recentResolutions.size > RECENT_RESOLUTION_LIMIT) {
      const oldest = this.recentResolutions.keys().next();
      if (oldest.done) break;
      this.recentResolutions.delete(oldest.value);
    }
  }

  private keyOf(sessionId: number, requestId: string): string {
    return `${sessionId}:${requestId}`;
  }

  private async publishPhase(sessionId: number, phase: string): Promise<void> {
    const session = await this.sessionMapper.selectById(sessionId);
    if (!session?.userId) return;
    this.streamingWsRegistry.send(session.userId, wsEvent('session_status', sessionId, { phase }));
    this.streamingWsRegistry.send(session.userId, wsEvent('session_list_update', sessionId, { phase }));
  }
}
