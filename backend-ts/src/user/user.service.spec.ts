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
    changeRolesWithAdminGuard: vi.fn(),
    assertCanChangeRoles: vi.fn(),
    assertCanDisableUser: vi.fn(),
    updateUserStatusWithAdminGuard: vi.fn(),
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
    expect(permissionService.changeRolesWithAdminGuard).toHaveBeenCalledWith(7, [1, 2]);
    // 禁用写入走守卫事务（检查与 status 写入原子），整行写不再覆盖 status
    expect(permissionService.updateUserStatusWithAdminGuard).toHaveBeenCalledWith(7, 1, 0);
    expect(userRepo.updateById).toHaveBeenCalledWith(existing);
  });

  it('updateUserStatusDelegatesToGuardedWriteAndRejectsInvalidValues', async () => {
    const existing = user(8, 'bob', 'Bob', null, 'hash', 1);
    vi.mocked(userRepo.findById).mockResolvedValue(existing);
    await service.updateUserStatus(8, 0, 1);
    expect(permissionService.updateUserStatusWithAdminGuard).toHaveBeenCalledWith(8, 1, 0);
    // 非法取值直接拒绝（本地登录只认 0 禁用、筛选按 0/1 分组，任意整数会语义错乱）
    await expect(service.updateUserStatus(8, 5, 1)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.updateUserStatus(8, -1, 1)).rejects.toBeInstanceOf(BusinessException);
  });

  it('resetPasswordSetsLocalPasswordForExternalAndLocalUsers', async () => {
    vi.mocked(userRepo.findById).mockResolvedValue(null);
    await expect(service.resetPassword(404, 'Newpass1')).rejects.toBeInstanceOf(BusinessException);

    const external = user(9, 'ldap', 'Ldap', null, null, 1);
    vi.mocked(userRepo.findById).mockResolvedValue(external);
    await expect(service.resetPassword(9, 'password')).rejects.toBeInstanceOf(BusinessException);
    expect(external.passwordHash).toBeNull();

    vi.mocked(hasher.hash).mockResolvedValue('new-hash');
    await service.resetPassword(9, 'Newpass1');
    expect(external.passwordHash).toBe('new-hash');
    expect(userRepo.updateById).toHaveBeenCalledWith(external);

    const local = user(10, 'local', 'Local', null, 'old', 1);
    vi.mocked(userRepo.findById).mockResolvedValue(local);
    await service.resetPassword(10, 'Newpass1');
    expect(local.passwordHash).toBe('new-hash');
    expect(userRepo.updateById).toHaveBeenCalledWith(local);
  });

  it('resolveAuthSource', () => {
    expect(UserService.resolveAuthSource({ username: 'a', passwordHash: 'x' })).toBe('LOCAL');
    expect(UserService.resolveAuthSource({ username: 'a', feishuUserId: 'f' })).toBe('FEISHU');
    expect(UserService.resolveAuthSource({ username: 'a', externalProvider: 'ecp' })).toBe('ECP');
    expect(UserService.resolveAuthSource({ username: 'a', externalProvider: 'company_sso' })).toBe('COMPANY_SSO');
    expect(UserService.resolveAuthSource({ username: 'a', externalProvider: 'unknown_provider' })).toBe('LDAP');
    // 本地密码优先于外部绑定；已绑定外部身份的账号不再计入 LDAP。
    expect(UserService.resolveAuthSource({ username: 'a', passwordHash: 'x', externalProvider: 'ecp' })).toBe('LOCAL');
    expect(UserService.resolveAuthSource({ username: 'a', feishuUserId: 'f', externalProvider: 'ecp' })).toBe('ECP');
    expect(UserService.resolveAuthSource({ username: 'a', externalProvider: ' ' })).toBe('LDAP');
    expect(UserService.resolveAuthSource({ username: 'a' })).toBe('LDAP');
  });

  it('batchGetUserRoles delegates', async () => {
    const map = new Map<number, Role[]>();
    vi.mocked(permissionService.batchGetUserRoles).mockResolvedValue(map);
    await expect(service.batchGetUserRoles([1])).resolves.toBe(map);
  });
});

