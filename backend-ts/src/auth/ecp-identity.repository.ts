import type { Db } from '../db/db.js';
import type { User } from '../user/types.js';
import { lockUserIdentityWrites } from '../user/user-email.js';
import { isActiveAccount } from '../permission/permission.service.js';
import { EcpError } from './ecp.error.js';
import type { EcpSessionUser } from './ecp.client.js';
import { buildUniqueUsername, usernameTaken } from './username.js';

export type EcpAssociationAction = 'created' | 'bound' | 'existing';

export class EcpIdentityRepository {
  constructor(private readonly db: Db) {}

  async resolve(identity: EcpSessionUser): Promise<{ user: User; action: EcpAssociationAction }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.resolveTransaction(identity);
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (attempt < 2 && ['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(code ?? '')) continue;
        if (code === 'ER_DUP_ENTRY') throw new EcpError('邮箱身份冲突，请联系管理员处理');
        throw error;
      }
    }
  }

  private async resolveTransaction(identity: EcpSessionUser): Promise<{ user: User; action: EcpAssociationAction }> {
    const subject = identity.email;
    return this.db.transaction(async (tx) => {
      await lockUserIdentityWrites(tx);
      const matches = await tx.query<User>('SELECT * FROM `user` WHERE BINARY email = BINARY ? FOR UPDATE', [identity.email]);
      if (matches.length > 1) throw new EcpError('邮箱对应多个账号，无法自动登录');
      let user = matches[0];
      if (user) {
        this.assertActive(user);
        const binding = await tx.queryOne<{ id: number; subject: string }>(
          'SELECT id, subject FROM user_external_identity WHERE provider = ? AND user_id = ? FOR UPDATE', ['ecp', user.id],
        );
        if (binding) {
          if (binding.subject !== subject) {
            await tx.updateById('user_external_identity', binding.id, { subject, emailAtBinding: identity.email });
          }
          await this.attachEarliestProvider(tx, user);
          return { user, action: 'existing' };
        }
      } else {
        const binding = await tx.queryOne<{ userId: number }>(
          'SELECT user_id FROM user_external_identity WHERE provider = ? AND subject = ? FOR UPDATE', ['ecp', subject],
        );
        if (binding) {
          user = (await tx.queryOne<User>('SELECT * FROM `user` WHERE id = ? FOR UPDATE', [binding.userId]))!;
          this.assertActive(user);
          await this.attachEarliestProvider(tx, user);
          return { user, action: 'existing' };
        }
        const role = await tx.queryOne<{ id: number }>('SELECT id FROM role WHERE code = ? AND deleted = 0 FOR UPDATE', ['USER']);
        if (!role) throw new EcpError('ECP 登录服务暂不可用');
        user = {
          username: await buildUniqueUsername(identity.email, { prefix: 'ecp', seed: subject }, usernameTaken(tx)),
          displayName: identity.displayName,
          email: identity.email,
          passwordHash: null,
          status: 1,
          deleted: 0,
        };
        user.id = await tx.insert('user', user);
        await tx.insert('user_role', { userId: user.id, roleId: role.id });
      }
      await tx.insert('user_external_identity', { provider: 'ecp', subject, userId: user.id, emailAtBinding: identity.email });
      await this.attachEarliestProvider(tx, user);
      return { user, action: matches.length ? 'bound' : 'created' };
    });
  }

  /**
   * 补齐账号来源判定所需的 `external_provider`：与 user.repository 的派生列同口径（取最早绑定）。
   * ECP 换票的用户行来自裸 `SELECT *`，不带该列时 UserService.resolveAuthSource 会兜底成 LDAP，
   * 与 /auth/me（findById 带派生列）的 ECP 结论相反。
   */
  private async attachEarliestProvider(tx: Db, user: User): Promise<void> {
    if (user.id == null) return;
    const row = await tx.queryOne<{ provider: string | null }>(
      'SELECT provider FROM user_external_identity WHERE user_id = ? ORDER BY id LIMIT 1',
      [user.id],
    );
    user.externalProvider = row?.provider ?? null;
  }

  private assertActive(user: User | null): void {
    // 与 isActiveAccount / 本地密码登录同口径：仅 status===0 停用，deleted 非 0 拒绝；
    // status=NULL 是文档化的第三态「未设置」（SSO/ECP 外部账号的默认取值），必须放行，
    // 否则同一账号本地登录成功、SSO/ECP 登录被拒，两个入口结论相反。
    if (!user || user.deleted !== 0 || !isActiveAccount(user.status)) throw new EcpError('账号已禁用或不存在');
  }
}
