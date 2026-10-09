import { formatDateTime, shanghaiYmd, addDaysYmd } from '../common/json.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';
import type { ApiToken } from './types.js';
import type { OpenRunResult, OpenRunService } from './open-run.service.js';
import {
  bucketAnomalyFlags,
  buildCallSummary,
  countsTowardAutoDisable,
  countsTowardFailureNotice,
  fullBodyJson,
  isTrafficSpike,
  logicalRejection,
  messageFromFullJson,
  percentile,
  terminalOutcome,
  type LogicalRejection,
  type OpenCallOutcome,
  type OpenCallSource,
} from './open-api-call-log.logic.js';
import {
  OpenApiCallLogRepository,
  type CallLogListFilter,
  type OpenApiCallLogRow,
} from './open-api-call-log.repository.js';

const REJECT_LOG_PER_MINUTE = 20;
const P95_SAMPLE_LIMIT = 50_000;
const FAILURE_BUCKET_MS = 600_000;

export interface AuthRejectInput {
  reason: 'not_found' | 'revoked' | 'expired' | 'auto_disabled';
  tokenPrefix: string;
  tokenId?: number;
  userId?: number;
  sourceIp?: string | null;
}

export interface BeginCallInput {
  source: OpenCallSource;
  tokenId?: number | null;
  triggerId?: number | null;
  agentId?: number | null;
  userId?: number | null;
  sessionId?: number | null;
  sourceIp?: string | null;
  tokenPrefix?: string | null;
  body?: unknown;
  replayOfId?: number | null;
}

export interface DirectRejectInput {
  source: OpenCallSource;
  tokenId?: number | null;
  triggerId?: number | null;
  agentId?: number | null;
  userId?: number | null;
  sessionId?: number | null;
  sourceIp?: string | null;
  tokenPrefix?: string | null;
  body?: unknown;
  httpStatus: number;
  errorCode: string;
  errorSummary: string;
  /** 查无 token / 查无 pathToken 才按 IP 抑制。 */
  suppressByIp?: boolean;
  /** 鉴权层拒绝记流水但不计入自动停用与失败聚合。默认计入。 */
  account?: boolean;
}

interface FailureBucket {
  bucket: number;
  count: number;
  lastSummary: string;
  userId: number;
  tokenId: number;
  tokenName: string;
  errorCode: string;
}

export interface OpenApiCallLogDeps {
  repo: OpenApiCallLogRepository;
  rejectLimiter?: FixedWindowRateLimiter;
  tokens?: {
    findById(id: number): Promise<ApiToken | null>;
    recordTokenOutcome(tokenId: number, outcome: 'completed' | 'failed' | 'rejected' | 'cancelled'): Promise<void>;
  };
  inbox?: {
    recordOpenApiCallFailed(input: {
      userId: number;
      tokenId: number;
      tokenName: string;
      errorCode: string;
      count: number;
      summary: string;
      bucket: number;
    }): Promise<void>;
  };
  openRun?: Pick<OpenRunService, 'run'>;
  now?: () => number;
}

