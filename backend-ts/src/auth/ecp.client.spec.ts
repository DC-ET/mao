import { describe, expect, it, vi } from 'vitest';
import { EcpClient } from './ecp.client.js';
import { defaultEcpConfig } from './ecp.config.js';

describe('EcpClient', () => {
  const config = { ...defaultEcpConfig(), enabled: true };

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

  it('renew rejects expired session', async () => {
    const http = {
      request: vi.fn(async () => ({ status: 401, json: { message: 'expired' } })),
    };
    const client = new EcpClient(http);
    await expect(client.renewSession(config, 'old')).rejects.toThrow(/无法 renew/);
  });
});
