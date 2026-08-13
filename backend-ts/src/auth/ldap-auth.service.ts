import { Client } from 'ldapts';
import { BusinessException } from '../common/business-exception.js';
import { JwtService } from '../crypto/jwt.service.js';
import type { AppConfig } from '../config/app-config.js';
import { hasText } from '../common/case.js';
import type { LoginVO, User, UserRepository, UserRoleRepository } from '../user/types.js';
import { UserService } from '../user/user.service.js';
import { formatNow } from './auth.service.js';

export class LdapAuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly userRoleRepo: UserRoleRepository,
    private readonly jwtService: JwtService,
    private readonly cfg: AppConfig['ldap'],
  ) {}

  isConfigured(): boolean {
    return this.cfg.enabled && hasText(this.cfg.url);
  }

  async authenticate(username: string, password: string): Promise<LoginVO> {
    if (!this.isConfigured()) {
      throw new BusinessException(5003, 'LDAP 未配置');
    }
    const admin = new Client({ url: this.cfg.url });
    try {
      await admin.bind(this.cfg.userDn, this.cfg.password);
      const searchBase = `${this.cfg.userSearchBase},${this.cfg.baseDn}`;
      const { searchEntries } = await admin.search(searchBase, {
        scope: 'sub',
        filter: `(sAMAccountName=${escapeFilter(username)})`,
        attributes: ['dn', 'cn', 'mail'],
      });
      await admin.unbind();
      if (searchEntries.length === 0) {
        throw new BusinessException(5004, 'LDAP 用户不存在');
      }
      const entry = searchEntries[0];
      const userDnPath = String(entry.dn);
      const userClient = new Client({ url: this.cfg.url });
      try {
        await userClient.bind(userDnPath, password);
        const displayName = attr(entry, 'cn') ?? username;
        const email = attr(entry, 'mail');
        let user = await this.userRepo.findByUsername(username);
        if (!user) {
          user = {
            username,
            displayName,
            email,
            status: 1,
          };
          await this.userRepo.insert(user);
          await this.userRoleRepo.insert({ userId: user.id!, roleId: 2 });
        } else {
          user.displayName = displayName;
          user.email = email;
          user.lastLoginAt = formatNow();
          await this.userRepo.updateById(user);
        }
        return {
          accessToken: this.jwtService.generateToken(user.id!, user.username),
          refreshToken: this.jwtService.generateRefreshToken(user.id!, user.username),
          expiresIn: 86400,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            email: user.email,
            avatarUrl: user.avatarUrl,
            authSource: UserService.resolveAuthSource(user),
          },
        };
      } finally {
        try {
          await userClient.unbind();
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      if (e instanceof BusinessException) {
        throw e;
      }
      console.error(`LDAP authentication failed for user: ${username}`, e);
      throw new BusinessException(5004, `LDAP 认证失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function attr(entry: Record<string, unknown>, name: string): string | undefined {
  const v = entry[name];
  if (Array.isArray(v)) {
    return v[0] != null ? String(v[0]) : undefined;
  }
  return v != null ? String(v) : undefined;
}

function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => {
    const map: Record<string, string> = { '\\': '\\5c', '*': '\\2a', '(': '\\28', ')': '\\29', '\0': '\\00' };
    return map[c] ?? c;
  });
}
