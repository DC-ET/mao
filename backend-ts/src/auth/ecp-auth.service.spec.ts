import { describe, expect, it, vi } from 'vitest';
import { JwtService } from '../crypto/jwt.service.js';
import { formatShanghaiDateTime, parseShanghaiDateTime } from './auth.service.js';
import { EcpAuthService } from './ecp-auth.service.js';
import { defaultEcpConfig } from './ecp.config.js';
import { ECP_PENDING, ECP_SUCCESS } from './ecp-oauth.repository.js';
import type { User, UserRepository } from '../user/types.js';

const jwt = new JwtService('mao-dev-jwt-secret-change-me-32bytes!!', 86400000, 604800000, 7200000);

describe('EcpAuthService', () => {
  it('stores ECP OAuth state from authorization response for callback lookup', async () => {
    const stateRepo = {
      insert: vi.fn(),
      findByState: vi.fn(),
      updateByState: vi.fn(),
      consumeSuccess: vi.fn(),
      claimPending: vi.fn(),
    };
    const client = {
      createFeishuAuthorization: vi.fn(async () => ({
        authorizeUrl: 'https://feishu.example/auth',
        state: 'ecp-state-9',
      })),
      createSessionFromFeishuCallback: vi.fn(),
    };
    const service = new EcpAuthService(
      {} as UserRepository,
      stateRepo,
      {} as never,
      {} as never,
      jwt,
      { buildLoginResult: vi.fn() },
      async () => ({ ...defaultEcpConfig(), enabled: true }),
      client,
    );
    const result = await service.startFeishuLogin('desktop');
    expect(result.state).toBe('ecp-state-9');
    const inserted = stateRepo.insert.mock.calls[0][0] as { state: string; expiresAt: string };
    expect(inserted.state).toBe('ecp-state-9');
    const expected = formatShanghaiDateTime(new Date(Date.now() + 300_000));
    expect(Math.abs(Date.parse(inserted.expiresAt.replace(' ', 'T') + '+08:00') - Date.parse(expected.replace(' ', 'T') + '+08:00'))).toBeLessThan(2000);
  });

  it('formats Shanghai wall clock instead of the process timezone', () => {
    expect(formatShanghaiDateTime(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01 08:00:00');
  });

  it('parses Shanghai wall clock as +08:00 regardless of process timezone', () => {
    expect(parseShanghaiDateTime('2026-01-01 08:00:00')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('invokes onAuthenticated after successful callback', async () => {
    const onAuthenticated = vi.fn(async () => {});
    const stateRepo = {
      insert: vi.fn(),
      findByState: vi.fn(async () => ({
        state: 'state-1',
        callbackTarget: 'desktop',
        status: ECP_PENDING,
        expiresAt: '2099-01-01 00:00:00',
      })),
      updateByState: vi.fn(async () => 1),
      consumeSuccess: vi.fn(),
      claimPending: vi.fn(async () => 1),
    };
    const sessions = {
      upsert: vi.fn(),
      encryptToken: vi.fn(() => 'enc'),
    };
    const identities = {
      resolve: vi.fn(async () => ({
        user: { id: 42, username: 'u1', status: 1, deleted: 0 } as User,
        action: 'existing' as const,
      })),
    };
    const userRepo = {
      updateById: vi.fn(),
      findById: vi.fn(),
    };
    const client = {
      createFeishuAuthorization: vi.fn(),
      createSessionFromFeishuCallback: vi.fn(async () => ({
        sessionToken: 'token',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
        user: { email: 'a@b.com', displayName: 'A' },
      })),
    };
    const service = new EcpAuthService(
      userRepo as unknown as UserRepository,
      stateRepo,
      identities,
      sessions as never,
      jwt,
      { buildLoginResult: vi.fn() },
      async () => ({ ...defaultEcpConfig(), enabled: true }),
      client,
      onAuthenticated,
    );
    await service.completeStateWithCode('state-1', 'code-1');
    expect(onAuthenticated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      'state-1',
    );
    expect(stateRepo.updateByState).toHaveBeenCalledWith(
      'state-1',
      'PROCESSING',
      expect.objectContaining({ status: ECP_SUCCESS, userId: 42 }),
    );
  });

  it('rejects channel callback without state or code', async () => {
    const service = new EcpAuthService(
      {} as UserRepository,
      {} as never,
      {} as never,
      {} as never,
      jwt,
      { buildLoginResult: vi.fn() },
      async () => ({ ...defaultEcpConfig(), enabled: true }),
      { createFeishuAuthorization: vi.fn(), createSessionFromFeishuCallback: vi.fn() },
    );
    expect(await service.completeChannelCallback(undefined, 'code')).toEqual({
      ok: false,
      message: '回调参数不完整（缺少 state 或 code）。',
    });
    expect(await service.completeChannelCallback('state', ' ')).toEqual({
      ok: false,
      message: '回调参数不完整（缺少 state 或 code）。',
    });
  });

  it('returns the bound account as the channel callback message', async () => {
    const stateRepo = {
      insert: vi.fn(),
      findByState: vi.fn(async () => ({
        state: 'state-c',
        callbackTarget: 'channel' as const,
        status: ECP_PENDING,
        expiresAt: '2099-01-01 00:00:00',
      })),
      updateByState: vi.fn(async () => 1),
      consumeSuccess: vi.fn(),
      claimPending: vi.fn(async () => 1),
    };
    const service = new EcpAuthService(
      { updateById: vi.fn() } as unknown as UserRepository,
      stateRepo,
      {
        resolve: vi.fn(async () => ({
          user: { id: 7, username: 'u7', displayName: '杨佳毅', email: 'yangjiayi@accesscorporate.com.cn', status: 1, deleted: 0 } as User,
          action: 'existing' as const,
        })),
      } as never,
      { upsert: vi.fn(), encryptToken: vi.fn(() => 'enc') } as never,
      jwt,
      { buildLoginResult: vi.fn() },
      async () => ({ ...defaultEcpConfig(), enabled: true }),
      {
        createFeishuAuthorization: vi.fn(),
        createSessionFromFeishuCallback: vi.fn(async () => ({
          sessionToken: 'token',
          expiresAt: new Date('2099-01-01T00:00:00Z'),
          user: { email: 'yangjiayi@accesscorporate.com.cn', displayName: '杨佳毅' },
        })),
      },
    );
    expect(await service.completeChannelCallback('state-c', 'code-c')).toEqual({ ok: true, message: '杨佳毅' });
  });
});
