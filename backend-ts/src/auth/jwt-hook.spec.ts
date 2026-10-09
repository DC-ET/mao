import { describe, expect, it, vi } from 'vitest';
import { authenticateRequest, autoDisabledTokenBlocksRequest, isPublicPath } from './jwt-hook.js';

describe('jwt-hook public paths', () => {
  it('matches Java SecurityConfig whitelist', () => {
    expect(isPublicPath('POST', '/api/v1/auth/login')).toBe(true);
    expect(isPublicPath('GET', '/api/swagger-ui.html')).toBe(true);
    expect(isPublicPath('GET', '/api/v3/api-docs')).toBe(true);
    expect(isPublicPath('GET', '/api/ws/stream')).toBe(true);
    expect(isPublicPath('GET', '/api/uploads/x')).toBe(true);
    expect(isPublicPath('POST', '/api/v1/users')).toBe(false);
    expect(isPublicPath('GET', '/api/v1/sessions')).toBe(false);
    expect(isPublicPath('GET', '/api/v1/dingtalk/bind/abc')).toBe(true);
    expect(isPublicPath('GET', '/api/v1/dingtalk/oauth/callback')).toBe(true);
    expect(isPublicPath('POST', '/api/v1/dingtalk/binding')).toBe(false);
  });
});


describe('开放接口身份层（mao_ 前缀分流）', () => {
  const jwt = { validateAccessToken: vi.fn(() => false), getUserIdFromToken: vi.fn() } as never;
  const requestOf = (
    headers: Record<string, string>,
    query: Record<string, string> = {},
    url = '/api/v1/open/agents/1/run',
  ) => ({
    headers,
    query,
    url,
  } as never as Parameters<typeof authenticateRequest>[0]);

  it('hook 公开路径：POST /v1/open/hooks/* 免 JWT 门槛，也不被自动停用 Token 提前拦住', () => {
    expect(isPublicPath('GET', '/api/v1/share/public/abc')).toBe(true);
    expect(isPublicPath('GET', '/api/v1/share/abc')).toBe(false);
    expect(isPublicPath('POST', '/api/v1/open/hooks/abc')).toBe(true);
    expect(isPublicPath('GET', '/api/v1/open/hooks/abc')).toBe(false);
    expect(isPublicPath('POST', '/api/v1/open/tokens')).toBe(false);
    expect(autoDisabledTokenBlocksRequest('POST', '/api/v1/open/hooks/abc')).toBe(false);
    expect(autoDisabledTokenBlocksRequest('POST', '/api/v1/open/agents/1/run')).toBe(true);
  });

  it('mao_ 前缀走查库降级：命中挂 scopes/tokenId，未命中由 resolver 拒绝', async () => {
    const resolver = vi.fn(async (plain: string) =>
      plain === 'mao_good'
        ? { ok: true as const, userId: 7, scopes: ['open:run' as const], tokenId: 3 }
        : { ok: false as const, reason: 'not_found' as const, tokenPrefix: plain.slice(0, 12) });
    expect(await authenticateRequest(requestOf({ authorization: 'Bearer mao_good' }), jwt, resolver)).toEqual({
      userId: 7, tokenAutoDisabled: false, resolverRejected: false,
    });
    expect(await authenticateRequest(requestOf({ authorization: 'Bearer mao_bad' }), jwt, resolver)).toEqual({
      userId: null, tokenAutoDisabled: false, resolverRejected: true,
    });
  });

  it('API Token 仅 /v1/open/** 生效：其它端点一律未认证且不查库', async () => {
    const resolver = vi.fn(async () => ({ ok: true as const, userId: 7, scopes: ['open:run' as const], tokenId: 3 }));
    for (const url of ['/api/v1/agents', '/api/v1/sessions/1/messages', '/api/v1/open', '/api/v1/openx/y']) {
      expect(await authenticateRequest(requestOf({ authorization: 'Bearer mao_good' }, {}, url), jwt, resolver)).toEqual({
        userId: null, tokenAutoDisabled: false, resolverRejected: false,
      });
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it('mao_ 前缀仅认 Bearer 头：query 通道一律拒绝（token 不进 URL）', async () => {
    const resolver = vi.fn(async () => ({ ok: true as const, userId: 7, scopes: ['open:run' as const], tokenId: 3 }));
    expect(await authenticateRequest(requestOf({}, { token: 'mao_good' }, '/api/v1/sessions'), jwt, resolver)).toEqual({
      userId: null, tokenAutoDisabled: false, resolverRejected: false,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('普通 JWT 路径不受影响：校验通过返回 userId 且不触发查库', async () => {
    const localJwt = { validateAccessToken: vi.fn(() => true), getUserIdFromToken: vi.fn(() => 9) } as never;
    const resolver = vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const, tokenPrefix: '' }));
    expect(await authenticateRequest(requestOf({ authorization: 'Bearer eyJhbGciOiJ.abc.def' }, {}, '/api/v1/sessions'), localJwt, resolver)).toEqual({
      userId: 9, tokenAutoDisabled: false, resolverRejected: false,
    });
    expect(resolver).not.toHaveBeenCalled();
  });
});
