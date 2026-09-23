import { assertEmailAvailable, lockUserIdentityWrites } from './user-email.js';
import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import { COMPANY_SSO_PROVIDER, ECP_PROVIDER, externalProviderInList } from '../auth/external-provider.js';
import type { User, UserRepository } from './types.js';

/** 账号来源判定所需的外部身份提供方；单行子查询，避免多提供方绑定时 LEFT JOIN 放大行数。 */
const EXTERNAL_PROVIDER_SQL =
  '(SELECT e.provider FROM user_external_identity e WHERE e.user_id = `user`.id ORDER BY e.id LIMIT 1)';
const EXTERNAL_PROVIDER_COLUMN = `${EXTERNAL_PROVIDER_SQL} AS external_provider`;

/** 与 UserService.resolveAuthSource 同一口径（都取最早绑定的 provider），下推到列表查询。 */
function authSourceWhere(authSource: string | null | undefined): string | null {
  const source = authSource?.trim().toUpperCase();
  const noPassword = '(password_hash IS NULL OR TRIM(password_hash) = \'\')';
  const noFeishu = '(feishu_user_id IS NULL OR TRIM(feishu_user_id) = \'\')';
  const hasPassword = '(password_hash IS NOT NULL AND TRIM(password_hash) <> \'\')';
  const hasFeishu = '(feishu_user_id IS NOT NULL AND TRIM(feishu_user_id) <> \'\')';
  // 同时绑定 ECP 与公司 SSO 的账号只归入最早绑定的那个来源，否则筛选会重复命中。
  const noExternalProvider = `(COALESCE(${EXTERNAL_PROVIDER_SQL}, '') NOT IN (${externalProviderInList()}))`;
  if (source === 'LOCAL') return hasPassword;
  if (source === 'ECP') return `(${noPassword} AND ${EXTERNAL_PROVIDER_SQL} = '${ECP_PROVIDER}')`;
  if (source === 'COMPANY_SSO') return `(${noPassword} AND ${EXTERNAL_PROVIDER_SQL} = '${COMPANY_SSO_PROVIDER}')`;
  if (source === 'FEISHU') return `(${noPassword} AND ${hasFeishu} AND ${noExternalProvider})`;
  if (source === 'LDAP') return `(${noPassword} AND ${noFeishu} AND ${noExternalProvider})`;
  return null;
}

export class MysqlUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  findById(id: number): Promise<User | null> {
    return this.db.queryOne<User>(`SELECT *, ${EXTERNAL_PROVIDER_COLUMN} FROM \`user\` WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  async findByIds(ids: number[]): Promise<User[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.query<User>(
      `SELECT *, ${EXTERNAL_PROVIDER_COLUMN} FROM \`user\` WHERE id IN (${placeholders}) AND ${notDeleted()}`,
      ids,
    );
  }

  listOptions(): Promise<User[]> {
    return this.db.query<User>(
      `SELECT id, username, display_name FROM \`user\` WHERE ${notDeleted()} ORDER BY id ASC`,
    );
  }

  findByUsername(username: string): Promise<User | null> {
    return this.db.queryOne<User>(`SELECT *, ${EXTERNAL_PROVIDER_COLUMN} FROM \`user\` WHERE username = ? AND ${notDeleted()}`, [username]);
  }

  findByEmail(email: string): Promise<User | null> {
    return this.db.queryOne<User>(`SELECT *, ${EXTERNAL_PROVIDER_COLUMN} FROM \`user\` WHERE email = ? AND ${notDeleted()}`, [email]);
  }

  findByFeishuUserId(feishuUserId: string): Promise<User | null> {
    return this.db.queryOne<User>(`SELECT *, ${EXTERNAL_PROVIDER_COLUMN} FROM \`user\` WHERE feishu_user_id = ? AND ${notDeleted()}`, [feishuUserId]);
  }

  async countByUsername(username: string): Promise<number> {
    const row = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM \`user\` WHERE username = ? AND ${notDeleted()}`,
      [username],
    );
    return Number(row?.cnt ?? 0);
  }

  async countByEmailExcept(email: string, userId: number): Promise<number> {
    const row = await this.db.queryOne<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM `user` WHERE BINARY email = BINARY ? AND id <> ?',
      [email, userId],
    );
    return Number(row?.cnt ?? 0);
  }

  async insert(user: User): Promise<number> {
    const id = await this.db.transaction(async (tx) => {
      await lockUserIdentityWrites(tx);
      await assertEmailAvailable(tx, user.email);
      return tx.insert('user', {
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        passwordHash: user.passwordHash,
        feishuUserId: user.feishuUserId,
        status: user.status ?? 1,
        deleted: 0,
      });
    });
    user.id = id;
    return id;
  }

  async updateById(user: User): Promise<void> {
    if (user.id == null) {
      return;
    }
    await this.updateFields(user.id, {
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      passwordHash: user.passwordHash,
      feishuUserId: user.feishuUserId,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
    });
  }

  async updateFields(id: number, fields: Record<string, unknown>): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockUserIdentityWrites(tx);
      if (fields.email !== undefined) {
        const current = await tx.queryOne<User>('SELECT * FROM `user` WHERE id = ? FOR UPDATE', [id]);
        if (current?.email !== fields.email) await assertEmailAvailable(tx, fields.email, id);
      }
      await tx.updateById('user', id, fields);
    });
  }

  async selectPage(page: number, size: number, keyword?: string, status?: number | null, authSource?: string | null): Promise<{ records: User[]; total: number }> {
    const where: string[] = [notDeleted()];
    const params: unknown[] = [];
    if (keyword && keyword.trim()) {
      const kw = `%${keyword.trim()}%`;
      where.push('(username LIKE ? OR display_name LIKE ? OR email LIKE ?)');
      params.push(kw, kw, kw);
    }
    if (status != null) {
      where.push('status = ?');
      params.push(status);
    }
    const authSourceSql = authSourceWhere(authSource);
    if (authSourceSql) where.push(authSourceSql);
    const whereSql = where.join(' AND ');
    const countRow = await this.db.queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM \`user\` WHERE ${whereSql}`, params);
    const total = Number(countRow?.cnt ?? 0);
    const offset = (page - 1) * size;
    const records = await this.db.query<User>(
      `SELECT *, ${EXTERNAL_PROVIDER_COLUMN} FROM \`user\` WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, size, offset],
    );
    return { records, total };
  }
}
