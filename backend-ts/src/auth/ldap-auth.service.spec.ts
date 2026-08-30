import { beforeEach, describe, expect, it, vi } from 'vitest';

const bind = vi.fn();
const search = vi.fn();
const unbind = vi.fn();

vi.mock('ldapts', () => ({
  Client: class {
    bind = bind;
    search = search;
    unbind = unbind;
  },
}));

import { BusinessException } from '../common/business-exception.js';
import { JwtService } from '../crypto/jwt.service.js';
import { LdapAuthService } from './ldap-auth.service.js';

const jwt = new JwtService('mao-dev-jwt-secret-change-me-32bytes!!', 86400000, 604800000, 7200000);

function cfg(overrides: Record<string, unknown> = {}) {
  return async () => ({
    enabled: true,
    url: 'ldap://example.test:389',
    baseDn: 'dc=example,dc=test',
    userDn: 'cn=admin,dc=example,dc=test',
    password: 'secret',
    userSearchBase: 'ou=users',
    ...overrides,
  }) as never;
}

describe('LdapAuthService', () => {
  beforeEach(() => {
    bind.mockReset();
    search.mockReset();
    unbind.mockReset();
    bind.mockResolvedValue(undefined);
    unbind.mockResolvedValue(undefined);
  });

  it('isConfiguredRequiresEnabledAndUrl', async () => {
    const userRepo = { findByUsername: vi.fn(), insert: vi.fn(), updateById: vi.fn() };
    const userRoleRepo = { insert: vi.fn() };
    expect(await new LdapAuthService(userRepo as never, userRoleRepo as never, jwt, cfg({ enabled: false }) as never).isConfigured()).toBe(false);
    expect(await new LdapAuthService(userRepo as never, userRoleRepo as never, jwt, cfg({ url: '' }) as never).isConfigured()).toBe(false);
    expect(await new LdapAuthService(userRepo as never, userRoleRepo as never, jwt, cfg() as never).isConfigured()).toBe(true);
  });

  it('authenticateCreatesUserOnFirstLogin', async () => {
    search.mockResolvedValue({
      searchEntries: [{ dn: 'cn=Ada,ou=users,dc=example,dc=test', cn: 'Ada', mail: 'ada@example.test' }],
    });
    const userRepo = {
      findByUsername: vi.fn(async () => null),
      insert: vi.fn(async (u: { id?: number }) => { u.id = 4; return 4; }),
      updateById: vi.fn(),
    };
    const userRoleRepo = { insert: vi.fn() };
    const service = new LdapAuthService(userRepo as never, userRoleRepo as never, jwt, cfg() as never);
    const vo = await service.authenticate('ada', 'pw');
    expect(vo.user.username).toBe('ada');
    expect(vo.user.authSource).toBe('LDAP');
    expect(userRoleRepo.insert).toHaveBeenCalledWith({ userId: 4, roleId: 2 });
    expect(vo.accessToken).toBeTruthy();
  });

  it('authenticateRejectsMissingUserAndUnconfigured', async () => {
    const userRepo = { findByUsername: vi.fn(), insert: vi.fn(), updateById: vi.fn() };
    const userRoleRepo = { insert: vi.fn() };
    const unconfigured = new LdapAuthService(userRepo as never, userRoleRepo as never, jwt, cfg({ enabled: false }) as never);
    await expect(unconfigured.authenticate('a', 'b')).rejects.toBeInstanceOf(BusinessException);
    search.mockResolvedValue({ searchEntries: [] });
    const service = new LdapAuthService(userRepo as never, userRoleRepo as never, jwt, cfg() as never);
    await expect(service.authenticate('ghost', 'pw')).rejects.toBeInstanceOf(BusinessException);
  });

  it('authenticateRejectsDisabledExistingUser', async () => {
    search.mockResolvedValue({
      searchEntries: [{ dn: 'cn=Ada,ou=users,dc=example,dc=test', cn: 'Ada', mail: 'ada@example.test' }],
    });
    const userRepo = {
      findByUsername: vi.fn(async () => ({
        id: 4, username: 'ada', displayName: 'Ada', email: 'ada@example.test', status: 0,
      })),
      insert: vi.fn(),
      updateById: vi.fn(),
    };
    const userRoleRepo = { insert: vi.fn() };
    const service = new LdapAuthService(userRepo as never, userRoleRepo as never, jwt, cfg() as never);
    await expect(service.authenticate('ada', 'pw')).rejects.toMatchObject({ code: 1006 });
    expect(userRepo.updateById).not.toHaveBeenCalled();
  });
});
