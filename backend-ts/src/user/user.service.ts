import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { mpPage, type MpPage } from '../common/json.js';
import { hasText } from '../common/case.js';
import type { PermissionService } from '../permission/permission.service.js';
import type { PasswordHasher, Role, User, UserRepository } from './types.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,64}$/;
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/;
const EMAIL_PATTERN = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const AVATAR_URL_PATTERN = /^(?=.{1,512}$)(https?:\/\/|\/)[^\s]+$/;
const DEFAULT_USER_ROLE_ID = 2;

export class UserService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly permissionService: PermissionService,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async listUsers(page: number, size: number, keyword?: string, status?: number | null): Promise<MpPage<User>> {
    const { records, total } = await this.userRepo.selectPage(page, size, keyword, status);
    return mpPage(records, total, page, size);
  }

  async getUser(id: number): Promise<User> {
    const user = await this.userRepo.findById(id);
    if (!user) {
      throw new BusinessException(ErrorCode.USER_NOT_FOUND);
    }
    return user;
  }

  async createUser(
    username: string,
    displayName: string,
    email: string | null | undefined,
    password: string,
    roleIds: number[] | null | undefined,
    status: number | null | undefined,
  ): Promise<User> {
    this.validateUsername(username);
    this.validatePassword(password);
    await this.assertUsernameUnique(username);

    const user: User = {
      username: username.trim(),
      displayName: displayName.trim(),
      email: hasText(email) ? email!.trim() : null,
      passwordHash: await this.passwordHasher.hash(password),
      status: status != null ? status : 1,
    };
    await this.userRepo.insert(user);
    const roles = roleIds && roleIds.length > 0 ? roleIds : [DEFAULT_USER_ROLE_ID];
    await this.permissionService.assignRoles(user.id!, roles);
    return user;
  }

  async updateUser(
    id: number,
    displayName: string | null | undefined,
    email: string | null | undefined,
    roleIds: number[] | null | undefined,
    status: number | null | undefined,
    currentUserId?: number,
  ): Promise<User> {
    const user = await this.getUser(id);
    if (hasText(displayName ?? undefined)) {
      user.displayName = displayName!.trim();
    }
    if (email != null) {
      user.email = hasText(email) ? email.trim() : null;
    }
    if (status != null && status === 0) {
      await this.permissionService.assertCanDisableUser(id, currentUserId ?? 0);
    }
    if (status != null) {
      user.status = status;
    }
    await this.userRepo.updateById(user);
    if (roleIds != null) {
      await this.permissionService.assertCanChangeRoles(id, roleIds);
      await this.permissionService.assignRoles(id, roleIds);
    }
    return user;
  }

  async updateUserStatus(id: number, status: number | null | undefined, currentUserId: number): Promise<void> {
    const user = await this.getUser(id);
    if (status != null && status === 0) {
      await this.permissionService.assertCanDisableUser(id, currentUserId);
    }
    user.status = status ?? null;
    await this.userRepo.updateById(user);
  }

  async resetPassword(id: number, newPassword: string): Promise<void> {
    const user = await this.getUser(id);
    if (!hasText(user.passwordHash ?? undefined)) {
      throw new BusinessException(ErrorCode.USER_PASSWORD_MANAGED_BY_LDAP);
    }
    this.validatePassword(newPassword);
    user.passwordHash = await this.passwordHasher.hash(newPassword);
    await this.userRepo.updateById(user);
  }

  async updateOwnProfile(userId: number, displayName?: string | null, email?: string | null, avatarUrl?: string | null): Promise<void> {
    const user = await this.getUser(userId);
    const localUser = hasText(user.passwordHash ?? undefined);
    if ((displayName != null || email != null) && !localUser) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'LDAP / 飞书账号的资料由系统维护，仅可修改头像');
    }

    const fields: Record<string, unknown> = {};
    if (avatarUrl !== undefined && avatarUrl !== null) {
      const url = hasText(avatarUrl) ? avatarUrl.trim() : null;
      if (url != null && !AVATAR_URL_PATTERN.test(url)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '头像地址仅支持 http(s) 链接或 / 开头的相对路径，且长度不超过 512');
      }
      if (url !== (user.avatarUrl ?? null)) {
        fields.avatarUrl = url;
      }
    } else if (avatarUrl === null) {
      if (user.avatarUrl != null) {
        fields.avatarUrl = null;
      }
    }

    if (displayName != null) {
      const name = displayName.trim();
      if (name.length === 0 || name.length > 128) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '显示名称不能为空且不超过 128 字符');
      }
      if (name !== user.displayName) {
        fields.displayName = name;
      }
    }

    if (email != null) {
      const mail = email.trim();
      const currentMail = user.email == null ? null : user.email.trim();
      if (mail !== (currentMail ?? '')) {
        if (mail.length > 0 && !EMAIL_PATTERN.test(mail)) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, '邮箱格式不正确');
        }
        if (mail.length > 128) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, '邮箱长度不能超过 128 字符');
        }
        if (mail.length > 0) {
          const dup = await this.userRepo.countByEmailExcept(mail, userId);
          if (dup > 0) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, '该邮箱已被其他用户使用');
          }
        }
        fields.email = mail.length === 0 ? null : mail;
      }
    }

    if (Object.keys(fields).length > 0) {
      await this.userRepo.updateFields(userId, fields);
    }
  }

  static resolveAuthSource(user: User): string {
    if (hasText(user.passwordHash ?? undefined)) {
      return 'LOCAL';
    }
    if (hasText(user.feishuUserId ?? undefined)) {
      return 'FEISHU';
    }
    return 'LDAP';
  }

  batchGetUserRoles(userIds: number[]): Promise<Map<number, Role[]>> {
    return this.permissionService.batchGetUserRoles(userIds);
  }

  getUserRoles(userId: number): Promise<Role[]> {
    return this.permissionService.getUserRoles(userId);
  }

  private validateUsername(username: string): void {
    if (!hasText(username) || !USERNAME_PATTERN.test(username.trim())) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '用户名须为 3-64 位字母、数字或下划线');
    }
  }

  private validatePassword(password: string): void {
    if (!hasText(password) || !PASSWORD_PATTERN.test(password)) {
      throw new BusinessException(ErrorCode.PASSWORD_INVALID);
    }
  }

  private async assertUsernameUnique(username: string): Promise<void> {
    const count = await this.userRepo.countByUsername(username.trim());
    if (count > 0) {
      throw new BusinessException(ErrorCode.USERNAME_DUPLICATE);
    }
  }
}
