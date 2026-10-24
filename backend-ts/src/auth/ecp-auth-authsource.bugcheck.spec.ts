import { describe, expect, it, vi } from 'vitest';
import { EcpAuthService } from './ecp-auth.service.js';
import { EcpIdentityRepository } from './ecp-identity.repository.js';

/**
 * ECP 换票登录返回的 authSource 必须是 ECP。
 *
 * EcpIdentityRepository 原先用裸 `SELECT * FROM user` 取行，没有 user.repository 里那条
 * `(SELECT provider ...) AS external_provider` 派生列；UserService.resolveAuthSource
 * 在无密码/无飞书 id 时兜底成 'LDAP'，于是同一账号走 ECP 登录显示「LDAP」，
 * 而 /auth/me 走 findById 显示「ECP」。
 */
const ECP_USER = {
  id: 5,
  username: 'ecp_5',
  displayName: 'A',
  email: 'a@example.com',
  passwordHash: null,
  feishuUserId: null,
  status: 1,
  deleted: 0,
};

function makeRepository(earliestProvider: string | null) {
  const tx = {
    queryOne: vi.fn(async (sql: string) => {
      if (sql.includes('user_identity_write_lock')) return { id: 1 };
      if (sql.includes('SELECT provider FROM user_external_identity')) {
        return earliestProvider == null ? null : { provider: earliestProvider };
      }
      // 该用户还没有 ecp 绑定 → 走 insert 分支
      if (sql.includes('SELECT id, subject FROM user_external_identity')) return null;
      return null;
    }),
    query: vi.fn(async () => [ECP_USER]),
    insert: vi.fn(async () => 1),
    updateById: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ affectedRows: 1 })),
  };
  const db = { transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx) };
  return { repo: new EcpIdentityRepository(db as never), tx };
}

function makeService(userRow: Record<string, unknown>) {
  const service = new EcpAuthService(
    { updateById: vi.fn(async () => undefined), findById: vi.fn(async () => null) } as never,
    {
      findByState: vi.fn(async () => ({
        state: 'state-1', status: 'PENDING', expiresAt: '2099-01-01 00:00:00', userId: null,
      })),
      claimPending: vi.fn(async () => 1),
      updateByState: vi.fn(async () => 1),
      insert: vi.fn(),
    } as never,
    { resolve: vi.fn(async () => ({ user: userRow, action: 'existing' })) } as never,
    { upsert: vi.fn(async () => undefined), encryptToken: vi.fn(() => 'enc') } as never,
    { generateToken: vi.fn(() => 'access'), generateRefreshToken: vi.fn(() => 'refresh') } as never,
    { buildLoginResult: vi.fn() } as never,
    async () => ({ enabled: true, appCode: 'app', baseUrl: 'https://ecp.example.com' }) as never,
    {
      createFeishuAuthorization: vi.fn(),
      createSessionFromFeishuCallback: vi.fn(async () => ({
        user: { email: 'a@example.com', displayName: 'A' },
        sessionToken: 'token',
        expiresAt: '2099-01-01 00:00:00',
      })),
    } as never,
  );
  return service;
}

describe('ECP 登录返回的 authSource', () => {
  it('EcpIdentityRepository 必须补齐 external_provider（当前登录因此显示 LDAP）', async () => {
    const { repo, tx } = makeRepository('ecp');
    const { user } = await repo.resolve({ email: 'a@example.com', displayName: 'A' });
    expect(user.externalProvider).toBe('ecp');
    expect(tx.insert).toHaveBeenCalledWith(
      'user_external_identity',
      expect.objectContaining({ provider: 'ecp', userId: 5 }),
    );
  });

  it('服务层用仓储补齐后的用户行构造登录响应 → ECP', async () => {
    const login = await makeService({ ...ECP_USER, externalProvider: 'ecp' })
      .handleCallback('state-1', 'code-1');
    expect(login.user.authSource).toBe('ECP');
  });

  it('对照：无 external_provider 的历史形状仍按 resolveAuthSource 兜底（不改判定规则）', async () => {
    const { repo } = makeRepository(null);
    const { user } = await repo.resolve({ email: 'a@example.com', displayName: 'A' });
    expect(user.externalProvider).toBeNull();
  });

  it('对照：更早绑定其它 provider 时保留最早来源，不硬写成 ecp', async () => {
    const { repo } = makeRepository('company_sso');
    const { user } = await repo.resolve({ email: 'a@example.com', displayName: 'A' });
    expect(user.externalProvider).toBe('company_sso');
  });
});
