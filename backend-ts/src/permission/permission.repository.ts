import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type {
  Permission,
  PermissionRepository,
  Role,
  RolePermission,
  RolePermissionRepository,
  RoleRepository,
  UserRole,
  UserRoleRepository,
} from '../user/types.js';

export class MysqlRoleRepository implements RoleRepository {
  constructor(private readonly db: Db) {}

  findById(id: number): Promise<Role | null> {
    return this.db.queryOne<Role>(`SELECT * FROM role WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  findByCode(code: string): Promise<Role | null> {
    return this.db.queryOne<Role>(`SELECT * FROM role WHERE code = ? AND ${notDeleted()}`, [code]);
  }

  findAll(): Promise<Role[]> {
    return this.db.query<Role>(`SELECT * FROM role WHERE ${notDeleted()}`);
  }

  findByIds(ids: number[]): Promise<Role[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    const ph = ids.map(() => '?').join(',');
    return this.db.query<Role>(`SELECT * FROM role WHERE id IN (${ph}) AND ${notDeleted()}`, ids);
  }

  async insert(role: Role): Promise<number> {
    return this.db.insert('role', {
      name: role.name,
      code: role.code,
      description: role.description,
      deleted: 0,
    });
  }

  async updateById(role: Role): Promise<void> {
    if (role.id == null) {
      return;
    }
    await this.db.updateById('role', role.id, {
      name: role.name,
      code: role.code,
      description: role.description,
    });
  }
}

export class MysqlPermissionRepository implements PermissionRepository {
  constructor(private readonly db: Db) {}

  findAll(): Promise<Permission[]> {
    return this.db.query<Permission>('SELECT * FROM permission');
  }

  findByIds(ids: number[]): Promise<Permission[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    const ph = ids.map(() => '?').join(',');
    return this.db.query<Permission>(`SELECT * FROM permission WHERE id IN (${ph})`, ids);
  }

  async countByIdsAndCode(ids: number[], code: string): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const ph = ids.map(() => '?').join(',');
    const row = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM permission WHERE id IN (${ph}) AND code = ?`,
      [...ids, code],
    );
    return Number(row?.cnt ?? 0);
  }
}

export class MysqlUserRoleRepository implements UserRoleRepository {
  constructor(private readonly db: Db) {}

  findByUserId(userId: number): Promise<UserRole[]> {
    return this.db.query<UserRole>('SELECT * FROM user_role WHERE user_id = ?', [userId]);
  }

  findByUserIds(userIds: number[]): Promise<UserRole[]> {
    if (userIds.length === 0) {
      return Promise.resolve([]);
    }
    const ph = userIds.map(() => '?').join(',');
    return this.db.query<UserRole>(`SELECT * FROM user_role WHERE user_id IN (${ph})`, userIds);
  }

  findByRoleId(roleId: number): Promise<UserRole[]> {
    return this.db.query<UserRole>('SELECT * FROM user_role WHERE role_id = ?', [roleId]);
  }

  async countByRoleId(roleId: number): Promise<number> {
    const row = await this.db.queryOne<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM user_role WHERE role_id = ?',
      [roleId],
    );
    return Number(row?.cnt ?? 0);
  }

  async countByUserAndRole(userId: number, roleId: number): Promise<number> {
    const row = await this.db.queryOne<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM user_role WHERE user_id = ? AND role_id = ?',
      [userId, roleId],
    );
    return Number(row?.cnt ?? 0);
  }

  async deleteByUserId(userId: number): Promise<void> {
    await this.db.execute('DELETE FROM user_role WHERE user_id = ?', [userId]);
  }

  async insert(row: UserRole): Promise<void> {
    await this.db.insert('user_role', { userId: row.userId, roleId: row.roleId });
  }
}

export class MysqlRolePermissionRepository implements RolePermissionRepository {
  constructor(private readonly db: Db) {}

  findByRoleId(roleId: number): Promise<RolePermission[]> {
    return this.db.query<RolePermission>('SELECT * FROM role_permission WHERE role_id = ?', [roleId]);
  }

  findByRoleIds(roleIds: number[]): Promise<RolePermission[]> {
    if (roleIds.length === 0) {
      return Promise.resolve([]);
    }
    const ph = roleIds.map(() => '?').join(',');
    return this.db.query<RolePermission>(`SELECT * FROM role_permission WHERE role_id IN (${ph})`, roleIds);
  }

  async deleteByRoleId(roleId: number): Promise<void> {
    await this.db.execute('DELETE FROM role_permission WHERE role_id = ?', [roleId]);
  }

  async insert(row: RolePermission): Promise<void> {
    await this.db.insert('role_permission', { roleId: row.roleId, permissionId: row.permissionId });
  }
}
