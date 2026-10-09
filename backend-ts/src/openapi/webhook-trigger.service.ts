import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { formatDateTime } from '../common/json.js';
import type { Session } from '../domain/types.js';
import type { WebhookSecretCipher } from '../notification/task/webhook-secret-cipher.js';
import type { FixedWindowRateLimiter } from './rate-limiter.js';
import type { MysqlWebhookTriggerRepository } from './openapi.repository.js';
import { generatePathToken, generateWebhookSecret, verifyHmacSignature } from './hmac.js';
import type { OpenRunResult, OpenRunService } from './open-run.service.js';
import type { OpenApiCallLogService } from './open-api-call-log.service.js';

/** 连续失败自动停用阈值（技术方案决策 8）。 */
export const TRIGGER_DISABLE_AFTER_FAILURES = 5;
/** 每用户触发器数量上限。 */
export const MAX_TRIGGERS_PER_USER = 20;
/** 绑定会话的触发器限流档（次/分钟）。 */
export const TRIGGER_RATE_LIMIT_BOUND = 30;
/** 未绑定会话（每次新建会话）的触发器限流降档（次/分钟）。 */
export const TRIGGER_RATE_LIMIT_UNBOUND = 10;

/** 查无触发器时的假 secret：对随机 dummy 做等长 HMAC 比较，防时序区分（决策 10）。 */
const DUMMY_TRIGGER_SECRET = 'mao-openapi-dummy-trigger-secret-0123456789abcdef0123456789abcdef';

/** 触发器停用通知（收件箱 TRIGGER_DISABLED kind），create-app 装配层适配 InboxService。 */
export interface TriggerDisableNotifier {
  notifyTriggerDisabled(input: {
    userId: number;
    triggerId: number;
    triggerName: string;
    sessionId: number | null;
    failures: number;
  }): Promise<void>;
}

export interface WebhookTriggerDeps {
  triggerRepo: MysqlWebhookTriggerRepository;
  sessionService: {
    getSession(id: number): Promise<Session | null>;
  };
  agentLookup: {
    findById(id: number): Promise<{ id?: number; enabled?: number | null } | null>;
  };
  cipher: WebhookSecretCipher;
  openRun: OpenRunService;
  rateLimiter: FixedWindowRateLimiter;
  disableNotifier?: TriggerDisableNotifier | null;
  callLog?: OpenApiCallLogService | null;
}

export interface CreateTriggerInput {
  name: string;
  agentId: number;
  sessionId?: number | null;
}

export interface CreatedTrigger {
  id: number;
  pathToken: string;
  /** 明文 secret 仅此一次返回。 */
  plainSecret: string;
}

export interface HookFireHeaders {
  timestamp: string | undefined | null;
  signature: string | undefined | null;
}

export type HookFireOutcome =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number }
  | { ok: true; userId: number; sessionId: number; queued: boolean };

/**
 * 入站 Webhook 触发器（P2）：签发/管理 + HMAC 验签 + 触发 + 连续失败自动停用。
 */
export class WebhookTriggerService {
  constructor(private readonly deps: WebhookTriggerDeps) {}

