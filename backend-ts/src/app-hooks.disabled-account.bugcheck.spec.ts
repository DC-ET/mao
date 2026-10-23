import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerAppHooks } from './app-hooks.js';
import type { JwtService } from './crypto/jwt.service.js';
import type { ApiTokenService } from './openapi/api-token.service.js';
import type { AuditLogService } from './audit/audit.service.js';
import type { MysqlUserRepository } from './user/user.repository.js';
import type { OpenApiCallLogService } from './openapi/open-api-call-log.service.js';

/**
 * BUGCHECK（审查新增，非产品代码）：账号被禁用后，已签发的 access token 仍可继续调用接口。
 *
 * 根因：请求鉴权链路 `app-hooks.ts` 的 preHandler → `auth/jwt-hook.ts`
 * 的 `authenticateRequest()` 只做「验签 + 过期」判断，直接把 token 里的 userId
 * 写进 `request.userId`，**从不查用户账号状态**。
 * 同仓库其它入口都拒绝停用账号：
 *   - 本地密码登录 / 刷新 token：`auth/auth.service.ts:34,50`（status === 0 → ACCOUNT_DISABLED）
 *   - LDAP / 飞书 / ECP 登录：各自校验 status === 0
 *   - 分享链接：`session/session-share.service.ts:202`（属主 status === 0 → 链接失效）
 * 口径不一致 → 管理员「禁用」用户后，该用户的存量 access token 在其有效期内
 * （jwt.expiration，默认 24h）仍可读写他人数据、建终端、调模型。
 *
 * 断言按「本应如此」书写：停用账号的请求必须被拒绝（响应体 code 不得为 0），
 * 启用账号不受影响（对照组）。当前源码下第一条断言失败即证明 BUG 真实存在。
 */

function buildApp(userStatus: number | null) {
  const app = Fastify();

  const jwt = {
    validateAccessToken: (token: string) => token === 'valid-access-token',
    getUserIdFromToken: () => 42,
    getTokenType: () => 'access',
  } as unknown as JwtService;

  const apiTokenService = {
    resolveByToken: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
  } as unknown as ApiTokenService;

  const userRepo = {
    findById: vi.fn(async () => ({ id: 42, username: 'disabled-user', status: userStatus, deleted: 0 })),
  } as unknown as MysqlUserRepository;

  registerAppHooks({
    app,
    jwt,
    apiTokenService,
    openCallLogHolder: { current: null as OpenApiCallLogService | null },
    auditService: { record: vi.fn(async () => undefined) } as unknown as AuditLogService,
    userRepo,
    ssoExchangePath: '/api/v1/auth/sso/exchange',
  });

  app.get('/v1/ping', async (_request, reply) => {
    return reply.status(200).send({ code: 0, message: 'success', data: 'pong' });
  });

  return { app, userRepo };
}

describe('BUGCHECK disabled account must lose access with its still-valid access token', () => {
  it('rejects a request carrying the access token of a disabled (status = 0) user', async () => {
    const { app, userRepo } = buildApp(0);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { authorization: 'Bearer valid-access-token' },
    });

    const body = res.json() as { code: number };
    // 停用账号的存量 token 必须失效：成功码（0）不应出现
    // （拒绝时可能是 1001 未登录 / 1002 无权限 / 1006 账号已禁用）
    expect(body.code === 0 ? '放行' : '拒绝').toBe('拒绝');
    // 鉴权阶段查一次；停用请求 userId 为空，onResponse 不再查
    expect(userRepo.findById).toHaveBeenCalledTimes(1);
  });

  it('still accepts a request from an enabled user (control group)', async () => {
    const { app, userRepo } = buildApp(1);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { authorization: 'Bearer valid-access-token' },
    });

    const body = res.json() as { code: number };
    expect(body.code).toBe(0);
    // 鉴权阶段查一次，onResponse 审计复用，不再打第二次 user 表
    expect(userRepo.findById).toHaveBeenCalledTimes(1);
  });
});

/**
 * API Token 与 JWT 同口径：账号被停用 / 删除后，已签发的 mao_ token 也不得再调用 /v1/open/**。
 * 之前 authenticateRequest 在 API Token 分支提前 return，账号状态检查只覆盖 JWT。
 */
function buildApiTokenApp(userStatus: number | null) {
  const app = Fastify();

  const jwt = {
    validateAccessToken: () => false,
    getUserIdFromToken: () => 42,
    getTokenType: () => 'access',
  } as unknown as JwtService;

  const apiTokenService = {
    resolveByToken: vi.fn(async () => ({ ok: true, userId: 42, scopes: [], tokenId: 7 })),
  } as unknown as ApiTokenService;

  const userRepo = {
    findById: vi.fn(async () => ({ id: 42, username: 'api-user', status: userStatus, deleted: 0 })),
  } as unknown as MysqlUserRepository;

  registerAppHooks({
    app,
    jwt,
    apiTokenService,
    openCallLogHolder: { current: null as OpenApiCallLogService | null },
    auditService: { record: vi.fn(async () => undefined) } as unknown as AuditLogService,
    userRepo,
    ssoExchangePath: '/api/v1/auth/sso/exchange',
  });

  app.get('/v1/open/ping', async (_request, reply) => {
    return reply.status(200).send({ code: 0, message: 'success', data: 'pong' });
  });

  return { app, userRepo };
}

describe('BUGCHECK disabled account must also lose API token access', () => {
  it('rejects a mao_ API token whose owner is disabled', async () => {
    const { app, userRepo } = buildApiTokenApp(0);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/open/ping',
      headers: { authorization: 'Bearer mao_test_token' },
    });
    expect((res.json() as { code: number }).code).not.toBe(0);
    expect(userRepo.findById).toHaveBeenCalledTimes(1);
  });

  it('still accepts the API token of an enabled user (control group)', async () => {
    const { app, userRepo } = buildApiTokenApp(1);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/open/ping',
      headers: { authorization: 'Bearer mao_test_token' },
    });
    expect((res.json() as { code: number }).code).toBe(0);
    expect(userRepo.findById).toHaveBeenCalledTimes(1);
  });
});
