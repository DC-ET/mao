import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { JwtService } from '../crypto/jwt.service.js';
import { AuthService } from './auth.service.js';
import type { LdapAuthService } from './ldap-auth.service.js';
import type { PasswordHasher, User, UserRepository } from '../user/types.js';

function user(id: number, username: string, hash: string | null, status: number): User {
  return { id, username, passwordHash: hash, status };
}

describe('AuthService', () => {
  const userRepo: UserRepository = {
    findById: vi.fn(),
    findByUsername: vi.fn(),
    countByUsername: vi.fn(),
    countByEmailExcept: vi.fn(),
    insert: vi.fn(),
    updateById: vi.fn(),
    updateFields: vi.fn(),
    selectPage: vi.fn(),
  };
  const jwtService = {
    generateToken: vi.fn(() => 'access'),
    generateRefreshToken: vi.fn(() => 'refresh'),
    validateToken: vi.fn(),
    getUserIdFromToken: vi.fn(),
    getUsernameFromToken: vi.fn(),
  } as unknown as JwtService;
  const hasher: PasswordHasher = {
    hash: vi.fn(),
    matches: vi.fn(),
  };
  const ldap = {
    isConfigured: vi.fn(),
    authenticate: vi.fn(),
  } as unknown as LdapAuthService;
  const service = new AuthService(userRepo, jwtService, hasher, ldap);

  it('loginWithLocalPasswordUpdatesLastLoginAndReturnsTokens', async () => {
    const u = user(1, 'alice', 'hash', 1);
    vi.mocked(userRepo.findByUsername).mockResolvedValue(u);
    vi.mocked(hasher.matches).mockResolvedValue(true);
    const vo = await service.login('alice', 'secret');
    expect(vo.accessToken).toBe('access');
    expect(vo.refreshToken).toBe('refresh');
    expect(vo.expiresIn).toBe(86400);
    expect(vo.user.username).toBe('alice');
    expect(u.lastLoginAt).toBeTruthy();
    expect(userRepo.updateById).toHaveBeenCalledWith(u);
  });

  it('loginRejectsDisabledAccountAndFallsBackToLdap', async () => {
    const disabled = user(2, 'disabled', 'hash', 0);
    vi.mocked(userRepo.findByUsername).mockResolvedValue(disabled);
    vi.mocked(hasher.matches).mockResolvedValue(true);
    await expect(service.login('disabled', 'secret')).rejects.toBeInstanceOf(BusinessException);

    vi.mocked(userRepo.findByUsername).mockResolvedValue(null);
    vi.mocked(ldap.isConfigured).mockReturnValue(true);
    vi.mocked(ldap.authenticate).mockResolvedValue({ accessToken: 'ldap-access', refreshToken: 'r', expiresIn: 1, user: { username: 'ldap' } });
    expect((await service.login('ldap', 'secret')).accessToken).toBe('ldap-access');

    vi.mocked(ldap.authenticate).mockRejectedValue(new Error('bad'));
    await expect(service.login('ldap', 'bad')).rejects.toBeInstanceOf(BusinessException);
  });

  it('refreshTokenValidatesAndReturnsNewTokens', async () => {
    const u = user(3, 'bob', 'hash', 1);
    vi.mocked(jwtService.validateToken).mockReturnValue(true);
    vi.mocked(jwtService.getUserIdFromToken).mockReturnValue(3);
    vi.mocked(jwtService.getUsernameFromToken).mockReturnValue('bob');
    vi.mocked(userRepo.findById).mockResolvedValue(u);
    vi.mocked(jwtService.generateToken).mockReturnValue('new-access');
    vi.mocked(jwtService.generateRefreshToken).mockReturnValue('new-refresh');
    const vo = await service.refreshToken('refresh');
    expect(vo.accessToken).toBe('new-access');
    expect(vo.refreshToken).toBe('new-refresh');
  });

  it('logout is a no-op', () => {
    service.logout();
  });
});
