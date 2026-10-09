import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendJson } from '../common/http-error.js';
import { failCode, ok } from '../common/result.js';
import { ErrorCode } from '../common/error-code.js';
import { BusinessException } from '../common/business-exception.js';
import type { ApiTokenAuthedRequest } from '../auth/jwt-hook.js';
import { requireJwtIdentity, requireTokenScope } from './access.js';
import type { FixedWindowRateLimiter } from './rate-limiter.js';
import type { ApiTokenService } from './api-token.service.js';
import type { OpenRunService } from './open-run.service.js';
import type { WebhookTriggerService } from './webhook-trigger.service.js';
import type { OutboundSubscriptionService } from './outbound-subscription.service.js';
import type { OpenApiCallLogService } from './open-api-call-log.service.js';

/** 公开 hook 路径前缀（isPublicPath 与 preParsing rawBody 捕获共用同一前缀常量）。 */
export const OPEN_HOOKS_PATH_PREFIX = '/v1/open/hooks/';

/** P1 run 端点限流档（次/分钟，技术方案 §5.7）。 */
export const TOKEN_RATE_LIMIT_PER_MINUTE = 60;

/** 带 rawBody 的请求（preParsing 捕获，见 create-app）。 */
export interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

export interface OpenApiRouteDeps {
  apiPrefix: string;
  openRun: OpenRunService;
  apiTokenService: ApiTokenService;
  triggerService: WebhookTriggerService;
  subscriptionService: OutboundSubscriptionService;
  rateLimiter: FixedWindowRateLimiter;
  callLog?: OpenApiCallLogService | null;
}

function hookUrlOf(request: FastifyRequest, apiPrefix: string, pathToken: string): string {
  const host = request.headers.host ?? 'localhost';
  return `${request.protocol}://${host}${apiPrefix}/v1/open/hooks/${pathToken}`;
}

function tokenRateLimited(reply: FastifyReply, retryAfterSeconds: number): void {
  reply.header('Retry-After', String(retryAfterSeconds));
  sendJson(reply, 429, failCode(ErrorCode.RATE_LIMITED));
}

function requireTokenIdentity(req: FastifyRequest): number {
  const tokenId = (req as ApiTokenAuthedRequest).apiTokenId;
  if (tokenId == null) {
    throw new BusinessException(ErrorCode.UNAUTHORIZED);
  }
  return tokenId;
}

function requirePositiveId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '路径参数 id 必须为正整数');
  }
  return id;
}

