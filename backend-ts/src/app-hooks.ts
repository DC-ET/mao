import { Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { fail } from './common/result.js';
import { ErrorCode } from './common/error-code.js';
import { redactCredentialQuery } from './common/structured-logger.js';
import { sendJson, handleError } from './common/http-error.js';
import { authenticateRequest, autoDisabledTokenBlocksRequest, isPublicPath } from './auth/jwt-hook.js';
import { recordAudit } from './audit/audit.interceptor.js';
import { OPEN_HOOKS_PATH_PREFIX, type RawBodyRequest } from './openapi/open.routes.js';
import type { JwtService } from './crypto/jwt.service.js';
import type { ApiTokenService } from './openapi/api-token.service.js';
import type { OpenApiCallLogService } from './openapi/open-api-call-log.service.js';
import type { AuditLogService } from './audit/audit.service.js';
import type { MysqlUserRepository } from './user/user.repository.js';

export interface HookDeps {
  app: FastifyInstance;
  jwt: JwtService;
  apiTokenService: ApiTokenService;
  openCallLogHolder: { current: OpenApiCallLogService | null };
  auditService: AuditLogService;
  userRepo: MysqlUserRepository;
  ssoExchangePath: string;
}

const isOpenAgentRun = (request: { method: string; url: string }): boolean => {
  if (request.method !== 'POST') return false;
  const path = request.url.split('?')[0].replace(/^\/api/, '') || '/';
  return /^\/v1\/open\/agents\/[^/]+\/run$/.test(path);
};

const presentedMaoPrefix = (request: { headers: { authorization?: string | string[] }; query: unknown }): string => {
  const header = request.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (bearer != null && bearer.startsWith('mao_')) return bearer.slice(0, 12);
  const queryToken = (request.query as { token?: unknown } | null)?.token;
  if (typeof queryToken === 'string' && queryToken.startsWith('mao_')) return queryToken.slice(0, 12);
  return '';
};

export function registerAppHooks(deps: HookDeps): void {
  const { app, jwt, apiTokenService, openCallLogHolder, auditService, userRepo, ssoExchangePath } = deps;

  app.addHook('preParsing', async (request, _reply, payload) => {
    if (request.method !== 'POST' || !request.url.split('?')[0].replace(/^\/api/, '').startsWith(OPEN_HOOKS_PATH_PREFIX)) {
      return payload;
    }
    const chunks: Buffer[] = [];
    const tap = new Transform({
      transform(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback(null, chunk);
      },
      flush(callback) {
        (request as RawBodyRequest).rawBody = Buffer.concat(chunks);
        callback(null);
      },
    });
    payload.pipe(tap);
    return tap;
  });
  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url.split('?')[0] === ssoExchangePath) return;
    const auth = await authenticateRequest(request, jwt, (plain) => apiTokenService.resolveByToken(plain, {
      onReject: (rejected) => {
        if (!isOpenAgentRun(request)) return;
        void openCallLogHolder.current?.recordAuthReject({
          reason: rejected.reason,
          tokenPrefix: rejected.tokenPrefix,
          tokenId: 'tokenId' in rejected ? rejected.tokenId : undefined,
          userId: 'userId' in rejected ? rejected.userId : undefined,
          sourceIp: request.ip,
        });
      },
    }));
    if (auth.userId != null) request.userId = auth.userId;
    if (auth.tokenAutoDisabled && autoDisabledTokenBlocksRequest(request.method, request.url)) {
      sendJson(reply, 403, fail(ErrorCode.TOKEN_AUTO_DISABLED.code, ErrorCode.TOKEN_AUTO_DISABLED.message));
      return;
    }
    if (!isPublicPath(request.method, request.url) && auth.userId == null) {
      if (isOpenAgentRun(request) && !auth.resolverRejected) {
        void openCallLogHolder.current?.recordAuthReject({
          reason: 'not_found',
          tokenPrefix: presentedMaoPrefix(request),
          sourceIp: request.ip,
        });
      }
      sendJson(reply, 401, fail(1001, '未登录或登录已过期'));
      return;
    }
  });
  app.setErrorHandler(handleError);
  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0].replace(/^\/api/, '');
    const user = request.userId != null ? await userRepo.findById(request.userId).catch(() => null) : null;
    void recordAudit(auditService, {
      method: request.method,
      path,
      queryString: request.url.includes('?') ? redactCredentialQuery(request.url).split('?')[1] : undefined,
      ip: request.ip,
      status: reply.statusCode,
      userId: request.userId,
      username: user?.username,
    });
  });
}
