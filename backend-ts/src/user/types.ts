export interface User {
  id?: number;
  username: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  passwordHash?: string | null;
  feishuUserId?: string | null;
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

export interface UserInfoVO {
  id?: number;
  username?: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  authSource?: string;
  permissions?: string[];
  isAdmin?: boolean;
}

export interface LoginVO {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: UserInfoVO;
}

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
  selectPage(page: number, size: number, keyword?: string, status?: number | null): Promise<{ records: User[]; total: number }>;
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
  countByRoleId(roleId: number): Promise<number>;
  countByUserAndRole(userId: number, roleId: number): Promise<number>;
  deleteByUserId(userId: number): Promise<void>;
  insert(row: UserRole): Promise<void>;
}

export interface RolePermissionRepository {
  findByRoleId(roleId: number): Promise<RolePermission[]>;
  findByRoleIds(roleIds: number[]): Promise<RolePermission[]>;
  deleteByRoleId(roleId: number): Promise<void>;
  insert(row: RolePermission): Promise<void>;
}