  async create(userId: number, input: CreateTriggerInput): Promise<CreatedTrigger> {
    const name = input.name?.trim() ?? '';
    if (name.length === 0 || name.length > 128) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '触发器名称需为 1~128 字符');
    }
    const agent = await this.deps.agentLookup.findById(input.agentId);
    if (agent == null || agent.id == null) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    if (agent.enabled === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该 Agent 已停用，无法绑定触发器');
    }
    await this.assertBindableSession(userId, input.sessionId ?? null, input.agentId);
    const count = await this.deps.triggerRepo.countByUser(userId);
    if (count >= MAX_TRIGGERS_PER_USER) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `每用户最多 ${MAX_TRIGGERS_PER_USER} 个触发器，请先删除不用的触发器`);
    }
    const pathToken = generatePathToken();
    const plainSecret = generateWebhookSecret();
    const id = await this.deps.triggerRepo.insert({
      userId,
      agentId: input.agentId,
      sessionId: input.sessionId ?? null,
      name,
      pathToken,
      secretCipher: this.deps.cipher.encrypt(plainSecret),
      enabled: 1,
    });
    return { id, pathToken, plainSecret };
  }

  async list(userId: number): Promise<Array<{ id: number; name: string; agentId: number; sessionId: number | null; enabled: boolean; pathToken: string; consecutiveFailures: number; lastFiredAt: string | null; createdAt: string | null }>> {
    const rows = await this.deps.triggerRepo.listByUser(userId);
    return rows.map((row) => ({
      id: row.id!,
      name: row.name ?? '',
      agentId: row.agentId ?? 0,
      sessionId: row.sessionId ?? null,
      enabled: Number(row.enabled) === 1,
      // pathToken 出域由路由层拼 URL；secret 不回显
      pathToken: row.pathToken ?? '',
      consecutiveFailures: Number(row.consecutiveFailures ?? 0),
      lastFiredAt: row.lastFiredAt ?? null,
      createdAt: row.createdAt ?? null,
    }));
  }

  async update(
    userId: number,
    id: number,
    patch: { name?: string | null; agentId?: number | null; sessionId?: number | null; enabled?: boolean | null },
  ): Promise<void> {
    await this.requireOwned(userId, id);
    const current = await this.deps.triggerRepo.findById(id);
    const fields: Record<string, unknown> = {};
    if (patch.name != null) {
      const name = patch.name.trim();
      if (name.length === 0 || name.length > 128) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '触发器名称需为 1~128 字符');
      }
      fields.name = name;
    }
    if (patch.agentId != null) {
      const agent = await this.deps.agentLookup.findById(patch.agentId);
      if (agent == null || agent.id == null) {
        throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
      }
      if (agent.enabled === 0) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '该 Agent 已停用，无法绑定触发器');
      }
      fields.agentId = patch.agentId;
    }
    if (patch.agentId != null || patch.sessionId !== undefined) {
      const nextAgentId = patch.agentId != null ? patch.agentId : (current?.agentId ?? null);
      const nextSessionId = patch.sessionId !== undefined ? patch.sessionId : (current?.sessionId ?? null);
      await this.assertBindableSession(userId, nextSessionId, nextAgentId);
    }
    if (patch.sessionId !== undefined) {
      fields.sessionId = patch.sessionId;
    }
    if (patch.enabled != null) {
      // 决策 8：启用/停用操作即重置 consecutive_failures
      fields.enabled = patch.enabled ? 1 : 0;
      fields.consecutiveFailures = 0;
    }
    await this.deps.triggerRepo.updateFields(id, fields);
  }

  async delete(userId: number, id: number): Promise<void> {
    await this.requireOwned(userId, id);
    await this.deps.triggerRepo.deleteById(id, userId);
  }

  async rotateSecret(userId: number, id: number): Promise<{ plainSecret: string }> {
    await this.requireOwned(userId, id);
    const plainSecret = generateWebhookSecret();
    await this.deps.triggerRepo.updateFields(id, { secretCipher: this.deps.cipher.encrypt(plainSecret) });
    return { plainSecret };
  }

  /**
   * 入站触发（公开路由调用）：统一 404 语义——不存在、验签失败、停用同响应
   * （决策 10）；查无触发器时对 dummy secret 做等时 HMAC 比较。
   * 验签通过后回填 request.userId 由路由层完成（审计归因）。
   */
  async handleFire(pathToken: string, headers: HookFireHeaders, rawBody: string, sourceIp?: string | null): Promise<HookFireOutcome> {
    const trigger = await this.deps.triggerRepo.findByPathToken(pathToken);
    const secret = trigger?.secretCipher != null ? await this.deps.cipher.decrypt(trigger.secretCipher) : DUMMY_TRIGGER_SECRET;
    const signatureValid = verifyHmacSignature(secret, headers.timestamp, headers.signature, rawBody);
    if (trigger == null || !signatureValid || Number(trigger.enabled) !== 1 || trigger.userId == null) {
      const known = trigger != null && trigger.userId != null && trigger.id != null;
      if (known) {
        const limit = trigger.sessionId != null ? TRIGGER_RATE_LIMIT_BOUND : TRIGGER_RATE_LIMIT_UNBOUND;
        const decision = this.deps.rateLimiter.allow(`trigger:${trigger.id}`, limit);
        // 对外仍是统一 404，但写流水不得超过该触发器自己的限流档，避免错误签名把流水刷爆。
        if (!decision.allowed) return { ok: false, reason: 'not_found' };
      }
      await this.deps.callLog?.recordDirect({
        source: 'WEBHOOK',
        triggerId: known ? trigger.id ?? null : null,
        userId: known ? trigger.userId ?? null : null,
        agentId: known ? trigger.agentId ?? null : null,
        sourceIp: sourceIp ?? null,
        body: rawBody,
        httpStatus: 404,
        errorCode: 'OPEN_HOOK_NOT_FOUND',
        errorSummary: 'not found',
        suppressByIp: trigger == null,
      });
      return { ok: false, reason: 'not_found' };
    }
    const limit = trigger.sessionId != null ? TRIGGER_RATE_LIMIT_BOUND : TRIGGER_RATE_LIMIT_UNBOUND;
    const decision = this.deps.rateLimiter.allow(`trigger:${trigger.id}`, limit);
    if (!decision.allowed) {
      await this.deps.callLog?.recordDirect({
        source: 'WEBHOOK',
        triggerId: trigger.id ?? null,
        userId: trigger.userId,
        agentId: trigger.agentId ?? null,
        sessionId: trigger.sessionId ?? null,
        sourceIp: sourceIp ?? null,
        body: rawBody,
        httpStatus: 429,
        errorCode: 'RATE_LIMITED',
        errorSummary: '请求过于频繁',
      });
      return { ok: false, reason: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };
    }
    const begun = await this.deps.callLog?.begin({
      source: 'WEBHOOK',
      triggerId: trigger.id ?? null,
      userId: trigger.userId,
      agentId: trigger.agentId ?? null,
      sessionId: trigger.sessionId ?? null,
      sourceIp: sourceIp ?? null,
      body: rawBody,
    }) ?? null;
    let result: OpenRunResult;
    try {
      result = await this.deps.openRun.run({
        userId: trigger.userId,
        agentId: trigger.agentId ?? 0,
        sessionId: trigger.sessionId ?? null,
        source: 'WEBHOOK',
        triggerId: trigger.id ?? null,
        callLogId: begun?.id ?? null,
        message: this.wrapPayload(trigger.name ?? '', rawBody),
      });
    } catch (e) {
      await this.deps.callLog?.markRejected(begun?.id ?? null, begun?.startedAt ?? Date.now(), e);
      // 预算 BLOCK（决策 6）：任务未启动，无终态可投递；但计入连败与自动停用护栏正向联动，
      // 否则超限触发器会以 4xx 信封无限重试刷量。其余异常原样上抛。
      if (e instanceof BusinessException && e.code === ErrorCode.BUDGET_EXCEEDED.code && trigger.id != null) {
        await this.recordOutcome(trigger.id, 'FAILED').catch((err) =>
          console.warn(`[openapi] failed to record budget-blocked outcome, triggerId=${trigger.id}: ${(err as Error).message}`));
      }
      throw e;
    }
    await this.deps.callLog?.markAccepted(begun?.id ?? null, begun?.startedAt ?? Date.now(), result);
    // 直跑路径（未排队）：执行已在本请求内收敛，终态由 openRun 回读，就地做同源计数
    // （技术方案 §5.4）。排队路径的终态晚于本请求，由 WS 消费侧 handleQueueSettled 回写，
    // 两条路径按 queued 互斥分流，不会对同一次执行重复计数。
    // 回写失败只告警不抛出：触发本身已成功，不应让计数问题把 202 变成 5xx 诱发外部重试。
    if (!result.queued && trigger.id != null) {
      void this.handleDirectOutcome(trigger.id, result.terminalPhase).catch((e) =>
        console.warn(`[openapi] failed to record direct outcome, triggerId=${trigger.id}: ${(e as Error).message}`));
    }
    return { ok: true, userId: trigger.userId, sessionId: result.sessionId, queued: result.queued };
  }

  /**
   * 队列消费侧回写（streaming-ws-handler settleQueuedBinding → onOpenTriggerQueueConsumed）：
   * COMPLETED 清零 / FAILED +1 达阈值停用并通知 / CANCELLED 不计不清（决策 11）。
   * 触发器可能在排队期间被删除：查无行静默跳过。
   */
  async handleQueueSettled(triggerId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    await this.recordOutcome(triggerId, phase);
  }

  /** 直跑路径（未排队）终态回读后的同源计数（技术方案 §5.4）。 */
  async handleDirectOutcome(triggerId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    await this.recordOutcome(triggerId, phase);
  }

  private async recordOutcome(triggerId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    const outcome = await this.deps.triggerRepo.recordOutcome(triggerId, phase, TRIGGER_DISABLE_AFTER_FAILURES, formatDateTime(new Date()));
    if (outcome == null || !outcome.disabled) return;
    const trigger = await this.deps.triggerRepo.findById(triggerId);
    if (trigger == null || trigger.userId == null) return;
    try {
      await this.deps.disableNotifier?.notifyTriggerDisabled({
        userId: trigger.userId,
        triggerId,
        triggerName: trigger.name ?? '',
        sessionId: trigger.sessionId ?? null,
        failures: outcome.consecutiveFailures,
      });
    } catch (e) {
      console.warn(`[openapi] failed to notify trigger disabled, triggerId=${triggerId}: ${(e as Error).message}`);
    }
  }

  /** payload 包装（技术方案 §5.4）：JSON 原文包装为触发语境消息，超长截断。 */
  private wrapPayload(triggerName: string, rawBody: string): string {
    const MAX_PAYLOAD_CHARS = 8000;
    const payload = rawBody.length > MAX_PAYLOAD_CHARS ? `${rawBody.slice(0, MAX_PAYLOAD_CHARS)}…（超出 ${MAX_PAYLOAD_CHARS} 字符已截断）` : rawBody;
    return `收到外部 Webhook 事件（触发器：${triggerName}）：\n${payload}`;
  }

  private async requireOwned(userId: number, id: number): Promise<void> {
    const trigger = await this.deps.triggerRepo.findById(id);
    if (trigger == null || trigger.userId !== userId) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '触发器不存在');
    }
  }

  private async assertBindableSession(userId: number, sessionId: number | null, agentId: number | null): Promise<void> {
    if (sessionId == null) return;
    const session = await this.deps.sessionService.getSession(sessionId);
    if (session == null || session.userId !== userId) {
      throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
    }
    if (session.sessionType === 'SUBAGENT' || session.sessionType === 'SIDE_TASK') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '触发器仅支持绑定主会话');
    }
    if (session.executionMode === 'LOCAL') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '触发器仅支持绑定云端执行会话');
    }
    if (agentId != null && session.agentId !== agentId) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '只能绑定该 Agent 自己的会话');
    }
  }
}
