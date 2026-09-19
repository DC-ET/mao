import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { UserCommand, UserCommandRepository } from './types.js';

/** 转义 LIKE 通配符（与 session.service escapeLike 语义一致），配合默认反斜杠转义。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class MysqlUserCommandRepository implements UserCommandRepository {
  constructor(private readonly db: Db) {}

  listByUserId(userId: number): Promise<UserCommand[]> {
    return this.db.query<UserCommand>(
      `SELECT * FROM user_command WHERE user_id = ? AND ${notDeleted()} ORDER BY created_at DESC`,
      [userId],
    );
  }

  listPersonalAll(): Promise<UserCommand[]> {
    return this.db.query<UserCommand>(
      `SELECT * FROM user_command WHERE user_id > 0 AND ${notDeleted()} ORDER BY created_at DESC`,
    );
  }

  private buildPersonalWhere(keyword?: string, userId?: number): { whereSql: string; params: unknown[] } {
    const clauses = ['user_id > 0', notDeleted()];
    const params: unknown[] = [];
    if (userId != null && Number.isInteger(userId) && userId > 0) {
      clauses.push('user_id = ?');
      params.push(userId);
    }
    const trimmed = keyword?.trim();
    if (trimmed) {
      const escaped = escapeLike(trimmed);
      clauses.push('(name LIKE ? OR content LIKE ?)');
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    return { whereSql: clauses.join(' AND '), params };
  }

  listPersonalFiltered(keyword?: string, userId?: number): Promise<UserCommand[]> {
    const { whereSql, params } = this.buildPersonalWhere(keyword, userId);
    return this.db.query<UserCommand>(
      `SELECT * FROM user_command WHERE ${whereSql} ORDER BY created_at DESC`,
      params,
    );
  }

  async listPersonalPaged(pageNum: number, pageSize: number, keyword?: string, userId?: number): Promise<{ records: UserCommand[]; total: number }> {
    const { whereSql, params } = this.buildPersonalWhere(keyword, userId);
    const totalRow = await this.db.queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM user_command WHERE ${whereSql}`, params);
    const records = await this.db.query<UserCommand>(
      `SELECT * FROM user_command WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (pageNum - 1) * pageSize],
    );
    return { records, total: Number(totalRow?.c ?? 0) };
  }

  findByIdAndUserId(id: number, userId: number): Promise<UserCommand | null> {
    return this.db.queryOne<UserCommand>(
      `SELECT * FROM user_command WHERE id = ? AND user_id = ? AND ${notDeleted()}`,
      [id, userId],
    );
  }

  findByUserIdAndName(userId: number, name: string): Promise<UserCommand | null> {
    return this.db.queryOne<UserCommand>(
      `SELECT * FROM user_command WHERE user_id = ? AND name = ? AND ${notDeleted()}`,
      [userId, name],
    );
  }

  async insert(command: UserCommand): Promise<number> {
    const id = await this.db.insert('user_command', {
      userId: command.userId,
      name: command.name,
      content: command.content,
      deleted: 0,
    });
    command.id = id;
    return id;
  }

  async updateById(command: UserCommand): Promise<void> {
    if (command.id == null) {
      return;
    }
    await this.db.updateById('user_command', command.id, {
      userId: command.userId,
      name: command.name,
      content: command.content,
    });
  }

  async deleteById(id: number): Promise<void> {
    await this.db.updateById('user_command', id, { deleted: 1 });
  }
}
