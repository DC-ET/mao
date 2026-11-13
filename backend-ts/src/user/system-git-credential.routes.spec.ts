import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { registerSystemGitCredentialRoutes } from './system-git-credential.routes.js';
import type { SystemGitCredentialRouteDeps } from './system-git-credential.routes.js';

/** 管理端权限矩阵 × 列表脱敏 × 域并集（技术方案 2026-11-12 §10.3）。 */

const ADMIN_ID = 7;

function systemRows() {
  return [
    { id: 1, domain: 'b.com', accessToken: 'cipher-b', description: 'B 备注', createdAt: '2026-11-12 10:00:00', updatedAt: '2026-11-12 10:00:00' },
    { id: 2, domain: 'a.com', accessToken: 'cipher-a', description: null, createdAt: null, updatedAt: null },
  ];
}

function makeApp(opts: { permissions?: Record<string, boolean>; userDomains?: string[] } = {}) {
  const service = {
    list: vi.fn(async () => systemRows()),
    create: vi.fn(async (domain: string, accessToken: string, description?: string | null) => ({
      id: 3, domain, accessToken: `cipher(${accessToken})`, description: description ?? null,
    })),
    update: vi.fn(async (id: number, accessToken?: string | null, description?: string | null) => ({
      id, domain: 'a.com', accessToken: accessToken ? `cipher(${accessToken})` : 'old-cipher', description: description ?? null,
    })),
    delete: vi.fn(async () => undefined),
    listDomains: vi.fn(async () => ['b.com', 'a.com']),
  };
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    (req as unknown as { userId: number }).userId = ADMIN_ID;
    done();
  });
  const deps: SystemGitCredentialRouteDeps = {
    systemGitCredentialService: service as never,
    gitCredentialService: { listAllDomains: vi.fn(async () => opts.userDomains ?? ['a.com', 'c.com']) },
    permissionService: {
      hasPermission: vi.fn(async (_uid: number, code: string) => opts.permissions?.[code] ?? true),
    },
  };
  registerSystemGitCredentialRoutes(fastify, deps);
  return { fastify, service, deps };
}

describe('system git credential routes', () => {
  beforeEach(() => {});

  afterEach(() => {});

  it('GET 列表需 settings:read，响应恒 ****', async () => {
    const denied = makeApp({ permissions: { 'settings:read': false } });
    const resDenied = await denied.fastify.inject({ method: 'GET', url: '/v1/admin/git-default-credentials' });
    expect(resDenied.statusCode).toBe(403);
    await denied.fastify.close();

    const app = makeApp();
    const res = await app.fastify.inject({ method: 'GET', url: '/v1/admin/git-default-credentials' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ accessToken: string; domain: string }> };
    expect(body.data.every((item) => item.accessToken === '****')).toBe(true);
    expect(body.data.map((item) => item.domain)).toEqual(['b.com', 'a.com']);
    await app.fastify.close();
  });

  it('POST/PUT/DELETE 无 settings:write → 403；有则放行且不透出明文', async () => {
    const denied = makeApp({ permissions: { 'settings:write': false } });
    const post = await denied.fastify.inject({ method: 'POST', url: '/v1/admin/git-default-credentials', payload: { domain: 'a.com', accessToken: 'tok' } });
    const put = await denied.fastify.inject({ method: 'PUT', url: '/v1/admin/git-default-credentials/1', payload: { accessToken: 'tok' } });
    const del = await denied.fastify.inject({ method: 'DELETE', url: '/v1/admin/git-default-credentials/1' });
    expect(post.statusCode).toBe(403);
    expect(put.statusCode).toBe(403);
    expect(del.statusCode).toBe(403);
    await denied.fastify.close();

    const app = makeApp();
    const okPost = await app.fastify.inject({ method: 'POST', url: '/v1/admin/git-default-credentials', payload: { domain: 'x.com', accessToken: 'plain-token', description: 'd' } });
    const okPut = await app.fastify.inject({ method: 'PUT', url: '/v1/admin/git-default-credentials/1', payload: { accessToken: '', description: '' } });
    const okDel = await app.fastify.inject({ method: 'DELETE', url: '/v1/admin/git-default-credentials/1' });
    expect(okPost.statusCode).toBe(200);
    expect(okPut.statusCode).toBe(200);
    expect(okDel.statusCode).toBe(200);
    expect(app.service.create).toHaveBeenCalledWith('x.com', 'plain-token', 'd');
    expect(app.service.update).toHaveBeenCalledWith(1, '', '');
    expect((okPost.json() as { data: { accessToken: string } }).data.accessToken).not.toContain('plain-token');
    await app.fastify.close();
  });

  it('GET /v1/admin/git-domains：用户域 ∪ 系统默认域去重排序，无 agent:read → 403', async () => {
    const denied = makeApp({ permissions: { 'agent:read': false } });
    const resDenied = await denied.fastify.inject({ method: 'GET', url: '/v1/admin/git-domains' });
    expect(resDenied.statusCode).toBe(403);
    await denied.fastify.close();

    const app = makeApp({ userDomains: ['a.com', 'c.com'] });
    const res = await app.fastify.inject({ method: 'GET', url: '/v1/admin/git-domains' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { domains: string[] } };
    // 用户 [a.com, c.com] ∪ 系统 [b.com, a.com] → 去重排序
    expect(body.data.domains).toEqual(['a.com', 'b.com', 'c.com']);
    expect(JSON.stringify(body.data)).not.toContain('token');
    await app.fastify.close();
  });

  it('GET /v1/user/git-default-credentials：仅登录即可，不含 token 字段', async () => {
    const app = makeApp();
    const res = await app.fastify.inject({ method: 'GET', url: '/v1/user/git-default-credentials' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
    expect(body.data.every((item) => !('accessToken' in item) && !('access_token' in item))).toBe(true);
    expect(app.deps.permissionService.hasPermission).not.toHaveBeenCalled();
    await app.fastify.close();
  });

  it('业务错误码透传（3022 重复域 / 3021 不存在）', async () => {
    const { BusinessException } = await import('../common/business-exception.js');
    const app = makeApp();
    app.service.create.mockRejectedValueOnce(new BusinessException(ErrorCode.GIT_CREDENTIAL_DOMAIN_DUPLICATE));
    const dup = await app.fastify.inject({ method: 'POST', url: '/v1/admin/git-default-credentials', payload: { domain: 'a.com', accessToken: 'tok' } });
    expect((dup.json() as { code: number }).code).toBe(ErrorCode.GIT_CREDENTIAL_DOMAIN_DUPLICATE.code);

    app.service.delete.mockRejectedValueOnce(new BusinessException(ErrorCode.GIT_CREDENTIAL_NOT_FOUND));
    const missing = await app.fastify.inject({ method: 'DELETE', url: '/v1/admin/git-default-credentials/99' });
    expect((missing.json() as { code: number }).code).toBe(ErrorCode.GIT_CREDENTIAL_NOT_FOUND.code);
    await app.fastify.close();
  });
});
