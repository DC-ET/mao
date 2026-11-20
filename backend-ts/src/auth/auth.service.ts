import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { JwtService } from '../crypto/jwt.service.js';
import { UserService } from '../user/user.service.js';
import type { LoginVO, PasswordHasher, User, UserInfoVO, UserRepository } from '../user/types.js';
import type { PermissionService } from '../permission/permission.service.js';
import { loginLockKey } from './login-lockout.js';
import type { LoginLockout } from './login-lockout.js';
import type { LdapAuthService } from './ldap-auth.service.js';

export class AuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly jwtService: JwtService,
    private readonly passwordHasher: PasswordHasher,
    private readonly ldapAuthService: LdapAuthService | null,
    private readonly permissionService?: PermissionService,
    private readonly isPasswordLoginEnabled: () => Promise<boolean> = async () => true,
    private readonly loginLockout: LoginLockout | null = null,
  ) {}

  passwordLoginEnabled(): Promise<boolean> {
    return this.isPasswordLoginEnabled();
  }

  /**
   * 管理后台登录不看「账号密码登录」开关，给本地 admin 留入口。
   * 桌面 / Web / 安卓 / CLI 走默认路径，开关关闭时直接拒绝。
   * 传 clientIp 时启用登录失败锁定：锁定状态直接拒绝（不查库不验密）；失败计数在
   * 「验过密码但未通过」时累加（本地密码错误、用户不存在与 LDAP 兜底失败同口径），
   * 正确密码清零。
   */
  async login(
    username: string,
    password: string,
    options?: { ignorePasswordSwitch?: boolean; clientIp?: string },
  ): Promise<LoginVO> {
    if (!options?.ignorePasswordSwitch && !(await this.passwordLoginEnabled())) {
      throw new BusinessException(ErrorCode.LOGIN_FAILED, '账号密码登录已关闭');
    }
    const lockout = this.loginLockout;
    const lockKey = loginLockKey(username, options?.clientIp);
    if (lockout != null) {
      const remainingSeconds = lockout.lockedSecondsRemaining(lockKey);
      if (remainingSeconds > 0) {
        throw new BusinessException(
          ErrorCode.LOGIN_FAILED,
          `登录失败次数过多，请约 ${Math.ceil(remainingSeconds / 60)} 分钟后再试`,
        );
      }
    }
    const user = await this.userRepo.findByUsername(username);
    if (user && user.passwordHash && (await this.passwordHasher.matches(password, user.passwordHash))) {
      lockout?.recordSuccess(lockKey);
      return this.buildLoginResult(user);
    }
    if (this.ldapAuthService != null && await this.ldapAuthService.isConfigured()) {
      try {
        const vo = await this.ldapAuthService.authenticate(username, password);
        lockout?.recordSuccess(lockKey);
        return vo;
      } catch {
        // fall through
      }
    }
    lockout?.recordFailure(lockKey);
    throw new BusinessException(ErrorCode.LOGIN_FAILED);
  }

  async buildLoginResult(user: User): Promise<LoginVO> {
    if (user.status != null && user.status === 0) {
      throw new BusinessException(ErrorCode.ACCOUNT_DISABLED);
    }
    user.lastLoginAt = formatNow();
    await this.userRepo.updateById(user);
    return this.toLoginVO(user);
  }

  async refreshToken(refreshToken: string): Promise<LoginVO> {
    if (!this.jwtService.validateToken(refreshToken)
      || this.jwtService.getTokenType(refreshToken) !== 'refresh') {
      throw new BusinessException(ErrorCode.TOKEN_EXPIRED);
    }
    const userId = this.jwtService.getUserIdFromToken(refreshToken);
    const username = this.jwtService.getUsernameFromToken(refreshToken);
    const user = await this.userRepo.findById(userId);
    if (!user || (user.status != null && user.status === 0)) {
      throw new BusinessException(ErrorCode.ACCOUNT_DISABLED);
    }
    void username;
    return this.toLoginVO(user);
  }

  logout(): void {
    // Stateless JWT logout is handled client-side by discarding the token.
  }

  async toUserInfoVO(user: User, withPerms = false): Promise<UserInfoVO> {
    const vo: UserInfoVO = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      authSource: UserService.resolveAuthSource(user),
    };
    if (withPerms && this.permissionService && user.id != null) {
      const codes = await this.permissionService.getUserPermissionCodes(user.id);
      vo.permissions = [...new Set(codes)];
      vo.isAdmin = await this.permissionService.isAdmin(user.id);
    }
    return vo;
  }

  private async toLoginVO(user: User): Promise<LoginVO> {
    const accessToken = this.jwtService.generateToken(user.id!, user.username);
    const refreshToken = this.jwtService.generateRefreshToken(user.id!, user.username);
    return {
      accessToken,
      refreshToken,
      expiresIn: 86400,
      user: await this.toUserInfoVO(user),
    };
  }
}

/** 墙钟字符串，固定 Asia/Shanghai，与库内 `expires_at` 的字符串比较同一时钟。 */
export function formatShanghaiDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const tz = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return `${tz.getFullYear()}-${pad(tz.getMonth() + 1)}-${pad(tz.getDate())} ${pad(tz.getHours())}:${pad(tz.getMinutes())}:${pad(tz.getSeconds())}`;
}

export function formatNow(): string {
  return formatShanghaiDateTime(new Date());
}

/**
 * 把库里的上海墙钟 `YYYY-MM-DD HH:mm:ss` 解析成绝对时间。
 * `new Date('YYYY-MM-DD HH:mm:ss')` 按进程本地时区解释，和写侧固定的 Asia/Shanghai 不是同一时钟。
 */
export function parseShanghaiDateTime(value: string | null | undefined): number {
  if (value == null) return Number.NaN;
  const text = value.trim();
  if (text === '') return Number.NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) return new Date(text).getTime();
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  return new Date(`${normalized}+08:00`).getTime();
}

export function isShanghaiExpired(value: string | null | undefined, now = Date.now()): boolean {
  const ts = parseShanghaiDateTime(value);
  return !Number.isFinite(ts) || ts <= now;
}
