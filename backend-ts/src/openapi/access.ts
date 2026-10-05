import type { FastifyRequest } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId } from '../common/http-error.js';
import type { ApiTokenAuthedRequest } from '../auth/jwt-hook.js';
import { hasScope } from './api-token.service.js';
import type { OpenApiScope } from './types.js';

/**
 * 授权层（scope 单层，技术方案 §5.2 / 决策 4）：
 * run 端点只接受显式持有对应 scope 的 API Token 身份；JWT 请求无 apiTokenScopes，
 * 一律 403（开放触发不接受会话身份）。
 */
export function requireTokenScope(request: FastifyRequest, scope: OpenApiScope): void {
  const scopes = (request as ApiTokenAuthedRequest).apiTokenScopes;
  if (scopes == null) {
    throw new BusinessException(ErrorCode.FORBIDDEN, '该端点仅接受 API Token（mao_）调用');
  }
  if (!hasScope(scopes, scope)) {
    throw new BusinessException(ErrorCode.FORBIDDEN, `Token 缺少 ${scope} scope`);
  }
}

/**
 * 管理接口身份隔离（决策 12）：token 签发/吊销/列表、触发器/订阅 CRUD 仅限 JWT
 * 会话身份——防止泄露的 mao_ token 自我续期/自我克隆。
 */
export function requireJwtIdentity(request: FastifyRequest): number {
  if ((request as ApiTokenAuthedRequest).apiTokenScopes != null) {
    throw new BusinessException(ErrorCode.UNAUTHORIZED, '管理接口仅限登录会话调用，API Token 不可用');
  }
  return requireUserId(request);
}
