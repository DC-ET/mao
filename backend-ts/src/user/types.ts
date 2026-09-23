export interface User {
  id?: number;
  username: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  passwordHash?: string | null;
  feishuUserId?: string | null;
  /** 由 user_external_identity 带出（只读，不落 user 表），用于判定外部登录来源。 */
  externalProvider?: string | null;
  status?: number | null;
  lastLoginAt?: string | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Role {
  id?: number;
  name: string;
  code: string;
  description?: string | null;
  deleted?: number;
}

export interface Permission {
  id?: number;
  name: string;
  code: string;
  description?: string | null;
}

export interface UserRole {
  id?: number;
  userId: number;
  roleId: number;
}

export interface RolePermission {
  id?: number;
  roleId: number;
  permissionId: number;
}

import type { UserInfoVO, LoginVO } from '@mao/contracts';
export type { UserInfoVO, LoginVO };

export interface PasswordHasher {
  hash(raw: string): Promise<string>;
  matches(raw: string, hash: string): Promise<boolean>;
}

export interface UserRepository {
  findById(id: number): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  findByEmail?(email: string): Promise<User | null>;
  findByFeishuUserId?(feishuUserId: string): Promise<User | null>;
  countByUsername(username: string): Promise<number>;
  countByEmailExcept(email: string, userId: number): Promise<number>;
  insert(user: User): Promise<number>;
  updateById(user: User): Promise<void>;
  updateFields(id: number, fields: Record<string, unknown>): Promise<void>;
  selectPage(page: number, size: number, keyword?: string, status?: number | null, authSource?: string | null): Promise<{ records: User[]; total: number }>;
}

export interface RoleRepository {
  findById(id: number): Promise<Role | null>;
  findByCode(code: string): Promise<Role | null>;
  findAll(): Promise<Role[]>;
  findByIds(ids: number[]): Promise<Role[]>;
  insert(role: Role): Promise<number>;
  updateById(role: Role): Promise<void>;
}

export interface PermissionRepository {
  findAll(): Promise<Permission[]>;
  findByIds(ids: number[]): Promise<Permission[]>;
  countByIdsAndCode(ids: number[], code: string): Promise<number>;
}

export interface UserRoleRepository {
  findByUserId(userId: number): Promise<UserRole[]>;
  findByUserIds(userIds: number[]): Promise<UserRole[]>;
  findByRoleId(roleId: number): Promise<UserRole[]>;
  /** FOR UPDATE 锁定某角色全部绑定行（Mysql 实现提供）。 */
  findByRoleIdForUpdate?(roleId: number): Promise<UserRole[]>;
  countByRoleId(roleId: number): Promise<number>;
  countByUserAndRole(userId: number, roleId: number): Promise<number>;
  deleteByUserId(userId: number): Promise<void>;
  insert(row: UserRole): Promise<void>;
  /** 可选：在事务中执行先删后插（Mysql 实现提供）。 */
  transaction?<T>(fn: (tx: UserRoleRepository) => Promise<T>): Promise<T>;
}

export interface RolePermissionRepository {
  findByRoleId(roleId: number): Promise<RolePermission[]>;
  findByRoleIds(roleIds: number[]): Promise<RolePermission[]>;
  deleteByRoleId(roleId: number): Promise<void>;
  insert(row: RolePermission): Promise<void>;
  /** 可选：在事务中执行先删后插（Mysql 实现提供）。 */
  transaction?<T>(fn: (tx: RolePermissionRepository) => Promise<T>): Promise<T>;
}
