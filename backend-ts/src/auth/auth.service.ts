import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { JwtService } from '../crypto/jwt.service.js';
import { UserService } from '../user/user.service.js';
import type { LoginVO, PasswordHasher, User, UserInfoVO, UserRepository } from '../user/types.js';
import type { PermissionService } from '../permission/permission.service.js';
import type { LdapAuthService } from './ldap-auth.service.js';

export class AuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly jwtService: JwtService,
    private readonly passwordHasher: PasswordHasher,
    private readonly ldapAuthService: LdapAuthService | null,
    private readonly permissionService?: PermissionService,
  ) {}

  async login(username: string, password: string): Promise<LoginVO> {
    const user = await this.userRepo.findByUsername(username);
    if (user && user.passwordHash && (await this.passwordHasher.matches(password, user.passwordHash))) {
      return this.buildLoginResult(user);
    }
    if (this.ldapAuthService?.isConfigured()) {
      try {
        return await this.ldapAuthService.authenticate(username, password);
      } catch {
        // fall through
      }
    }
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
    if (!this.jwtService.validateToken(refreshToken)) {
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

export function formatNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const tz = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return `${tz.getFullYear()}-${pad(tz.getMonth() + 1)}-${pad(tz.getDate())} ${pad(tz.getHours())}:${pad(tz.getMinutes())}:${pad(tz.getSeconds())}`;
}
