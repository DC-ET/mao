import type { Db } from '../db/db.js';
import type { User } from '../user/types.js';
import { lockUserIdentityWrites } from '../user/user-email.js';
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
          return { user, action: 'existing' };
        }
      } else {
        const binding = await tx.queryOne<{ userId: number }>(
          'SELECT user_id FROM user_external_identity WHERE provider = ? AND subject = ? FOR UPDATE', ['ecp', subject],
        );
        if (binding) {
          user = (await tx.queryOne<User>('SELECT * FROM `user` WHERE id = ? FOR UPDATE', [binding.userId]))!;
          this.assertActive(user);
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
      return { user, action: matches.length ? 'bound' : 'created' };
    });
  }

  private assertActive(user: User | null): void {
    if (!user || user.deleted !== 0 || user.status !== 1) throw new EcpError('账号已禁用或不存在');
  }
}
