import { describe, expect, it, vi } from 'vitest';
import { EcpClient, resolveEcpOAuthState } from './ecp.client.js';
import { defaultEcpConfig } from './ecp.config.js';

describe('EcpClient', () => {
  const config = { ...defaultEcpConfig(), enabled: true };

  it('resolveEcpOAuthState prefers response body then authorizeUrl query', () => {
    expect(resolveEcpOAuthState({
      authorizeUrl: 'https://feishu.example/auth?state=from-url',
      state: 'from-body',
    })).toBe('from-body');
    expect(resolveEcpOAuthState({
      authorizeUrl: 'https://feishu.example/auth?state=from-url',
    })).toBe('from-url');
  });

  it('creates feishu authorization', async () => {
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        json: { code: 0, data: { authorizeUrl: 'https://feishu.example/auth' } },
      })),
    };
    const client = new EcpClient(http);
    const result = await client.createFeishuAuthorization(config, 'https://mao.example/callback');
    expect(result.authorizeUrl).toContain('feishu.example');
  });

  it('exchanges feishu callback for session', async () => {
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        json: {
          code: 0,
          data: {
            sessionToken: 'tok-1',
            expiresAt: Date.now() + 3600_000,
            user: { email: 'a@example.com', realName: 'Alice' },
          },
        },
      })),
    };
    const client = new EcpClient(http);
    const session = await client.createSessionFromFeishuCallback(config, 'code', 'state');
    expect(session.sessionToken).toBe('tok-1');
    expect(session.user.email).toBe('a@example.com');
  });

  it('renews a session when the response has no user info', async () => {
    // ECP renew 只换票，不返回 user；曾因复用登录解析而误报「缺少用户邮箱」
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        json: {
          code: 0,
          data: {
            sessionToken: 'tok-renewed',
            expiresAt: Date.now() + 3600_000,
          },
        },
      })),
    };
    const client = new EcpClient(http);
    const renewed = await client.renewSession(config, 'old-token');
    expect(renewed.sessionToken).toBe('tok-renewed');
    expect(renewed.expiresAt).toBeInstanceOf(Date);
    expect(renewed).not.toHaveProperty('user');
  });

  it('renew rejects expired session', async () => {
    const http = {
      request: vi.fn(async () => ({ status: 401, json: { message: 'expired' } })),
    };
    const client = new EcpClient(http);
    await expect(client.renewSession(config, 'old')).rejects.toThrow(/无法 renew/);
  });

  it('exchanges ECP session for bare OAuth UAT response', async () => {
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        json: {
          access_token: 'u-abc',
          expires_in: 833,
          scope: 'contact:user.base:readonly',
          token_type: 'Bearer',
          issued_token_type: 'urn:ecp:token-type:feishu-user-access-token',
        },
      })),
    };
    const client = new EcpClient(http);
    const uat = await client.getUserAccessToken(config, 'ecp-session-token');
    expect(uat.accessToken).toBe('u-abc');
    expect(uat.scope).toBe('contact:user.base:readonly');
    expect(uat.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(String(http.request.mock.calls[0][1])).toContain('appCode=');
    expect(String(http.request.mock.calls[0][1])).toContain('ecpUserToken=ecp-session-token');
  });

  it('exchanges ECP session for wrapped UAT response', async () => {
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        json: { code: 0, data: { access_token: 'u-wrapped', expires_in: 60 } },
      })),
    };
    const client = new EcpClient(http);
    const uat = await client.getUserAccessToken(config, 'tok');
    expect(uat.accessToken).toBe('u-wrapped');
  });

  it('rejects UAT response without access_token', async () => {
    const http = {
      request: vi.fn(async () => ({ status: 200, json: { expires_in: 60 } })),
    };
    const client = new EcpClient(http);
    await expect(client.getUserAccessToken(config, 'tok')).rejects.toThrow(/access_token/);
  });

  it('surfaces OAuth error description on non-2xx', async () => {
    const http = {
      request: vi.fn(async () => ({
        status: 400,
        json: { error: 'invalid_grant', error_description: 'session expired' },
      })),
    };
    const client = new EcpClient(http);
    await expect(client.getUserAccessToken(config, 'tok')).rejects.toThrow(/session expired/);
  });
});
