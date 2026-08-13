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
    countByRoleId: vi.fn(),
    countByUserAndRole: vi.fn(),
    deleteByUserId: vi.fn(),
    insert: vi.fn(),
  } as unknown as UserRoleRepository;
  const userRepo = {
    findById: vi.fn(),
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

    await expect(service.assertCanDisableUser(10, 10)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.assertCanDisableUser(10, 99)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.assertCanChangeRoles(10, [2])).rejects.toBeInstanceOf(BusinessException);

    vi.mocked(userRoleRepo.findByRoleId).mockResolvedValue([userRole(10, 1), userRole(20, 1)]);
    vi.mocked(userRepo.findById).mockResolvedValue({ id: 20, username: 'a', status: 1 });
    await service.assertCanDisableUser(10, 99);
    await service.assertCanChangeRoles(10, [2]);
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
});
