import type { Db } from '../db/db.js';
import type { User } from '../user/types.js';
import { lockUserIdentityWrites } from '../user/user-email.js';
import type { VerifiedSsoIdentity } from './company-sso.client.js';
import { CompanySsoError } from './company-sso.error.js';
import { buildUniqueUsername, usernameTaken } from './username.js';

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
    // Email is the only identity key. Company claims.id is ignored so test/prod ids can differ.
    const subject = identity.email;
    return this.db.transaction(async (tx) => {
      await lockUserIdentityWrites(tx);
      const matches = await tx.query<User>('SELECT * FROM `user` WHERE BINARY email = BINARY ? FOR UPDATE', [identity.email]);
      if (matches.length > 1) throw new CompanySsoError('identity_conflict');
      let user = matches[0];
      if (user) {
        this.assertActive(user);
        const binding = await tx.queryOne<{ id: number; subject: string }>(
          'SELECT id, subject FROM user_external_identity WHERE provider = ? AND user_id = ? FOR UPDATE', ['company_sso', user.id],
        );
        if (binding) {
          if (binding.subject !== subject) {
            await tx.updateById('user_external_identity', binding.id, { subject, emailAtBinding: identity.email });
          }
          return { user, action: 'existing' };
        }
      } else {
        const binding = await tx.queryOne<{ userId: number }>(
          'SELECT user_id FROM user_external_identity WHERE provider = ? AND subject = ? FOR UPDATE', ['company_sso', subject],
        );
        if (binding) {
          user = (await tx.queryOne<User>('SELECT * FROM `user` WHERE id = ? FOR UPDATE', [binding.userId]))!;
          this.assertActive(user);
          return { user, action: 'existing' };
        }
        const role = await tx.queryOne<{ id: number }>('SELECT id FROM role WHERE code = ? AND deleted = 0 FOR UPDATE', ['USER']);
        if (!role) throw new CompanySsoError('service_unavailable');
        const username = await buildUniqueUsername(identity.email, { prefix: 'sso', seed: subject }, usernameTaken(tx));
        user = { username, displayName: identity.displayName, email: identity.email, passwordHash: null, status: 1, deleted: 0 };
        user.id = await tx.insert('user', user);
        await tx.insert('user_role', { userId: user.id, roleId: role.id });
      }
      await tx.insert('user_external_identity', { provider: 'company_sso', subject, userId: user.id, emailAtBinding: identity.email });
      return { user, action: matches.length ? 'bound' : 'created' };
    });
  }

  private assertActive(user: User | null): void {
    if (!user || user.deleted !== 0 || user.status !== 1) throw new CompanySsoError('account_forbidden');
  }
}