function positiveIntOrNull(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw !== '') {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

export function registerOpenApiRoutes(app: FastifyInstance, deps: OpenApiRouteDeps): void {
  // ── P1：REST 触发端点（API Token 专属，scope: open:run）──────────────────
  app.post('/v1/open/agents/:agentId/run', async (req, reply) => {
    const tokenId = (req as ApiTokenAuthedRequest).apiTokenId ?? null;
    const body = (req.body ?? {}) as { message?: unknown; sessionId?: unknown };
    const sessionId = positiveIntOrNull(body.sessionId);
    const agentId = positiveIntOrNull((req.params as { agentId: string }).agentId);
    const begun = await deps.callLog?.begin({
      source: 'API',
      tokenId,
      userId: req.userId ?? null,
      agentId,
      sessionId,
      sourceIp: req.ip,
      body,
    }) ?? null;
    try {
      requireTokenScope(req, 'open:run');
      requireTokenIdentity(req);
      const decision = deps.rateLimiter.allow(`token:${tokenId}`, TOKEN_RATE_LIMIT_PER_MINUTE);
      if (!decision.allowed) {
        await deps.callLog?.markRejected(begun?.id ?? null, begun?.startedAt ?? Date.now(), {
          httpStatus: 429,
          errorCode: 'RATE_LIMITED',
          errorSummary: '请求过于频繁',
        });
        tokenRateLimited(reply, decision.retryAfterSeconds);
        return;
      }
      if (agentId == null) throw new BusinessException(ErrorCode.PARAM_INVALID, '路径参数 id 必须为正整数');
      if (typeof body.message !== 'string') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'message 必须为字符串');
      }
      if (body.sessionId != null && sessionId == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'sessionId 必须为正整数');
      }
      const result = await deps.openRun.run({
        userId: req.userId!,
        agentId,
        message: body.message,
        sessionId,
        source: 'API',
        callLogId: begun?.id ?? null,
      });
      await deps.callLog?.markAccepted(begun?.id ?? null, begun?.startedAt ?? Date.now(), result);
      sendJson(reply, 202, ok({ sessionId: result.sessionId, messageId: result.messageId, queued: result.queued }));
    } catch (e) {
      await deps.callLog?.markRejected(begun?.id ?? null, begun?.startedAt ?? Date.now(), e);
      throw e;
    }
  });

  // ── P2：入站 Webhook 触发器（公开路径，处理器内自验签）────────────────────
  app.post('/v1/open/hooks/:pathToken', async (req, reply) => {
    const pathToken = (req.params as { pathToken: string }).pathToken ?? '';
    const rawBody = (req as RawBodyRequest).rawBody?.toString('utf8') ?? '';
    const headerValue = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
    const outcome = await deps.triggerService.handleFire(pathToken, {
      timestamp: headerValue(req.headers['x-mao-timestamp']),
      signature: headerValue(req.headers['x-mao-signature']),
    }, rawBody, req.ip);
    if (!outcome.ok) {
      if (outcome.reason === 'rate_limited') {
        tokenRateLimited(reply, outcome.retryAfterSeconds);
      } else {
        // 不存在/停用/验签失败统一 404 + 固定短语（决策 10）
        sendJson(reply, 404, failCode(ErrorCode.OPEN_HOOK_NOT_FOUND));
      }
      return;
    }
    // 验签通过后回填属主：审计 onResponse 钩子晚于处理器读取 request.userId，回填即生效
    req.userId = outcome.userId;
    sendJson(reply, 202, ok({ sessionId: outcome.sessionId, queued: outcome.queued }));
  });

  // ── P1：API Token 管理（仅 JWT 会话身份，决策 12）────────────────────────
  app.get('/v1/open/tokens', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    sendJson(reply, 200, ok(await deps.apiTokenService.list(userId)));
  });

  app.post('/v1/open/tokens', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const body = (req.body ?? {}) as { name?: unknown; scopes?: unknown };
    if (typeof body.name !== 'string' || !Array.isArray(body.scopes)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'name 与 scopes 必填');
    }
    const issued = await deps.apiTokenService.issue(userId, body.name, body.scopes as string[]);
    // 明文只显示一次
    sendJson(reply, 200, ok(issued));
  });

  app.delete('/v1/open/tokens/:id', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = requirePositiveId((req.params as { id: string }).id);
    await deps.apiTokenService.revoke(userId, id);
    sendJson(reply, 200, ok(null));
  });

  app.put('/v1/open/tokens/:id/log-full-body', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = requirePositiveId((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'enabled 必须为布尔值');
    }
    await deps.apiTokenService.setLogFullBody(userId, id, body.enabled);
    sendJson(reply, 200, ok(null));
  });

  app.post('/v1/open/tokens/:id/re-enable', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = requirePositiveId((req.params as { id: string }).id);
    await deps.apiTokenService.reEnable(userId, id);
    sendJson(reply, 200, ok(null));
  });

  // ── P2：触发器管理（仅 JWT 会话身份，仅本人资源）──────────────────────────
  app.get('/v1/open/triggers', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const base = hookUrlOf(req, deps.apiPrefix, '');
    const triggers = await deps.triggerService.list(userId);
    sendJson(reply, 200, ok(triggers.map((t) => ({ ...t, url: `${base}${t.pathToken}` }))));
  });

  app.post('/v1/open/triggers', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const body = (req.body ?? {}) as { name?: unknown; agentId?: unknown; sessionId?: unknown };
    if (typeof body.name !== 'string' || !Number.isInteger(Number(body.agentId))) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'name 与 agentId 必填');
    }
    const created = await deps.triggerService.create(userId, {
      name: body.name,
      agentId: Number(body.agentId),
      sessionId: body.sessionId == null ? null : Number(body.sessionId),
    });
    sendJson(reply, 200, ok({
      ...created,
      url: hookUrlOf(req, deps.apiPrefix, created.pathToken),
    }));
  });

  app.put('/v1/open/triggers/:id', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = requirePositiveId((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { name?: unknown; agentId?: unknown; sessionId?: unknown; enabled?: unknown };
    await deps.triggerService.update(userId, id, {
      name: typeof body.name === 'string' ? body.name : null,
      agentId: body.agentId == null ? null : Number(body.agentId),
      sessionId: body.sessionId === undefined ? undefined : body.sessionId == null ? null : Number(body.sessionId),
      enabled: typeof body.enabled === 'boolean' ? body.enabled : null,
    });
    sendJson(reply, 200, ok(null));
  });

  app.delete('/v1/open/triggers/:id', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = requirePositiveId((req.params as { id: string }).id);
    await deps.triggerService.delete(userId, id);
    sendJson(reply, 200, ok(null));
  });

  app.post('/v1/open/triggers/:id/rotate-secret', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = requirePositiveId((req.params as { id: string }).id);
    const rotated = await deps.triggerService.rotateSecret(userId, id);
    // 新明文只显示一次
    sendJson(reply, 200, ok(rotated));
  });

  // ── P3：出站订阅管理（仅 JWT 会话身份，仅本人资源）────────────────────────
  app.get('/v1/open/subscriptions', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    sendJson(reply, 200, ok(await deps.subscriptionService.list(userId)));
  });

  app.post('/v1/open/subscriptions', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const body = (req.body ?? {}) as { event?: unknown; targetUrl?: unknown };
    if (typeof body.event !== 'string' || typeof body.targetUrl !== 'string') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'event 与 targetUrl 必填');
    }
    const created = await deps.subscriptionService.create(userId, { event: body.event, targetUrl: body.targetUrl });
    // 明文 secret 只显示一次
    sendJson(reply, 200, ok(created));
  });

  app.put('/v1/open/subscriptions/:id', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = requirePositiveId((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'enabled 必须为布尔值');
    }
    await deps.subscriptionService.setEnabled(userId, id, body.enabled);
    sendJson(reply, 200, ok(null));
  });

  app.get('/v1/open/subscriptions/:id/deliveries', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = requirePositiveId((req.params as { id: string }).id);
    sendJson(reply, 200, ok(await deps.subscriptionService.listRecentDeliveries(userId, id)));
  });

  app.delete('/v1/open/subscriptions/:id', async (req, reply) => {
    const userId = requireJwtIdentity(req);
    const id = requirePositiveId((req.params as { id: string }).id);
    await deps.subscriptionService.delete(userId, id);
    sendJson(reply, 200, ok(null));
  });
}
