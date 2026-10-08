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

/** 与登录一致：仅 status===0 停用。SSO/外部账号默认 status=null，仍可登录，必须计入活跃管理员。 */
export function isActiveAccount(status: number | null | undefined): boolean {
  return status !== 0;
}

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
    // 先删后插必须同事务：中途失败不得留下「已删未插」的半截状态
    if (this.rolePermissionRepo.transaction) {
      await this.rolePermissionRepo.transaction(async (tx) => {
        await tx.deleteByRoleId(roleId);
        for (const permId of permissionIds) {
          await tx.insert({ roleId, permissionId: permId });
        }
      });
      return;
    }
    await this.rolePermissionRepo.deleteByRoleId(roleId);
    for (const permId of permissionIds) {
      await this.rolePermissionRepo.insert({ roleId, permissionId: permId });
    }
  }

  async assignRoles(userId: number, roleIds: number[] | null | undefined): Promise<void> {
    if (roleIds == null || roleIds.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '至少分配一个角色');
    }
    // 先删后插必须同事务：中途失败不得留下「已删未插」的半截状态
    if (this.userRoleRepo.transaction) {
      await this.userRoleRepo.transaction(async (tx) => {
        await tx.deleteByUserId(userId);
        for (const roleId of roleIds) {
          await tx.insert({ userId, roleId });
        }
      });
      return;
    }
    await this.userRoleRepo.deleteByUserId(userId);
    for (const roleId of roleIds) {
      await this.userRoleRepo.insert({ userId, roleId });
    }
  }

  /**
   * 最后管理员保护 + 角色写入同一事务。
   * 对 ADMIN 绑定行 FOR UPDATE，避免并发双降级同时通过 count 检查后清空全部管理员。
   */
  async changeRolesWithAdminGuard(userId: number, newRoleIds: number[]): Promise<void> {
    if (newRoleIds.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '至少分配一个角色');
    }
    if (!this.userRoleRepo.transaction || !this.userRoleRepo.findByRoleIdForUpdate) {
      // 无事务能力时退化为「先断言再写」（与旧行为一致）
      await this.assertCanChangeRoles(userId, newRoleIds);
      await this.assignRoles(userId, newRoleIds);
      return;
    }
    await this.userRoleRepo.transaction(async (tx) => {
      const adminRole = await this.getAdminRole();
      if (adminRole && tx.findByRoleIdForUpdate) {
        // 锁定 ADMIN 全部绑定行：并发降级在此串行化
        const bindings = await tx.findByRoleIdForUpdate(adminRole.id!);
        const hadAdmin = bindings.some((b) => b.userId === userId);
        const willHaveAdmin = newRoleIds.includes(adminRole.id!);
        if (hadAdmin && !willHaveAdmin) {
          let otherActive = 0;
          for (const b of bindings) {
            if (b.userId === userId) continue;
            const u = await this.userRepo.findById(b.userId);
            if (u && isActiveAccount(u.status)) otherActive += 1;
          }
          if (otherActive === 0) {
            throw new BusinessException(ErrorCode.CANNOT_REMOVE_LAST_ADMIN);
          }
        }
      }
      await tx.deleteByUserId(userId);
      for (const roleId of newRoleIds) {
        await tx.insert({ userId, roleId });
      }
    });
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
    await this.assertNotLastAdmin(targetUserId);
  }

  /**
   * 最后管理员检查 + 用户状态写入同一事务（消除 TOCTOU）。
   * 旧的「只读守卫事务 + 事务外单独写 status」窗口内，并发禁用最后两名管理员的两个请求
   * 都会在守卫里看到对方仍活跃而双双通过，系统进入零管理员状态。
   * FOR UPDATE 锁定的绑定行必须在**同一事务**内完成状态写入才能串行化并发禁用。
   */
  async updateUserStatusWithAdminGuard(targetUserId: number, currentUserId: number, status: number | null): Promise<void> {
    // 仅「禁用自己」拒绝：启用/清空自身状态是合法自助操作（SSO/外部账号默认 status=null，
    // 管理员把自己从 null 改为 1 是可达路径），且错误码语义（不能禁用自己）只覆盖禁用
    if (targetUserId === currentUserId && status === 0) {
      throw new BusinessException(ErrorCode.CANNOT_DISABLE_SELF);
    }
    const adminRole = await this.getAdminRole();
    const targetIsAdmin = adminRole != null && (await this.userHasRole(targetUserId, adminRole.id!));
    if (!targetIsAdmin) {
      // 非管理员目标无最后管理员约束，直接写
      await this.userRepo.updateFields(targetUserId, { status });
      return;
    }
    if (!this.userRoleRepo.transaction || !this.userRoleRepo.findByRoleIdForUpdate || !this.userRoleRepo.updateUserStatus) {
      // 能力降级（测试桩/旧实现）：退回「守卫 + 事务外写」的旧语义
      await this.assertNotLastAdmin(targetUserId);
      await this.userRepo.updateFields(targetUserId, { status });
      return;
    }
    await this.userRoleRepo.transaction(async (tx) => {
      // 能力已在上方检查；Mysql 的 transaction() 传入的 tx 具备全部方法
      const bindings = await tx.findByRoleIdForUpdate!(adminRole!.id!);
      let otherActive = 0;
      for (const b of bindings) {
        if (b.userId === targetUserId) continue;
        const u = await this.userRepo.findById(b.userId);
        if (u && isActiveAccount(u.status)) otherActive += 1;
      }
      if (status === 0 && otherActive === 0) {
        throw new BusinessException(ErrorCode.CANNOT_REMOVE_LAST_ADMIN);
      }
      await tx.updateUserStatus!(targetUserId, status);
    });
  }

  /** 在事务内锁 ADMIN 绑定后检查目标是否为最后一名活跃管理员。 */
  private async assertNotLastAdmin(targetUserId: number): Promise<void> {
    const adminRole = await this.getAdminRole();
    if (!adminRole || !(await this.userHasRole(targetUserId, adminRole.id!))) {
      return;
    }
    if (!this.userRoleRepo.transaction || !this.userRoleRepo.findByRoleIdForUpdate) {
      if ((await this.countOtherActiveAdmins(adminRole.id!, targetUserId)) === 0) {
        throw new BusinessException(ErrorCode.CANNOT_REMOVE_LAST_ADMIN);
      }
      return;
    }
    await this.userRoleRepo.transaction(async (tx) => {
      if (!tx.findByRoleIdForUpdate) return;
      const bindings = await tx.findByRoleIdForUpdate(adminRole.id!);
      let otherActive = 0;
      for (const b of bindings) {
        if (b.userId === targetUserId) continue;
        const u = await this.userRepo.findById(b.userId);
        if (u && isActiveAccount(u.status)) otherActive += 1;
      }
      if (otherActive === 0) {
        throw new BusinessException(ErrorCode.CANNOT_REMOVE_LAST_ADMIN);
      }
    });
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
      if (user && isActiveAccount(user.status)) {
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
