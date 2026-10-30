import type { FastifyRequest } from 'fastify';
import type { JwtService } from '../crypto/jwt.service.js';
import { API_TOKEN_PREFIX, type TokenResolveResult } from '../openapi/api-token.service.js';
import { OPEN_API_PATH_PREFIX } from '../openapi/types.js';

const PUBLIC_PREFIXES = ['/v1/auth', '/swagger-ui', '/v3/api-docs', '/ws/', '/v1/share/public/', '/v1/health'];

/** 与 create-app 的 apiPrefix（`/api`）对齐：剥掉后按域内路径判断。 */
function domainPath(rawUrl: string): string {
  return rawUrl.split('?')[0].replace(/^\/api/, '') || '/';
}

/** API Token 身份只对 `/v1/open/**` 生效（§5.2 不变式：token 能力 ≤ 触发执行）。 */
function isOpenApiPath(rawUrl: string): boolean {
  return domainPath(rawUrl).startsWith(OPEN_API_PATH_PREFIX);
}

export function isPublicPath(method: string, rawUrl: string): boolean {
  const path = rawUrl.split('?')[0].replace(/^\/api/, '') || '/';
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
    return true;
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('/uploads/')) {
    return true;
  }
  if (method === 'GET' && /^\/v1\/dingtalk\/bind\/[^/]+$/.test(path)) return true;
  if (method === 'GET' && path === '/v1/dingtalk/oauth/callback') return true;
  // 入站 Webhook 触发器：POST 自验签（HMAC），跳过 JWT 门槛（技术方案 §5.4）
  if (method === 'POST' && path.startsWith('/v1/open/hooks/')) return true;
  return false;
}

/** 自动停用 Token 只拦住需要登录的路径。公开 Webhook 自己验签，请求头里的停用 Token 不能挡在前面。 */
export function autoDisabledTokenBlocksRequest(method: string, rawUrl: string): boolean {
  return !isPublicPath(method, rawUrl);
}

export function resolveToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  const query = request.query as Record<string, string | undefined>;
  if (query?.token) {
    return query.token;
  }
  return null;
}

/** API Token 解析回调（create-app 注入；auth 域不反向依赖 openapi 域实现）。 */
export type ApiTokenResolver = (plainToken: string) => Promise<TokenResolveResult>;

/**
 * 账号状态检查（app-hooks 注入；auth 域不反向依赖 user 仓储实现）。
 * 返回 false = 停用/不存在，请求按未认证处理。
 * 第二参是当前请求：REST 注入方可把查到的用户行挂到 request 上，供 onResponse 审计复用。
 */
export type AccountStatusChecker = (userId: number, request?: FastifyRequest) => Promise<boolean>;

export interface AuthenticationOutcome {
  userId: number | null;
  /** 命中自动停用：preHandler 回 403，而不是 401。 */
  tokenAutoDisabled: boolean;
  /** resolveByToken 已拒绝并触发 onReject，preHandler 不要再落一行。 */
  resolverRejected: boolean;
}

/** API Token 鉴权成功的请求：挂 scope 列表与 token id 供授权层/限流校验。 */
export interface ApiTokenAuthedRequest extends FastifyRequest {
  apiTokenScopes?: string[];
  apiTokenId?: number;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

/**
 * 请求鉴权：`mao_` 前缀 token 走 ApiTokenService 查库降级（仅认 Bearer 头，
 * query 通道一律拒绝——token 不得进 URL/访问日志）；其余走既有 JWT 路径不变。
 * 正常 JWT 请求零额外查询；异步化（查库）不影响唯一调用点（preHandler 已为 async）。
 * API Token 仅 `/v1/open/**` 生效：落在其它端点上直接按未认证处理（401），
 * 避免泄露的 token 以该用户身份调用任意 REST 接口。
 *
 * JWT 与 API Token 路径在验签 / 解析之后都追加账号状态校验（accountStatusChecker）：
 * 只验签不查状态时，管理员禁用用户后其未过期 access token（默认 24h）或已签发的 API Token
 * 仍可调用接口——登录 / 刷新 / 分享链接等入口都拒停用账号，这里补齐同一口径。
 * 停用判定的负缓存由注入方收敛开销。
 */
export async function authenticateRequest(
  request: FastifyRequest,
  jwt: JwtService,
  apiTokenResolver?: ApiTokenResolver | null,
  accountStatusChecker?: AccountStatusChecker | null,
): Promise<AuthenticationOutcome> {
  const anonymous = (patch: Partial<AuthenticationOutcome> = {}): AuthenticationOutcome => ({
    userId: null,
    tokenAutoDisabled: false,
    resolverRejected: false,
    ...patch,
  });
  const header = bearerToken(request);
  if (header != null && header.startsWith(API_TOKEN_PREFIX)) {
    if (apiTokenResolver == null || !isOpenApiPath(request.url)) return anonymous();
    const identity = await apiTokenResolver(header);
    if (!identity.ok) {
      return anonymous({
        tokenAutoDisabled: identity.reason === 'auto_disabled',
        resolverRejected: true,
      });
    }
    // 账号被停用 / 删除时，已签发的 API Token 同样失效（与 JWT 路径同口径）。
    // 不置 resolverRejected：resolver 没有触发 onReject，让 preHandler 落一行鉴权拒绝日志。
    if (accountStatusChecker != null && !(await accountStatusChecker(identity.userId, request))) {
      return anonymous();
    }
    (request as ApiTokenAuthedRequest).apiTokenScopes = identity.scopes;
    (request as ApiTokenAuthedRequest).apiTokenId = identity.tokenId;
    return { userId: identity.userId, tokenAutoDisabled: false, resolverRejected: false };
  }
  const query = request.query as Record<string, string | undefined>;
  // query 通道对 mao_ 前缀关闭：防止 token 进 URL/访问日志
  if (query?.token?.startsWith(API_TOKEN_PREFIX)) {
    return anonymous();
  }
  const token = header ?? query?.token ?? null;
  if (!token || !jwt.validateAccessToken(token)) {
    return anonymous();
  }
  const userId = jwt.getUserIdFromToken(token);
  if (accountStatusChecker != null && !(await accountStatusChecker(userId, request))) {
    return anonymous();
  }
  return { userId, tokenAutoDisabled: false, resolverRejected: false };
}
