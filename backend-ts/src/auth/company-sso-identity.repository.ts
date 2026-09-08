import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.js';
import type { User } from '../user/types.js';
import { lockUserIdentityWrites } from '../user/user-email.js';
import type { VerifiedSsoIdentity } from './company-sso.client.js';
import { CompanySsoError } from './company-sso.error.js';

export type SsoAssociationAction = 'created' | 'bound' | 'existing';

export class CompanySsoIdentityRepository {
  constructor(private readonly db: Db) {}

  async resolve(identity: VerifiedSsoIdentity): Promise<{ user: User; action: SsoAssociationAction }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.resolveTransaction(identity);
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        // Retry only after transaction rollback, then reread the winning binding.
        if (attempt < 2 && ['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(code ?? '')) continue;
        if (code === 'ER_DUP_ENTRY') throw new CompanySsoError('identity_conflict');
        throw error;
      }
    }
  }

  private async resolveTransaction(identity: VerifiedSsoIdentity): Promise<{ user: User; action: SsoAssociationAction }> {
    // All repository email writers take this same lock before locking any user row.
    // Creation, ordinary role assignment and binding either commit together or roll back.
    return this.db.transaction(async (tx) => {
      await lockUserIdentityWrites(tx);
      const binding = await tx.queryOne<{ userId: number }>(
        'SELECT user_id FROM user_external_identity WHERE provider = ? AND subject = ? FOR UPDATE', ['company_sso', identity.subject],
      );
      if (binding) {
        const user = await tx.queryOne<User>('SELECT * FROM `user` WHERE id = ? FOR UPDATE', [binding.userId]);
        this.assertActive(user);
        return { user: user!, action: 'existing' };
      }
      const matches = await tx.query<User>('SELECT * FROM `user` WHERE BINARY email = BINARY ? FOR UPDATE', [identity.email]);
      if (matches.length > 1) throw new CompanySsoError('identity_conflict');
      let user = matches[0];
      if (user) {
        this.assertActive(user);
        const admin = await tx.queryOne<{ id: number }>(
          'SELECT r.id FROM role r JOIN user_role ur ON ur.role_id = r.id WHERE ur.user_id = ? AND r.code = ? AND r.deleted = 0 FOR UPDATE', [user.id, 'ADMIN'],
        );
        if (admin) throw new CompanySsoError('account_forbidden');
        const other = await tx.queryOne<{ id: number }>('SELECT id FROM user_external_identity WHERE provider = ? AND user_id = ? FOR UPDATE', ['company_sso', user.id]);
        if (other) throw new CompanySsoError('identity_conflict');
      } else {
        const role = await tx.queryOne<{ id: number }>('SELECT id FROM role WHERE code = ? AND deleted = 0 FOR UPDATE', ['USER']);
        if (!role) throw new CompanySsoError('service_unavailable');
        user = { username: `sso_${randomUUID().replaceAll('-', '')}`, displayName: identity.displayName, email: identity.email, passwordHash: null, status: 1, deleted: 0 };
        user.id = await tx.insert('user', user);
        await tx.insert('user_role', { userId: user.id, roleId: role.id });
      }
      await tx.insert('user_external_identity', { provider: 'company_sso', subject: identity.subject, userId: user.id, emailAtBinding: identity.email });
      return { user, action: matches.length ? 'bound' : 'created' };
    });
  }

  private assertActive(user: User | null): void {
    if (!user || user.deleted !== 0 || user.status !== 1) throw new CompanySsoError('account_forbidden');
  }
}
