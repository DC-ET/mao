import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import type { User } from '../user/types.js';
import { CompanySsoIdentityRepository } from './company-sso-identity.repository.js';
import { EcpIdentityRepository } from './ecp-identity.repository.js';
import { isActiveAccount } from '../permission/permission.service.js';

/**
 * BUGCHECK（审查新增，非产品代码）：user.status 是文档化的三态列
 * （user.service.ts:15 注释「0=禁用 1=启用 null=未设置」；permission.service.ts:15
 * isActiveAccount = status !== 0；本地密码登录 auth.service.ts:34/50 只拒 status===0）。
 * 但 ecp-identity.repository.ts:72 与 company-sso-identity.repository.ts:68 的
 * assertActive 用 `status !== 1`，把 status=NULL 的未设置账号判为「已禁用」拒绝登录，
 * 与同一账号本地登录成功的结论相反。
 * 断言按「正确行为」书写，当前源码下失败即证明 BUG 真实存在。
 */
function fakeDb(userRow: User) {
  const tx = {
    queryOne: vi.fn(async (sql: string) => {
      if (sql.includes('user_identity_write_lock')) return { id: 1 };
      if (sql.includes('user_external_identity')) return null;
      if (sql.includes('FROM role')) return { id: 2 };
      if (sql.includes('`user` WHERE id')) return userRow;
      return null;
    }),
    query: vi.fn(async (sql: string) => (sql.includes('BINARY email') ? [userRow] : [])),
    insert: vi.fn(async () => 4),
    updateById: vi.fn(),
  };
  return { transaction: vi.fn(async (fn: (d: unknown) => Promise<unknown>) => fn(tx)) } as unknown as Db;
}

function user(status: number | null, deleted = 0): User {
  return { id: 4, username: 'u', email: 'u@example.test', status, deleted };
}

describe('BUGCHECK SSO/ECP login with status = NULL (unset)', () => {
  it('isActiveAccount treats NULL as active (canonical semantics)', () => {
    expect(isActiveAccount(null)).toBe(true);
    expect(isActiveAccount(undefined)).toBe(true);
    expect(isActiveAccount(1)).toBe(true);
    expect(isActiveAccount(0)).toBe(false);
  });

  it('company SSO binds an unset-status account instead of forbidding it', async () => {
    const repo = new CompanySsoIdentityRepository(fakeDb(user(null)));
    await expect(repo.resolve({
      subject: 'u@example.test', email: 'u@example.test', displayName: 'U', expiresAt: Date.now() + 3600_000,
    })).resolves.toMatchObject({ action: 'bound' });
  });

  it('ECP login binds an unset-status account instead of forbidding it', async () => {
    const repo = new EcpIdentityRepository(fakeDb(user(null)));
    await expect(repo.resolve({ email: 'u@example.test', displayName: 'U' }))
      .resolves.toMatchObject({ action: 'bound' });
  });

  it('still forbids disabled and deleted accounts (control group)', async () => {
    await expect(new CompanySsoIdentityRepository(fakeDb(user(0))).resolve({
      subject: 'u@example.test', email: 'u@example.test', displayName: 'U', expiresAt: Date.now() + 3600_000,
    })).rejects.toMatchObject({ status: 403 });
    await expect(new CompanySsoIdentityRepository(fakeDb(user(1, 1))).resolve({
      subject: 'u@example.test', email: 'u@example.test', displayName: 'U', expiresAt: Date.now() + 3600_000,
    })).rejects.toMatchObject({ status: 403 });
    await expect(new EcpIdentityRepository(fakeDb(user(0))).resolve({ email: 'u@example.test', displayName: 'U' }))
      .rejects.toMatchObject({ code: 5002 });
  });
});
