import { describe, expect, it, vi } from 'vitest';
import { JwtService } from '../crypto/jwt.service.js';
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
    expect(stateRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ state: 'ecp-state-9' }));
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
});
