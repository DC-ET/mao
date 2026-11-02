import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { PermissionService } from './permission.service.js';
import type {
  PermissionRepository,
  RoleRepository,
  RolePermissionRepository,
  UserRepository,
  UserRoleRepository,
  Role,
  Permission,
  UserRole,
} from '../user/types.js';

function role(id: number, name: string, code: string): Role {
  return { id, name, code };
}
function permission(id: number, code: string): Permission {
  return { id, name: code, code };
}
function userRole(userId: number, roleId: number): UserRole {
  return { userId, roleId };
}

describe('PermissionService', () => {
  const roleRepo = {
    findById: vi.fn(),
    findByCode: vi.fn(),
    findAll: vi.fn(),
    findByIds: vi.fn(),
    insert: vi.fn(async () => 3),
    updateById: vi.fn(),
  } as unknown as RoleRepository;
  const permissionRepo = {
    findAll: vi.fn(),
    findByIds: vi.fn(),
    countByIdsAndCode: vi.fn(),
  } as unknown as PermissionRepository;
  const rolePermissionRepo = {
    findByRoleId: vi.fn(),
    findByRoleIds: vi.fn(),
    deleteByRoleId: vi.fn(),
    insert: vi.fn(),
  } as unknown as RolePermissionRepository;
  const userRoleRepo = {
    findByUserId: vi.fn(),
    findByUserIds: vi.fn(),
    findByRoleId: vi.fn(),
    findByRoleIdForUpdate: vi.fn(),
    countByRoleId: vi.fn(),
    countByUserAndRole: vi.fn(),
    deleteByUserId: vi.fn(),
    deleteByUserAndRole: vi.fn(),
    insert: vi.fn(),
    updateUserStatus: vi.fn(),
    // 默认实现：直接以桩自身作为 tx 执行回调，保持 assignRoles 等既有路径语义
    transaction: vi.fn(async (fn: (tx: UserRoleRepository) => Promise<unknown>) => fn(userRoleRepo)),
  } as unknown as UserRoleRepository;
  const userRepo = {
    findById: vi.fn(),
    findByIds: vi.fn(),
    updateFields: vi.fn(),
  } as unknown as UserRepository;

  const service = new PermissionService(roleRepo, permissionRepo, rolePermissionRepo, userRoleRepo, userRepo);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('roleAndPermissionCrudDelegatesToMappers', async () => {
    const admin = role(1, 'Admin', 'ADMIN');
    const perm = permission(2, 'user:read');
    vi.mocked(roleRepo.findAll).mockResolvedValue([admin]);
    vi.mocked(roleRepo.findById).mockResolvedValue(admin);
    vi.mocked(permissionRepo.findAll).mockResolvedValue([perm]);

    expect(await service.listRoles()).toEqual([admin]);
    expect(await service.getRole(1)).toBe(admin);
    expect(await service.listPermissions()).toEqual([perm]);

    const created = await service.createRole('Operator', 'OP', 'desc');
    expect(created.code).toBe('OP');
    expect(roleRepo.insert).toHaveBeenCalled();

    const updated = await service.updateRole(1, 'Root', 'new');
    expect(updated?.name).toBe('Root');
    expect(updated?.description).toBe('new');

    vi.mocked(roleRepo.findById).mockResolvedValue(null);
    expect(await service.updateRole(99, 'x', 'x')).toBeNull();
  });

  it('assignPermissionsAndRolesReplaceExistingBindings', async () => {
    await service.assignPermissions(1, [10, 11]);
    expect(rolePermissionRepo.deleteByRoleId).toHaveBeenCalledWith(1);
    expect(rolePermissionRepo.insert).toHaveBeenCalledTimes(2);

    await service.assignRoles(2, [1, 3]);
    expect(userRoleRepo.deleteByUserId).toHaveBeenCalledWith(2);
    expect(userRoleRepo.insert).toHaveBeenCalledTimes(2);

    await expect(service.assignRoles(2, [])).rejects.toBeInstanceOf(BusinessException);
  });

  it('userRoleLookupHandlesEmptyAndPopulatedBindings', async () => {
    vi.mocked(userRoleRepo.findByUserId).mockResolvedValue([userRole(7, 1), userRole(7, 2)]);
    vi.mocked(roleRepo.findByIds).mockResolvedValue([role(1, 'Admin', 'ADMIN')]);
    expect(await service.getUserRoleIds(7)).toEqual([1, 2]);
    expect((await service.getUserRoles(7)).map((r) => r.name)).toEqual(['Admin']);
    expect(await service.batchGetUserRoles(null)).toEqual(new Map());
    expect(await service.batchGetUserRoles([])).toEqual(new Map());
  });

  it('batchGetUserRolesGroupsKnownRolesByUser', async () => {
    vi.mocked(userRoleRepo.findByUserIds).mockResolvedValue([userRole(7, 1), userRole(8, 2)]);
    vi.mocked(roleRepo.findByIds).mockResolvedValue([role(1, 'Admin', 'ADMIN'), role(2, 'User', 'USER')]);
    const roles = await service.batchGetUserRoles([7, 8]);
    expect([...roles.keys()].sort()).toEqual([7, 8]);
    expect(roles.get(7)?.[0].code).toBe('ADMIN');
    expect(roles.get(8)?.[0].code).toBe('USER');
  });

  it('disableAndRoleChangeRulesProtectLastAdmin', async () => {
    const admin = role(1, 'Admin', 'ADMIN');
    vi.mocked(roleRepo.findByCode).mockResolvedValue(admin);
    vi.mocked(userRoleRepo.countByUserAndRole).mockResolvedValue(1);
    vi.mocked(userRoleRepo.findByRoleId).mockResolvedValue([userRole(10, 1)]);
    // 桩具备事务能力后，assertNotLastAdmin 走 FOR UPDATE 事务路径，数据与 findByRoleId 同源
    vi.mocked(userRoleRepo.findByRoleIdForUpdate!).mockResolvedValue([userRole(10, 1)]);

    await expect(service.assertCanDisableUser(10, 10)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.assertCanDisableUser(10, 99)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.assertCanChangeRoles(10, [2])).rejects.toBeInstanceOf(BusinessException);

    vi.mocked(userRoleRepo.findByRoleId).mockResolvedValue([userRole(10, 1), userRole(20, 1)]);
    vi.mocked(userRoleRepo.findByRoleIdForUpdate!).mockResolvedValue([userRole(10, 1), userRole(20, 1)]);
    vi.mocked(userRepo.findById).mockResolvedValue({ id: 20, username: 'a', status: 1 });
    await service.assertCanDisableUser(10, 99);
    await service.assertCanChangeRoles(10, [2]);
  });

  it('status=null 的其他管理员仍算活跃，允许降级 status=1 的管理员', async () => {
    const admin = role(1, 'Admin', 'ADMIN');
    vi.mocked(roleRepo.findByCode).mockResolvedValue(admin);
    vi.mocked(userRoleRepo.countByUserAndRole).mockResolvedValue(1);
    vi.mocked(userRoleRepo.findByRoleId).mockResolvedValue([userRole(10, 1), userRole(20, 1)]);
    vi.mocked(userRepo.findById).mockImplementation(async (id: number) => ({ id, username: 'a', status: id === 20 ? null : 1 }));
    await expect(service.assertCanChangeRoles(10, [2])).resolves.toBeUndefined();
  });

  it('permissionChecksReturnFalseForMissingBindingsAndTrueForMatchingCode', async () => {
    vi.mocked(userRoleRepo.findByUserId).mockResolvedValue([]);
    expect(await service.hasPermission(1, 'user:read')).toBe(false);
    expect(await service.getUserPermissionCodes(1)).toEqual([]);

    vi.mocked(userRoleRepo.findByUserId).mockResolvedValue([userRole(1, 2)]);
    vi.mocked(rolePermissionRepo.findByRoleIds).mockResolvedValue([{ roleId: 2, permissionId: 10 }]);
    vi.mocked(permissionRepo.countByIdsAndCode).mockResolvedValue(1);
    vi.mocked(permissionRepo.findByIds).mockResolvedValue([permission(10, 'user:read')]);
    expect(await service.hasPermission(1, 'user:read')).toBe(true);
    expect(await service.getUserPermissionCodes(1)).toEqual(['user:read']);
  });

  it('noAdminRoleMeansProtectionChecksAreNoops', async () => {
    vi.mocked(roleRepo.findByCode).mockResolvedValue(null);
    await service.assertCanDisableUser(1, 2);
    await service.assertCanChangeRoles(1, []);
    expect(userRoleRepo.countByUserAndRole).not.toHaveBeenCalled();
  });

  it('isAdmin', async () => {
    expect(await service.isAdmin(null)).toBe(false);
    vi.mocked(roleRepo.findByCode).mockResolvedValue(role(1, 'Admin', 'ADMIN'));
    vi.mocked(userRoleRepo.countByUserAndRole).mockResolvedValue(1);
    expect(await service.isAdmin(1)).toBe(true);
  });

  it('updateUserStatusWithAdminGuard writes status inside the guard transaction', async () => {
    const admin = role(1, 'Admin', 'ADMIN');
    vi.mocked(roleRepo.findByCode).mockResolvedValue(admin);
    vi.mocked(userRoleRepo.countByUserAndRole).mockResolvedValue(1);
    // FOR UPDATE 绑定里另一名管理员仍活跃 → 放行，且 status 写入发生在同一事务回调内
    vi.mocked(userRoleRepo.findByRoleIdForUpdate!).mockResolvedValue([userRole(10, 1), userRole(20, 1)]);
    vi.mocked(userRepo.findById).mockResolvedValue({ id: 20, username: 'a', displayName: 'A', status: 1 });
    vi.mocked(userRoleRepo.transaction!).mockImplementation(async (fn) => fn(userRoleRepo));

    await service.updateUserStatusWithAdminGuard(10, 99, 0);

    expect(vi.mocked(userRoleRepo.findByRoleIdForUpdate).mock.calls[0]).toEqual([1]);
    expect(userRoleRepo.updateUserStatus).toHaveBeenCalledWith(10, 0);
  });

  it('updateUserStatusWithAdminGuard rejects disabling the last admin before the write', async () => {
    const admin = role(1, 'Admin', 'ADMIN');
    vi.mocked(roleRepo.findByCode).mockResolvedValue(admin);
    vi.mocked(userRoleRepo.countByUserAndRole).mockResolvedValue(1);
    // 绑定里只剩目标本人 → 最后管理员保护在事务内拒绝，status 不得落库
    vi.mocked(userRoleRepo.findByRoleIdForUpdate!).mockResolvedValue([userRole(10, 1)]);
    vi.mocked(userRoleRepo.transaction!).mockImplementation(async (fn) => fn(userRoleRepo));

    await expect(service.updateUserStatusWithAdminGuard(10, 99, 0)).rejects.toBeInstanceOf(BusinessException);
    expect(userRoleRepo.updateUserStatus).not.toHaveBeenCalled();
  });

  it('updateUserStatusWithAdminGuard rejects self-disable and passes through non-admin targets', async () => {
    await expect(service.updateUserStatusWithAdminGuard(10, 10, 0)).rejects.toBeInstanceOf(BusinessException);

    const admin = role(1, 'Admin', 'ADMIN');
    vi.mocked(roleRepo.findByCode).mockResolvedValue(admin);
    // 目标不是管理员：无最后管理员约束，直接经 userRepo.updateFields 写入
    vi.mocked(userRoleRepo.countByUserAndRole).mockResolvedValue(0);
    await service.updateUserStatusWithAdminGuard(20, 99, 1);
    expect(userRepo.updateFields).toHaveBeenCalledWith(20, { status: 1 });
  });

  it('updateUserStatusWithAdminGuard only rejects disabling self, not enabling or clearing own status', async () => {
    // 自助启用/清空自身状态是合法操作（SSO/外部账号默认 status=null，登录侧允许）；
    // 自检只覆盖禁用，错误码「不能禁用当前登录用户」的语义也仅与禁用匹配。
    const admin = role(1, 'Admin', 'ADMIN');
    vi.mocked(roleRepo.findByCode).mockResolvedValue(admin);
    vi.mocked(userRoleRepo.countByUserAndRole).mockResolvedValue(0);

    await service.updateUserStatusWithAdminGuard(10, 10, 1);
    expect(userRepo.updateFields).toHaveBeenCalledWith(10, { status: 1 });

    await service.updateUserStatusWithAdminGuard(10, 10, null);
    expect(userRepo.updateFields).toHaveBeenCalledWith(10, { status: null });

    // 禁用自己仍然拒绝，不会因上面放行自助写入而被绕过
    await expect(service.updateUserStatusWithAdminGuard(10, 10, 0)).rejects.toBeInstanceOf(BusinessException);
    expect(userRepo.updateFields).toHaveBeenCalledTimes(2);
  });

  describe('addRoleUsers', () => {
    it('rejects empty, malformed, oversized and duplicated ids', async () => {
      vi.mocked(roleRepo.findById).mockResolvedValue(role(3, 'Ops', 'OPS'));
      await expect(service.addRoleUsers(3, [])).rejects.toMatchObject({ code: 2001 });
      await expect(service.addRoleUsers(3, [0, -1])).rejects.toMatchObject({ code: 2001 });
      await expect(service.addRoleUsers(3, [1.5])).rejects.toMatchObject({ code: 2001 });
      const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
      await expect(service.addRoleUsers(3, tooMany)).rejects.toMatchObject({ code: 2001 });
      expect(userRoleRepo.transaction).not.toHaveBeenCalled();
    });

    it('rejects unknown role and missing users', async () => {
      vi.mocked(roleRepo.findById).mockResolvedValue(null);
      await expect(service.addRoleUsers(99, [1])).rejects.toMatchObject({ code: 3054 });
      expect(userRepo.findByIds).not.toHaveBeenCalled();

      vi.mocked(roleRepo.findById).mockResolvedValue(role(3, 'Ops', 'OPS'));
      // 去重后 3 个 id，只查到 2 个用户 → 整体拒绝，不落任何绑定
      vi.mocked(userRepo.findByIds).mockResolvedValue([
        { id: 1, username: 'a' },
        { id: 2, username: 'b' },
      ]);
      await expect(service.addRoleUsers(3, [1, 2, 3, 1])).rejects.toMatchObject({ code: 3014 });
      expect(userRoleRepo.insert).not.toHaveBeenCalled();
    });

    it('inserts only unbound users inside a transaction and is idempotent', async () => {
      vi.mocked(roleRepo.findById).mockResolvedValue(role(3, 'Ops', 'OPS'));
      vi.mocked(userRepo.findByIds).mockResolvedValue([
        { id: 1, username: 'a' },
        { id: 2, username: 'b' },
        { id: 3, username: 'c' },
      ]);
      // 用户 2 已在该角色下：重复添加跳过，不报错
      vi.mocked(userRoleRepo.findByUserIds).mockResolvedValue([userRole(2, 3), userRole(2, 1)]);

      const result = await service.addRoleUsers(3, [1, 2, 3]);

      expect(result).toEqual({ added: 2 });
      expect(userRoleRepo.transaction).toHaveBeenCalled();
      expect(userRoleRepo.insert).toHaveBeenCalledTimes(2);
      expect(userRoleRepo.insert).toHaveBeenCalledWith({ userId: 1, roleId: 3 });
      expect(userRoleRepo.insert).toHaveBeenCalledWith({ userId: 3, roleId: 3 });

      // 全部已绑定时 added 为 0，依旧不报错
      vi.mocked(userRoleRepo.findByUserIds).mockResolvedValue([userRole(1, 3), userRole(2, 3), userRole(3, 3)]);
      expect(await service.addRoleUsers(3, [1, 2, 3])).toEqual({ added: 0 });
      expect(userRoleRepo.insert).toHaveBeenCalledTimes(2);
    });
  });

  describe('removeRoleUsers', () => {
    it('rejects empty, malformed ids and unknown role', async () => {
      await expect(service.removeRoleUsers(3, [])).rejects.toMatchObject({ code: 2001 });
      await expect(service.removeRoleUsers(3, ['x' as unknown as number])).rejects.toMatchObject({ code: 2001 });
      vi.mocked(roleRepo.findById).mockResolvedValue(null);
      await expect(service.removeRoleUsers(99, [1])).rejects.toMatchObject({ code: 3054 });
      expect(userRoleRepo.findByRoleIdForUpdate).not.toHaveBeenCalled();
    });

    it('removes only bound users, skips the rest and is idempotent', async () => {
      vi.mocked(roleRepo.findById).mockResolvedValue(role(3, 'Ops', 'OPS'));
      vi.mocked(roleRepo.findByCode).mockResolvedValue(null);
      // 10/11 已绑定、12 未绑定：只删交集
      vi.mocked(userRoleRepo.findByRoleIdForUpdate!).mockResolvedValue([userRole(10, 3), userRole(11, 3)]);
      const result = await service.removeRoleUsers(3, [10, 11, 12]);

      expect(result).toEqual({ removed: 2 });
      expect(userRoleRepo.deleteByUserAndRole).toHaveBeenCalledTimes(2);
      expect(userRoleRepo.deleteByUserAndRole).toHaveBeenCalledWith(10, 3);
      expect(userRoleRepo.deleteByUserAndRole).toHaveBeenCalledWith(11, 3);

      // 再次移除同一批：绑定已不存在，removed 为 0 且不删
      vi.mocked(userRoleRepo.findByRoleIdForUpdate!).mockResolvedValue([]);
      expect(await service.removeRoleUsers(3, [10, 11])).toEqual({ removed: 0 });
      expect(userRoleRepo.deleteByUserAndRole).toHaveBeenCalledTimes(2);
    });

    it('protects the last admin when removing members from the ADMIN role', async () => {
      const admin = role(1, 'Admin', 'ADMIN');
      vi.mocked(roleRepo.findById).mockResolvedValue(admin);
      vi.mocked(roleRepo.findByCode).mockResolvedValue(admin);
      vi.mocked(userRoleRepo.findByRoleIdForUpdate!).mockResolvedValue([userRole(10, 1)]);
      vi.mocked(userRepo.findById).mockResolvedValue({ id: 10, username: 'a', status: 1 });

      await expect(service.removeRoleUsers(1, [10])).rejects.toMatchObject({ code: 3017 });
      expect(userRoleRepo.deleteByUserAndRole).not.toHaveBeenCalled();

      // 还有另一名活跃管理员时放行；status=null 的外部账号同样算活跃
      vi.mocked(userRoleRepo.findByRoleIdForUpdate!).mockResolvedValue([userRole(10, 1), userRole(20, 1)]);
      vi.mocked(userRepo.findById).mockImplementation(async (id: number) => ({ id, username: 'a', status: id === 20 ? null : 1 }));
      expect(await service.removeRoleUsers(1, [10])).toEqual({ removed: 1 });
      expect(userRoleRepo.deleteByUserAndRole).toHaveBeenCalledWith(10, 1);
    });

    it('does not consult the last-admin guard for non-ADMIN roles', async () => {
      vi.mocked(roleRepo.findById).mockResolvedValue(role(3, 'Ops', 'OPS'));
      vi.mocked(roleRepo.findByCode).mockResolvedValue(null);
      vi.mocked(userRoleRepo.findByRoleIdForUpdate!).mockResolvedValue([userRole(10, 3)]);
      // 不桩 userRepo.findById：若误走管理员守卫会因 findById 返回 undefined 走进分支
      expect(await service.removeRoleUsers(3, [10])).toEqual({ removed: 1 });
      expect(userRoleRepo.deleteByUserAndRole).toHaveBeenCalledWith(10, 3);
    });
  });
});
