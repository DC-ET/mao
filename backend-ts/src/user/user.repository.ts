import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { User, UserRepository } from './types.js';

export class MysqlUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  findById(id: number): Promise<User | null> {
    return this.db.queryOne<User>(`SELECT * FROM \`user\` WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  async findByIds(ids: number[]): Promise<User[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.query<User>(
      `SELECT * FROM \`user\` WHERE id IN (${placeholders}) AND ${notDeleted()}`,
      ids,
    );
  }

  listOptions(): Promise<User[]> {
    return this.db.query<User>(
      `SELECT id, username, display_name FROM \`user\` WHERE ${notDeleted()} ORDER BY id ASC`,
    );
  }

  findByUsername(username: string): Promise<User | null> {
    return this.db.queryOne<User>(`SELECT * FROM \`user\` WHERE username = ? AND ${notDeleted()}`, [username]);
  }

  findByEmail(email: string): Promise<User | null> {
    return this.db.queryOne<User>(`SELECT * FROM \`user\` WHERE email = ? AND ${notDeleted()}`, [email]);
  }

  findByFeishuUserId(feishuUserId: string): Promise<User | null> {
    return this.db.queryOne<User>(`SELECT * FROM \`user\` WHERE feishu_user_id = ? AND ${notDeleted()}`, [feishuUserId]);
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
      `SELECT COUNT(*) AS cnt FROM \`user\` WHERE email = ? AND id <> ? AND ${notDeleted()}`,
      [email, userId],
    );
    return Number(row?.cnt ?? 0);
  }

  async insert(user: User): Promise<number> {
    const id = await this.db.insert('user', {
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      passwordHash: user.passwordHash,
      feishuUserId: user.feishuUserId,
      status: user.status ?? 1,
      deleted: 0,
    });
    user.id = id;
    return id;
  }

  async updateById(user: User): Promise<void> {
    if (user.id == null) {
      return;
    }
    await this.db.updateById('user', user.id, {
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
    await this.db.updateById('user', id, fields);
  }

  async selectPage(page: number, size: number, keyword?: string, status?: number | null): Promise<{ records: User[]; total: number }> {
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
    const whereSql = where.join(' AND ');
    const countRow = await this.db.queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM \`user\` WHERE ${whereSql}`, params);
    const total = Number(countRow?.cnt ?? 0);
    const offset = (page - 1) * size;
    const records = await this.db.query<User>(
      `SELECT * FROM \`user\` WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, size, offset],
    );
    return { records, total };
  }
}
