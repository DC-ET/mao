import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type {
  Permission,
  PermissionRepository,
  Role,
  RolePermissionRepository,
  RoleRepository,
  UserRepository,
  UserRole,
  UserRoleRepository,
} from '../user/types.js';

export class PermissionService {
  constructor(
    private readonly roleRepo: RoleRepository,
    private readonly permissionRepo: PermissionRepository,
    private readonly rolePermissionRepo: RolePermissionRepository,
    private readonly userRoleRepo: UserRoleRepository,
    private readonly userRepo: UserRepository,
  ) {}

  listRoles(): Promise<Role[]> {
    return this.roleRepo.findAll();
  }

  getRole(id: number): Promise<Role | null> {
    return this.roleRepo.findById(id);
  }

  async createRole(name: string, code: string, description?: string | null): Promise<Role> {
    const role: Role = { name, code, description };
    const id = await this.roleRepo.insert(role);
    role.id = id;
    return role;
  }

  async updateRole(id: number, name?: string | null, description?: string | null): Promise<Role | null> {
    const role = await this.roleRepo.findById(id);
    if (!role) {
      return null;
    }
    if (name != null) {
      role.name = name;
    }
    if (description != null) {
      role.description = description;
    }
    await this.roleRepo.updateById(role);
    return role;
  }

  listPermissions(): Promise<Permission[]> {
    return this.permissionRepo.findAll();
  }

  async getRolePermissionIds(roleId: number): Promise<number[]> {
    const rows = await this.rolePermissionRepo.findByRoleId(roleId);
    return rows.map((r) => r.permissionId);
  }

  countRoleUsers(roleId: number): Promise<number> {
    return this.userRoleRepo.countByRoleId(roleId);
  }

  async assignPermissions(roleId: number, permissionIds: number[]): Promise<void> {
    await this.rolePermissionRepo.deleteByRoleId(roleId);
    for (const permId of permissionIds) {
      await this.rolePermissionRepo.insert({ roleId, permissionId: permId });
    }
  }

  async assignRoles(userId: number, roleIds: number[] | null | undefined): Promise<void> {
    if (roleIds == null || roleIds.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '至少分配一个角色');
    }
    await this.userRoleRepo.deleteByUserId(userId);
    for (const roleId of roleIds) {
      await this.userRoleRepo.insert({ userId, roleId });
    }
  }

  async getUserRoleIds(userId: number): Promise<number[]> {
    const rows = await this.userRoleRepo.findByUserId(userId);
    return rows.map((r) => r.roleId);
  }

  async getUserRoles(userId: number): Promise<Role[]> {
    const roleIds = await this.getUserRoleIds(userId);
    if (roleIds.length === 0) {
      return [];
    }
    return this.roleRepo.findByIds(roleIds);
  }

  async batchGetUserRoles(userIds: number[] | null | undefined): Promise<Map<number, Role[]>> {
    const result = new Map<number, Role[]>();
    if (userIds == null || userIds.length === 0) {
      return result;
    }
    const userRoles = await this.userRoleRepo.findByUserIds(userIds);
    if (userRoles.length === 0) {
      return result;
    }
    const roleIds = [...new Set(userRoles.map((ur) => ur.roleId))];
    const roles = await this.roleRepo.findByIds(roleIds);
    const roleMap = new Map(roles.map((r) => [r.id!, r]));
    for (const ur of userRoles) {
      const role = roleMap.get(ur.roleId);
      if (role) {
        const list = result.get(ur.userId) ?? [];
        list.push(role);
        result.set(ur.userId, list);
      }
    }
    return result;
  }

  async assertCanDisableUser(targetUserId: number, currentUserId: number): Promise<void> {
    if (targetUserId === currentUserId) {
      throw new BusinessException(ErrorCode.CANNOT_DISABLE_SELF);
    }
    const adminRole = await this.getAdminRole();
    if (!adminRole || !(await this.userHasRole(targetUserId, adminRole.id!))) {
      return;
    }
    if ((await this.countOtherActiveAdmins(adminRole.id!, targetUserId)) === 0) {
      throw new BusinessException(ErrorCode.CANNOT_REMOVE_LAST_ADMIN);
    }
  }

  async assertCanChangeRoles(userId: number, newRoleIds: number[]): Promise<void> {
    const adminRole = await this.getAdminRole();
    if (!adminRole) {
      return;
    }
    const hadAdmin = await this.userHasRole(userId, adminRole.id!);
    const willHaveAdmin = newRoleIds.includes(adminRole.id!);
    if (hadAdmin && !willHaveAdmin && (await this.countOtherActiveAdmins(adminRole.id!, userId)) === 0) {
      throw new BusinessException(ErrorCode.CANNOT_REMOVE_LAST_ADMIN);
    }
  }

  private getAdminRole(): Promise<Role | null> {
    return this.roleRepo.findByCode('ADMIN');
  }

  async userHasRole(userId: number, roleId: number): Promise<boolean> {
    return (await this.userRoleRepo.countByUserAndRole(userId, roleId)) > 0;
  }

  private async countOtherActiveAdmins(adminRoleId: number, excludeUserId: number): Promise<number> {
    const bindings = await this.userRoleRepo.findByRoleId(adminRoleId);
    let count = 0;
    for (const b of bindings) {
      if (b.userId === excludeUserId) {
        continue;
      }
      const user = await this.userRepo.findById(b.userId);
      if (user && user.status === 1) {
        count += 1;
      }
    }
    return count;
  }

  async isAdmin(userId: number | null | undefined): Promise<boolean> {
    if (userId == null) {
      return false;
    }
    const adminRole = await this.getAdminRole();
    return adminRole != null && (await this.userHasRole(userId, adminRole.id!));
  }

  async hasPermission(userId: number, permissionCode: string): Promise<boolean> {
    const userRoles = await this.userRoleRepo.findByUserId(userId);
    if (userRoles.length === 0) {
      return false;
    }
    const roleIds = userRoles.map((r) => r.roleId);
    const rolePerms = await this.rolePermissionRepo.findByRoleIds(roleIds);
    if (rolePerms.length === 0) {
      return false;
    }
    const permIds = rolePerms.map((p) => p.permissionId);
    const count = await this.permissionRepo.countByIdsAndCode(permIds, permissionCode);
    return count > 0;
  }

  async getUserPermissionCodes(userId: number): Promise<string[]> {
    const userRoles = await this.userRoleRepo.findByUserId(userId);
    if (userRoles.length === 0) {
      return [];
    }
    const roleIds = userRoles.map((r) => r.roleId);
    const rolePerms = await this.rolePermissionRepo.findByRoleIds(roleIds);
    if (rolePerms.length === 0) {
      return [];
    }
    const permIds = rolePerms.map((p) => p.permissionId);
    const permissions = await this.permissionRepo.findByIds(permIds);
    return permissions.map((p) => p.code);
  }
}