describe('UserService 邮箱变更通知钩子（V161 决策 2）', () => {
  function localService(listener?: (userId: number, email: string | null) => void) {
    const userRepo = {
      findById: vi.fn(),
      findByUsername: vi.fn(),
      countByUsername: vi.fn(),
      countByEmailExcept: vi.fn(async () => 0),
      insert: vi.fn(async (u) => { u.id = 11; return 11; }),
      updateById: vi.fn(),
      updateFields: vi.fn(),
      selectPage: vi.fn(),
      findEmailById: vi.fn(),
    } as unknown as UserRepository;
    const permissionService = {
      assignRoles: vi.fn(), changeRolesWithAdminGuard: vi.fn(), assertCanChangeRoles: vi.fn(),
      assertCanDisableUser: vi.fn(), updateUserStatusWithAdminGuard: vi.fn(),
      batchGetUserRoles: vi.fn(), getUserRoles: vi.fn(),
    } as unknown as PermissionService;
    const hasher: PasswordHasher = { hash: vi.fn(async () => 'hash'), matches: vi.fn() };
    const listenerSpy = listener ?? vi.fn();
    return { service: new UserService(userRepo, permissionService, hasher, listenerSpy), userRepo, listenerSpy };
  }

  it('自助改邮箱：实际变化后触发钩子（含改为空）', async () => {
    const { service, userRepo, listenerSpy } = localService();
    vi.mocked(userRepo.findById).mockResolvedValue(user(7, 'alice', 'Alice', 'old@example.test', 'hash', 1));
    await service.updateOwnProfile(7, null, 'new@example.test', null);
    expect(listenerSpy).toHaveBeenCalledWith(7, 'new@example.test');

    vi.mocked(userRepo.findById).mockResolvedValue(user(7, 'alice', 'Alice', 'new@example.test', 'hash', 1));
    await service.updateOwnProfile(7, null, '', null);
    expect(listenerSpy).toHaveBeenLastCalledWith(7, null);
  });

  it('自助未改邮箱（相同值）：不触发钩子', async () => {
    const { service, userRepo, listenerSpy } = localService();
    vi.mocked(userRepo.findById).mockResolvedValue(user(7, 'alice', 'Alice', 'same@example.test', 'hash', 1));
    await service.updateOwnProfile(7, null, 'same@example.test', null);
    expect(listenerSpy).not.toHaveBeenCalled();
  });

  it('未注入监听器时改邮箱不报错（兼容既有装配）', async () => {
    const userRepo = {
      findById: vi.fn(async () => user(7, 'alice', 'Alice', 'old@example.test', 'hash', 1)),
      findByUsername: vi.fn(), countByUsername: vi.fn(), countByEmailExcept: vi.fn(async () => 0),
      insert: vi.fn(), updateById: vi.fn(), updateFields: vi.fn(), selectPage: vi.fn(), findEmailById: vi.fn(),
    } as unknown as UserRepository;
    const permissionService = {
      assignRoles: vi.fn(), changeRolesWithAdminGuard: vi.fn(), assertCanChangeRoles: vi.fn(),
      assertCanDisableUser: vi.fn(), updateUserStatusWithAdminGuard: vi.fn(),
      batchGetUserRoles: vi.fn(), getUserRoles: vi.fn(),
    } as unknown as PermissionService;
    const hasher: PasswordHasher = { hash: vi.fn(), matches: vi.fn() };
    const service = new UserService(userRepo, permissionService, hasher);
    await expect(service.updateOwnProfile(7, null, 'new@example.test', null)).resolves.toBeUndefined();
  });

  it('管理端改邮箱：触发钩子；格式非法拒绝（垃圾地址不进密文）', async () => {
    const { service, userRepo, listenerSpy } = localService();
    vi.mocked(userRepo.findById).mockResolvedValue(user(7, 'alice', 'Alice', 'old@example.test', 'hash', 1));
    await service.updateUser(7, null, 'admin-set@example.test', null, null, 1);
    expect(listenerSpy).toHaveBeenCalledWith(7, 'admin-set@example.test');

    await expect(service.updateUser(7, null, 'not-an-email', null, null, 1)).rejects.toThrow(/邮箱格式不正确/);
    expect(listenerSpy).toHaveBeenCalledTimes(1);
  });

  it('管理端未改邮箱（email 入参为 null 占位以外无变化）：不触发钩子', async () => {
    const { service, userRepo, listenerSpy } = localService();
    vi.mocked(userRepo.findById).mockResolvedValue(user(7, 'alice', 'Alice', null, 'hash', 1));
    // email 入参为 null 表示「本次不修改邮箱」：不触发
    await service.updateUser(7, null, null, null, null, 1);
    expect(listenerSpy).not.toHaveBeenCalled();
  });
});
