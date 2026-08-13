import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { UserCommand, UserCommandRepository } from './types.js';

export class MysqlUserCommandRepository implements UserCommandRepository {
  constructor(private readonly db: Db) {}

  listByUserId(userId: number): Promise<UserCommand[]> {
    return this.db.query<UserCommand>(
      `SELECT * FROM user_command WHERE user_id = ? AND ${notDeleted()} ORDER BY created_at DESC`,
      [userId],
    );
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
