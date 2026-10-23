import { Transform } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fail } from './common/result.js';
import { ErrorCode } from './common/error-code.js';
import { BusinessException } from './common/business-exception.js';
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

/** onResponse 写审计用：错误处理器暂存的业务失败原因；鉴权阶段查到的用户行供审计复用。 */
type AuthenticatedUser = Awaited<ReturnType<MysqlUserRepository['findById']>>
type AuditedRequest = FastifyRequest & {
  auditErrorMessage?: string
  authenticatedUser?: AuthenticatedUser
};

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

  // 停用账号短 TTL 负缓存（BUG-C3）：命中「已确认停用」后短时间内不再打库，重新启用最多
  // TTL 后生效；启用态不缓存——禁用即时生效。鉴权阶段查到的用户行挂到 request 上，
  // onResponse 审计复用，避免每个请求对 user 表查两次。按 app 实例隔离（测试各自建 app 不互相污染）。
  const disabledAccountCache = new Map<number, number>();
  const DISABLED_ACCOUNT_CACHE_TTL_MS = 30_000;
  const accountStatusChecker = async (userId: number, request?: FastifyRequest): Promise<boolean> => {
    const now = Date.now();
    const expiry = disabledAccountCache.get(userId);
    if (expiry !== undefined) {
      if (expiry > now) return false;
      disabledAccountCache.delete(userId);
    }
    let user: Awaited<ReturnType<typeof userRepo.findById>>;
    try {
      user = await userRepo.findById(userId);
    } catch {
      return true; // 查询异常不误伤：放行本次请求，下次再判
    }
    // findById 带 notDeleted()：null = 账号不存在/已删除，与刷新 token 口径一致（拒）
    if (user == null) return false;
    const disabled = user.status != null && user.status === 0;
    if (disabled) {
      disabledAccountCache.set(userId, now + DISABLED_ACCOUNT_CACHE_TTL_MS);
      return false;
    }
    // 仅放行的请求缓存用户行：停用请求的 userId 不会写入 request，审计不展示其用户名
    if (request != null) (request as AuditedRequest).authenticatedUser = user;
    return true;
  };

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
    }), accountStatusChecker);
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
  app.setErrorHandler((err, request, reply) => {
    // 业务失败按仓库约定也返回 HTTP 200（错误在响应体 code 上）：把失败原因暂存到
    // request，onResponse 据此写审计的 errorMessage——否则审计只看状态码，失败操作
    // 全部落库成 success=1、管理后台「错误」列恒为 '-'。
    if (err instanceof BusinessException) {
      (request as AuditedRequest).auditErrorMessage = err.message;
    }
    handleError(err, request, reply);
  });
  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0].replace(/^\/api/, '');
    // 鉴权阶段已查过用户时直接复用：避免每个已认证请求对 user 表再查一次
    const cachedUser = (request as AuditedRequest).authenticatedUser;
    const user = cachedUser !== undefined
      ? cachedUser
      : (request.userId != null ? await userRepo.findById(request.userId).catch(() => null) : null);
    void recordAudit(auditService, {
      method: request.method,
      path,
      queryString: request.url.includes('?') ? redactCredentialQuery(request.url).split('?')[1] : undefined,
      ip: request.ip,
      status: reply.statusCode,
      userId: request.userId,
      username: user?.username,
      errorMessage: (request as AuditedRequest).auditErrorMessage,
    });
  });
}
