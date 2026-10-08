import { describe, expect, it, vi } from 'vitest';
import { authenticateRequest, isPublicPath } from './jwt-hook.js';

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

  it('hook 公开路径：POST /v1/open/hooks/* 免 JWT 门槛', () => {
    expect(isPublicPath('GET', '/api/v1/share/public/abc')).toBe(true);
    expect(isPublicPath('GET', '/api/v1/share/abc')).toBe(false);
    expect(isPublicPath('POST', '/api/v1/open/hooks/abc')).toBe(true);
    expect(isPublicPath('GET', '/api/v1/open/hooks/abc')).toBe(false);
    expect(isPublicPath('POST', '/api/v1/open/tokens')).toBe(false);
  });

  it('mao_ 前缀走查库降级：命中挂 scopes/tokenId，未命中返回 null', async () => {
    const resolver = vi.fn(async (plain: string) =>
      plain === 'mao_good' ? { userId: 7, scopes: ['open:run'], tokenId: 3 } : null);
    expect(await authenticateRequest(requestOf({ authorization: 'Bearer mao_good' }), jwt, resolver)).toBe(7);
    expect(await authenticateRequest(requestOf({ authorization: 'Bearer mao_bad' }), jwt, resolver)).toBeNull();
  });

  it('API Token 仅 /v1/open/** 生效：其它端点一律 401 且不查库（防越权调用任意 REST）', async () => {
    const resolver = vi.fn(async () => ({ userId: 7, scopes: ['open:run'], tokenId: 3 }));
    for (const url of ['/api/v1/agents', '/api/v1/sessions/1/messages', '/api/v1/open', '/api/v1/openx/y']) {
      expect(await authenticateRequest(requestOf({ authorization: 'Bearer mao_good' }, {}, url), jwt, resolver)).toBeNull();
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it('mao_ 前缀仅认 Bearer 头：query 通道一律拒绝（token 不进 URL）', async () => {
    const resolver = vi.fn(async () => ({ userId: 7, scopes: ['open:run'], tokenId: 3 }));
    expect(await authenticateRequest(requestOf({}, { token: 'mao_good' }, '/api/v1/sessions'), jwt, resolver)).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('普通 JWT 路径不受影响：校验通过返回 userId 且不触发查库', async () => {
    const localJwt = { validateAccessToken: vi.fn(() => true), getUserIdFromToken: vi.fn(() => 9) } as never;
    const resolver = vi.fn(async () => null);
    expect(await authenticateRequest(requestOf({ authorization: 'Bearer eyJhbGciOiJ.abc.def' }, {}, '/api/v1/sessions'), localJwt, resolver)).toBe(9);
    expect(resolver).not.toHaveBeenCalled();
  });
});
