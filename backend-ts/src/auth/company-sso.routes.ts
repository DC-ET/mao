import type { FastifyInstance } from 'fastify';
import { sendJson, sendOk } from '../common/http-error.js';
import { fail } from '../common/result.js';
import { matchesCompanySsoOrigin, validateCompanySsoCheckUrl } from './company-sso.config.js';
import { companySsoConfigForRequest, type CompanySsoSettings } from './company-sso-request.js';
import { CompanySsoError } from './company-sso.error.js';
import { CompanySsoRateLimiter, type CompanySsoService } from './company-sso.service.js';

import type { SsoAssociationAction } from './company-sso-identity.repository.js';
import type { SsoErrorKind } from './company-sso.error.js';

export interface CompanySsoAuditEvent {
  requestId: string;
  provider: 'company_sso';
  userId?: number;
  action?: SsoAssociationAction;
  outcome: 'success' | SsoErrorKind;
  durationMs: number;
  ip: string;
  detail?: string;
}

export type CompanySsoAuditCallback = (event: CompanySsoAuditEvent) => Promise<void>;

export function registerCompanySsoRoutes(
  app: FastifyInstance,
  service: Pick<CompanySsoService, 'exchange'>,
  settings: CompanySsoSettings,
  audit?: CompanySsoAuditCallback,
  isEcpEnabled?: () => Promise<boolean>,
): void {
  const limiter = new CompanySsoRateLimiter();
  app.post('/v1/auth/sso/exchange', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const start = Date.now();
    try {
      if (isEcpEnabled != null && await isEcpEnabled()) throw new CompanySsoError('account_forbidden');
      const config = await companySsoConfigForRequest(request, settings);
      if (!config.enabled) throw new CompanySsoError('service_unavailable');
      if (config.requireHttps && request.protocol !== 'https') throw new CompanySsoError('account_forbidden');
      const origin = request.headers.origin;
      if (origin !== undefined && !matchesCompanySsoOrigin(origin, config.allowedOrigins)) throw new CompanySsoError('account_forbidden');
      limiter.consume(`ip:${request.ip}`, 60);
      const body = request.body;
      if (Object.keys(request.query as object).length || !body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || !('checkUrl' in body) || typeof body.checkUrl !== 'string'
        || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new CompanySsoError('invalid_request');
      validateCompanySsoCheckUrl(body.checkUrl, config);
      const authorization = request.headers.authorization;
      if (!authorization || authorization.length > 16384 || !/^Bearer [A-Za-z0-9._~+\/-]+=*$/i.test(authorization)) throw new CompanySsoError('invalid_request');
      const { action, ...result } = await service.exchange(authorization.slice(7), body.checkUrl, config);
      const event: CompanySsoAuditEvent = { requestId: request.id, provider: 'company_sso', userId: result.user.id, action, outcome: 'success', durationMs: Date.now() - start, ip: request.ip };
      await audit?.(event);
      request.log.info(event, 'SSO exchange');
      return sendOk(reply, result);
    } catch (error) {
      const safe = error instanceof CompanySsoError ? error : new CompanySsoError('service_unavailable');
      if (safe.retryAfter) reply.header('Retry-After', safe.retryAfter);
      const event: CompanySsoAuditEvent = { requestId: request.id, provider: 'company_sso', outcome: safe.kind, durationMs: Date.now() - start, ip: request.ip };
      if (safe.detail) event.detail = safe.detail;
      try {
        await audit?.(event);
      } catch {
        request.log.error({ requestId: request.id }, 'SSO audit failed');
        return sendJson(reply, 503, fail(1503, 'SSO service is unavailable'));
      }
      request.log.warn(event, 'SSO exchange rejected');
      return sendJson(reply, safe.status, fail(safe.code, safe.message));
    }
  });
}