export class OpenApiCallLogService {
  private readonly limiter: FixedWindowRateLimiter;
  private readonly failures = new Map<string, FailureBucket>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly deps: OpenApiCallLogDeps) {
    this.limiter = deps.rejectLimiter ?? new FixedWindowRateLimiter();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    this.stopped = false;
    this.flushTimer = setInterval(() => { void this.flushFailures(); }, 60_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer != null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async recordAuthReject(input: AuthRejectInput): Promise<void> {
    const mapped = authRejectMapping(input.reason);
    // 鉴权层拒绝不计入自动停用，也不进单次失败聚合（停用通知另走 TOKEN_DISABLED）。
    await this.recordDirect({
      source: 'API',
      tokenId: input.tokenId ?? null,
      userId: input.userId ?? null,
      tokenPrefix: input.tokenPrefix.slice(0, 12),
      sourceIp: input.sourceIp ?? null,
      httpStatus: mapped.httpStatus,
      errorCode: mapped.errorCode,
      errorSummary: mapped.errorSummary,
      suppressByIp: input.reason === 'not_found',
      account: false,
    });
  }

  async recordDirect(input: DirectRejectInput): Promise<void> {
    try {
      if (input.suppressByIp && !this.limiter.allow(`rejectlog:${input.sourceIp || 'unknown'}`, REJECT_LOG_PER_MINUTE).allowed) {
        return;
      }
      const id = await this.deps.repo.insert({
        source: input.source,
        tokenId: input.tokenId ?? null,
        triggerId: input.triggerId ?? null,
        agentId: input.agentId ?? null,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        sourceIp: clipIp(input.sourceIp),
        tokenPrefix: input.tokenPrefix ?? null,
        requestSummaryJson: safeSummary(input.source, input.body),
        httpStatus: input.httpStatus,
        outcome: 'rejected',
        errorCode: input.errorCode,
        errorSummary: input.errorSummary,
        durationMs: 0,
        finishedAt: formatDateTime(this.now()),
      });
      if (input.account !== false) {
        await this.afterTerminal({
          id,
          source: input.source,
          tokenId: input.tokenId ?? null,
          userId: input.userId ?? null,
          replayOfId: null,
          outcome: 'rejected',
          errorCode: input.errorCode,
          errorSummary: input.errorSummary,
        });
      }
    } catch (e) {
      console.warn(`[openapi] failed to record rejected call: ${(e as Error).message}`);
    }
  }

  async begin(input: BeginCallInput): Promise<{ id: number; startedAt: number } | null> {
    const startedAt = this.now();
    try {
      const full = await this.fullBodyFor(input);
      const id = await this.deps.repo.insert({
        source: input.source,
        tokenId: input.tokenId ?? null,
        triggerId: input.triggerId ?? null,
        agentId: input.agentId ?? null,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        sourceIp: clipIp(input.sourceIp),
        tokenPrefix: input.tokenPrefix ?? null,
        requestSummaryJson: safeSummary(input.source, input.body),
        requestFullJson: full,
        outcome: 'pending',
        replayOfId: input.replayOfId ?? null,
      });
      return { id, startedAt };
    } catch (e) {
      console.warn(`[openapi] failed to begin call log: ${(e as Error).message}`);
      return null;
    }
  }

  async markRejected(id: number | null, startedAt: number, err: unknown | LogicalRejection): Promise<void> {
    if (id == null) return;
    const logical = isLogical(err) ? err : logicalRejection(err);
    const durationMs = Math.max(0, this.now() - startedAt);
    try {
      const changed = await this.deps.repo.markFinished(id, {
        outcome: 'rejected',
        httpStatus: logical.httpStatus,
        errorCode: logical.errorCode,
        errorSummary: logical.errorSummary,
        durationMs,
        executionMs: null,
        finishedAt: formatDateTime(this.now()),
      });
      if (!changed) return;
      const row = await this.deps.repo.findById(id);
      await this.afterTerminal({
        id,
        source: (row?.source ?? 'API') as OpenCallSource,
        tokenId: row?.tokenId ?? null,
        userId: row?.userId ?? null,
        replayOfId: row?.replayOfId ?? null,
        outcome: 'rejected',
        errorCode: logical.errorCode,
        errorSummary: logical.errorSummary,
      });
    } catch (e) {
      console.warn(`[openapi] failed to mark call rejected, id=${id}: ${(e as Error).message}`);
    }
  }

  async markAccepted(id: number | null, startedAt: number, result: OpenRunResult): Promise<void> {
    if (id == null) return;
    const durationMs = Math.max(0, this.now() - startedAt);
    const outcome: OpenCallOutcome = result.queued ? 'queued' : terminalOutcome(result.terminalPhase);
    try {
      const changed = await this.deps.repo.markFinished(id, {
        outcome,
        httpStatus: 202,
        errorCode: null,
        errorSummary: null,
        durationMs,
        executionMs: result.queued ? null : durationMs,
        finishedAt: result.queued ? null : formatDateTime(this.now()),
        sessionId: result.sessionId,
        messageId: result.messageId,
      });
      if (!changed || result.queued) return;
      const row = await this.deps.repo.findById(id);
      await this.afterTerminal({
        id,
        source: (row?.source ?? 'API') as OpenCallSource,
        tokenId: row?.tokenId ?? null,
        userId: row?.userId ?? null,
        replayOfId: row?.replayOfId ?? null,
        outcome,
        errorCode: null,
        errorSummary: null,
      });
    } catch (e) {
      console.warn(`[openapi] failed to mark call accepted, id=${id}: ${(e as Error).message}`);
    }
  }

  async settleQueued(callLogId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', queueWaitMs: number | null, messageId: number | null): Promise<void> {
    const outcome = terminalOutcome(phase);
    try {
      const row = await this.deps.repo.findById(callLogId);
      if (row == null) return;
      const changed = await this.deps.repo.settleQueued(callLogId, outcome, queueWaitMs, messageId, formatDateTime(this.now()));
      if (!changed) return;
      await this.afterTerminal({
        id: callLogId,
        source: (row.source ?? 'API') as OpenCallSource,
        tokenId: row.tokenId ?? null,
        userId: row.userId ?? null,
        replayOfId: row.replayOfId ?? null,
        outcome,
        errorCode: null,
        errorSummary: phase === 'FAILED' ? '执行失败' : null,
      });
    } catch (e) {
      console.warn(`[openapi] failed to settle queued call, id=${callLogId}: ${(e as Error).message}`);
    }
  }

  async listForUser(userId: number, page: number, size: number, filter: CallLogListFilter) {
    const safeSize = Math.min(100, Math.max(1, size));
    const safePage = Math.max(1, page);
    return this.deps.repo.list({ ...filter, userId }, safePage, safeSize);
  }

  async getForUser(userId: number, id: number): Promise<OpenApiCallLogRow | null> {
    return this.deps.repo.findById(id, userId);
  }

  async listForAdmin(page: number, size: number, filter: CallLogListFilter) {
    const safeSize = Math.min(100, Math.max(1, size));
    const safePage = Math.max(1, page);
    return this.deps.repo.list(filter, safePage, safeSize);
  }

  async getForAdmin(id: number): Promise<OpenApiCallLogRow> {
    const row = await this.deps.repo.findById(id);
    if (row == null) throw new BusinessException(ErrorCode.PARAM_INVALID, '调用记录不存在');
    return row;
  }

  async stats(input: {
    granularity: 'day' | 'token';
    startDate?: string;
    endDate?: string;
    tokenId?: number;
    agentId?: number;
  }) {
    const endDay = input.endDate && /^\d{4}-\d{2}-\d{2}$/.test(input.endDate) ? input.endDate : shanghaiYmd(new Date(this.now()));
    const startDay = input.startDate && /^\d{4}-\d{2}-\d{2}$/.test(input.startDate) ? input.startDate : addDaysYmd(endDay, -29);
    const filter: CallLogListFilter = {
      tokenId: input.tokenId,
      agentId: input.agentId,
      startAt: `${startDay} 00:00:00`,
      endAt: `${endDay} 23:59:59`,
    };
    const unknownBefore = formatDateTime(this.now() - 2 * 60 * 60 * 1000);
    const buckets = await this.deps.repo.aggregate(filter, input.granularity, unknownBefore);
    const today = shanghaiYmd(new Date(this.now()));
    const windowIncludesToday = startDay <= today && endDay >= today;
    const spikes = new Map<number, boolean>();
    if (input.granularity === 'token' && windowIncludesToday) {
      for (const row of await this.deps.repo.trafficByToken()) {
        if (row.tokenId == null) continue;
        spikes.set(Number(row.tokenId), isTrafficSpike(Number(row.today), Number(row.prev7)));
      }
    }
    const normalized = buckets.map((row) => {
      const counts = {
        total: Number(row.total),
        completed: Number(row.completed),
        failed: Number(row.failed),
        cancelled: Number(row.cancelled),
        rejected: Number(row.rejected),
        inFlight: Number(row.inFlight),
        unknown: Number(row.unknown),
      };
      const flags = bucketAnomalyFlags(counts);
      const tokenId = input.granularity === 'token' && row.bucket != null ? Number(row.bucket) : null;
      return {
        bucket: row.bucket == null ? null : String(row.bucket).slice(0, 10),
        ...counts,
        ...flags,
        trafficSpike: tokenId != null && spikes.get(tokenId) === true,
      };
    });
    const sample = await this.deps.repo.sampleLatencies(filter, P95_SAMPLE_LIMIT + 1);
    const truncated = sample.length > P95_SAMPLE_LIMIT;
    const used = truncated ? sample.slice(0, P95_SAMPLE_LIMIT) : sample;
    const execution = used.map((row) => row.executionMs).filter((n): n is number => n != null);
    const queue = used.map((row) => row.queueWaitMs).filter((n): n is number => n != null);
    const summary = normalized.reduce((acc, row) => {
      acc.total += row.total;
      acc.completed += row.completed;
      acc.failed += row.failed;
      acc.cancelled += row.cancelled;
      acc.rejected += row.rejected;
      acc.inFlight += row.inFlight;
      acc.unknown += row.unknown;
      return acc;
    }, { total: 0, completed: 0, failed: 0, cancelled: 0, rejected: 0, inFlight: 0, unknown: 0 });
    const executed = summary.completed + summary.failed;
    return {
      startDate: startDay,
      endDate: endDay,
      granularity: input.granularity,
      summary: {
        ...summary,
        successRate: executed === 0 ? null : summary.completed / executed,
        p95ExecutionMs: percentile(execution, 95),
        p95QueueWaitMs: percentile(queue, 95),
        p95Truncated: truncated,
      },
      buckets: normalized,
    };
  }

  async replay(rowId: number, messageOverride: string | undefined): Promise<OpenRunResult> {
    const row = await this.deps.repo.findById(rowId);
    if (row?.id == null) throw new BusinessException(ErrorCode.PARAM_INVALID, '调用记录不存在');
    if (row.source !== 'API') throw new BusinessException(ErrorCode.PARAM_INVALID, 'Webhook 调用不支持服务端重发');
    if (row.userId == null || row.agentId == null) throw new BusinessException(ErrorCode.PARAM_INVALID, '这条流水缺少用户或 Agent，无法重发');
    if (row.tokenId == null) throw new BusinessException(ErrorCode.PARAM_INVALID, '无效 Token 的调用无法重发');
    const token = await this.deps.tokens?.findById(row.tokenId);
    if (token == null || token.revokedAt != null) throw new BusinessException(ErrorCode.FORBIDDEN, 'Token 已吊销，无法重发');
    if (token.expiresAt != null && token.expiresAt <= formatDateTime(this.now())) {
      throw new BusinessException(ErrorCode.FORBIDDEN, 'Token 已过期，无法重发');
    }
    if (token.autoDisabledAt != null) throw new BusinessException(ErrorCode.TOKEN_AUTO_DISABLED);
    const agentId = row.agentId;
    const message = messageOverride?.trim()
      ? messageOverride
      : messageFromFullJson(row.requestFullJson);
    if (message == null || message.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '没有可重发的 message，请手工粘贴后再试');
    }
    if (this.deps.openRun == null) throw new BusinessException(ErrorCode.INTERNAL_ERROR, '重放未装配');
    const begun = await this.begin({
      source: 'API',
      tokenId: row.tokenId,
      userId: row.userId,
      agentId,
      sessionId: row.sessionId ?? null,
      tokenPrefix: token.tokenPrefix ?? row.tokenPrefix ?? null,
      body: { message, sessionId: row.sessionId ?? null },
      replayOfId: row.id,
    });
    try {
      const result = await this.deps.openRun.run({
        userId: row.userId,
        agentId,
        message,
        sessionId: row.sessionId ?? null,
        source: 'API',
        callLogId: begun?.id ?? null,
      });
      await this.markAccepted(begun?.id ?? null, begun?.startedAt ?? this.now(), result);
      return result;
    } catch (e) {
      await this.markRejected(begun?.id ?? null, begun?.startedAt ?? this.now(), e);
      throw e;
    }
  }

  /** 测试与定时器共用：写出已经结束的 10 分钟桶。 */
  async flushFailures(now = this.now()): Promise<void> {
    if (this.stopped && this.flushTimer == null) {
      // stop() 之后定时器不再跑；测试直接调用仍允许 flush 当前已完成桶
    }
    const current = Math.floor(now / FAILURE_BUCKET_MS);
    const due = [...this.failures.entries()].filter(([, bucket]) => bucket.bucket < current);
    for (const [key, bucket] of due) {
      this.failures.delete(key);
      try {
        await this.deps.inbox?.recordOpenApiCallFailed({
          userId: bucket.userId,
          tokenId: bucket.tokenId,
          tokenName: bucket.tokenName,
          errorCode: bucket.errorCode,
          count: bucket.count,
          summary: bucket.lastSummary,
          bucket: bucket.bucket,
        });
      } catch (e) {
        console.warn(`[openapi] failed to flush call-failed notice: ${(e as Error).message}`);
      }
    }
  }

  private async fullBodyFor(input: BeginCallInput): Promise<string | null> {
    if (input.source !== 'API' || input.tokenId == null || input.body == null) return null;
    const token = await this.deps.tokens?.findById(input.tokenId);
    if (token == null || Number(token.logFullBody) !== 1) return null;
    return fullBodyJson(input.body);
  }

  private async afterTerminal(input: {
    id: number;
    source: OpenCallSource;
    tokenId: number | null;
    userId: number | null;
    replayOfId: number | null;
    outcome: OpenCallOutcome;
    errorCode: string | null;
    errorSummary: string | null;
  }): Promise<void> {
    if (countsTowardAutoDisable(input)) {
      await this.deps.tokens?.recordTokenOutcome(input.tokenId!, input.outcome as 'completed' | 'failed' | 'rejected');
    }
    if (input.source === 'API' && input.tokenId != null && input.userId != null
      && input.replayOfId == null && countsTowardFailureNotice(input.errorCode, input.outcome)) {
      await this.noteFailure({
        tokenId: input.tokenId,
        userId: input.userId,
        errorCode: input.errorCode ?? 'FAILED',
        summary: input.errorSummary ?? '',
      });
    }
  }

  private async noteFailure(input: { tokenId: number; userId: number; errorCode: string; summary: string }): Promise<void> {
    const bucket = Math.floor(this.now() / FAILURE_BUCKET_MS);
    const key = `${input.tokenId}:${input.errorCode}`;
    const existing = this.failures.get(key);
    if (existing != null && existing.bucket === bucket) {
      existing.count += 1;
      existing.lastSummary = input.summary;
      return;
    }
    // 先同步占住当前桶，再去查 Token 名称。否则两次失败叠在 findById 上时，后完成的那次会用 count:1 盖掉已累加的次数。
    const stale = existing != null && existing.bucket < bucket ? existing : null;
    const entry: FailureBucket = {
      bucket,
      count: 1,
      lastSummary: input.summary,
      userId: input.userId,
      tokenId: input.tokenId,
      tokenName: '',
      errorCode: input.errorCode,
    };
    this.failures.set(key, entry);
    if (stale != null) {
      await this.deps.inbox?.recordOpenApiCallFailed({
        userId: stale.userId,
        tokenId: stale.tokenId,
        tokenName: stale.tokenName,
        errorCode: stale.errorCode,
        count: stale.count,
        summary: stale.lastSummary,
        bucket: stale.bucket,
      }).catch((e) => console.warn(`[openapi] failed to flush previous failure bucket: ${(e as Error).message}`));
    }
    const token = await this.deps.tokens?.findById(input.tokenId);
    entry.tokenName = token?.name ?? '';
  }
}

