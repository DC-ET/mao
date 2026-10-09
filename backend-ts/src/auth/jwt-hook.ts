import type { FastifyRequest } from 'fastify';
import type { JwtService } from '../crypto/jwt.service.js';
import { API_TOKEN_PREFIX, type TokenResolveResult } from '../openapi/api-token.service.js';
import { OPEN_API_PATH_PREFIX } from '../openapi/types.js';

// /v1/agent-bundle/registry/ 为免登录只读端点：开关与 token 校验在路由内做（关闭时 404 不暴露存在性）
const PUBLIC_PREFIXES = ['/v1/auth', '/swagger-ui', '/v3/api-docs', '/ws/', '/v1/agent-bundle/registry/', '/v1/share/public/'];

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
 */
export async function authenticateRequest(
  request: FastifyRequest,
  jwt: JwtService,
  apiTokenResolver?: ApiTokenResolver | null,
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
  return { userId: jwt.getUserIdFromToken(token), tokenAutoDisabled: false, resolverRejected: false };
}
