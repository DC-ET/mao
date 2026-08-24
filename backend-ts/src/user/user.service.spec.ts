import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { UserService } from './user.service.js';
import type { PasswordHasher, Role, User, UserRepository } from './types.js';
import type { PermissionService } from '../permission/permission.service.js';

function user(id: number, username: string, displayName: string, email: string | null, passwordHash: string | null, status: number): User {
  return { id, username, displayName, email, passwordHash, status };
}

describe('UserService', () => {
  const userRepo: UserRepository = {
    findById: vi.fn(),
    findByUsername: vi.fn(),
    countByUsername: vi.fn(),
    countByEmailExcept: vi.fn(),
    insert: vi.fn(async (u) => {
      u.id = 11;
      return 11;
    }),
    updateById: vi.fn(),
    updateFields: vi.fn(),
    selectPage: vi.fn(),
  };
  const permissionService = {
    assignRoles: vi.fn(),
    assertCanChangeRoles: vi.fn(),
    assertCanDisableUser: vi.fn(),
    batchGetUserRoles: vi.fn(),
    getUserRoles: vi.fn(),
  } as unknown as PermissionService;
  const hasher: PasswordHasher = {
    hash: vi.fn(async () => 'hash'),
    matches: vi.fn(),
  };
  const service = new UserService(userRepo, permissionService, hasher);

  it('listUsersBuildsPagedQuery', async () => {
    vi.mocked(userRepo.selectPage).mockResolvedValue({ records: [], total: 0 });
    const result = await service.listUsers(1, 10, ' alice ', 1);
    expect(result.current).toBe(1);
    expect(result.size).toBe(10);
    expect(userRepo.selectPage).toHaveBeenCalled();
  });

  it('getUserThrowsWhenMissing', async () => {
    vi.mocked(userRepo.findById).mockResolvedValue(null);
    await expect(service.getUser(99)).rejects.toBeInstanceOf(BusinessException);
  });

  it('createUserValidatesEncodesAndAssignsDefaultRole', async () => {
    vi.mocked(userRepo.countByUsername).mockResolvedValue(0);
    vi.mocked(hasher.hash).mockResolvedValue('hash');
    const created = await service.createUser('  alice_1  ', ' Alice ', ' a@example.test ', 'Passw0rd!', null, null);
    expect(created.username).toBe('alice_1');
    expect(created.displayName).toBe('Alice');
    expect(created.email).toBe('a@example.test');
    expect(created.passwordHash).toBe('hash');
    expect(created.status).toBe(1);
    expect(userRepo.insert).toHaveBeenCalledWith(created);
    expect(permissionService.assignRoles).toHaveBeenCalledWith(created.id, [2]);
  });

  it('createUserRejectsInvalidDuplicateOrWeakCredentials', async () => {
    await expect(service.createUser('x', 'X', null, 'Passw0rd!', null, null)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.createUser('alice', 'X', null, 'password', null, null)).rejects.toBeInstanceOf(BusinessException);
    vi.mocked(userRepo.countByUsername).mockResolvedValue(1);
    await expect(service.createUser('alice', 'X', null, 'Passw0rd!', null, null)).rejects.toBeInstanceOf(BusinessException);
  });

  it('updateUserAppliesOptionalFieldsAndRoles', async () => {
    const existing = user(7, 'alice', 'Alice', 'old@example.test', 'hash', 1);
    vi.mocked(userRepo.findById).mockResolvedValue(existing);
    const updated = await service.updateUser(7, ' New Name ', '', [1, 2], 0, 1);
    expect(updated.displayName).toBe('New Name');
    expect(updated.email).toBeNull();
    expect(updated.status).toBe(0);
    expect(permissionService.assertCanDisableUser).toHaveBeenCalledWith(7, 1);
    expect(permissionService.assertCanChangeRoles).toHaveBeenCalledWith(7, [1, 2]);
    expect(permissionService.assignRoles).toHaveBeenCalledWith(7, [1, 2]);
    expect(userRepo.updateById).toHaveBeenCalledWith(existing);
  });

  it('updateUserStatusChecksDisableRules', async () => {
    const existing = user(8, 'bob', 'Bob', null, 'hash', 1);
    vi.mocked(userRepo.findById).mockResolvedValue(existing);
    await service.updateUserStatus(8, 0, 1);
    expect(existing.status).toBe(0);
    expect(permissionService.assertCanDisableUser).toHaveBeenCalledWith(8, 1);
    expect(userRepo.updateById).toHaveBeenCalledWith(existing);
  });

  it('resetPasswordRejectsLdapUserAndUpdatesLocalUser', async () => {
    const ldap = user(9, 'ldap', 'Ldap', null, null, 1);
    vi.mocked(userRepo.findById).mockResolvedValue(ldap);
    await expect(service.resetPassword(9, 'Newpass1')).rejects.toBeInstanceOf(BusinessException);

    const local = user(10, 'local', 'Local', null, 'old', 1);
    vi.mocked(userRepo.findById).mockResolvedValue(local);
    vi.mocked(hasher.hash).mockResolvedValue('new-hash');
    await service.resetPassword(10, 'Newpass1');
    expect(local.passwordHash).toBe('new-hash');
  });

  it('resolveAuthSource', () => {
    expect(UserService.resolveAuthSource({ username: 'a', passwordHash: 'x' })).toBe('LOCAL');
    expect(UserService.resolveAuthSource({ username: 'a', feishuUserId: 'f' })).toBe('FEISHU');
    expect(UserService.resolveAuthSource({ username: 'a' })).toBe('LDAP');
  });

  it('batchGetUserRoles delegates', async () => {
    const map = new Map<number, Role[]>();
    vi.mocked(permissionService.batchGetUserRoles).mockResolvedValue(map);
    await expect(service.batchGetUserRoles([1])).resolves.toBe(map);
  });
});