function authRejectMapping(reason: AuthRejectInput['reason']): { httpStatus: number; errorCode: string; errorSummary: string } {
  switch (reason) {
    case 'revoked':
      return { httpStatus: 401, errorCode: 'TOKEN_REVOKED', errorSummary: 'Token 已吊销' };
    case 'expired':
      return { httpStatus: 401, errorCode: 'TOKEN_EXPIRED', errorSummary: 'Token 已过期' };
    case 'auto_disabled':
      return { httpStatus: 403, errorCode: 'TOKEN_AUTO_DISABLED', errorSummary: 'Token 已因连续失败被自动停用' };
    default:
      return { httpStatus: 401, errorCode: 'TOKEN_INVALID', errorSummary: 'Token 无效' };
  }
}

function isLogical(value: unknown): value is LogicalRejection {
  return value != null && typeof value === 'object' && 'httpStatus' in value && 'errorCode' in value && 'errorSummary' in value
    && !(value instanceof Error);
}

function safeSummary(source: OpenCallSource, body: unknown): string | null {
  if (body == null) return null;
  try {
    return buildCallSummary(source, body);
  } catch {
    return null;
  }
}

function clipIp(ip: string | null | undefined): string | null {
  if (ip == null || ip === '') return null;
  return ip.length <= 45 ? ip : ip.slice(0, 45);
}

export function defaultCallStatsRange(now = new Date()): { startDate: string; endDate: string } {
  const endDate = shanghaiYmd(now);
  return { startDate: addDaysYmd(endDate, -29), endDate };
}
