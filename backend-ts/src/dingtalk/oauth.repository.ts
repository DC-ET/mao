import { randomBytes } from 'node:crypto';
import type { Db } from '../db/db.js';

export interface DingtalkOauthStateRow {
  id: number;
  state: string;
  userId: number | null;
  status: string;
  expiresAt: string;
}

export class MysqlDingtalkOauthStateRepository {
  constructor(private readonly db: Db) {}

  async create(userId: number | null, ttlMs: number): Promise<string> {
    const state = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.db.insert('dingtalk_oauth_state', {
      state,
      userId,
      status: 'PENDING',
      expiresAt,
    });
    return state;
  }

  async findPending(state: string): Promise<DingtalkOauthStateRow | null> {
    return this.db.queryOne<DingtalkOauthStateRow>(
      "SELECT * FROM dingtalk_oauth_state WHERE state = ? AND status = 'PENDING' AND expires_at > CURRENT_TIMESTAMP LIMIT 1",
      [state],
    );
  }

  /** 短链登录后填上 Mao 用户。已有且不是同一人则失败。 */
  async attachUser(state: string, userId: number): Promise<'OK' | 'MISSING' | 'CONFLICT'> {
    const row = await this.findPending(state);
    if (row == null) return 'MISSING';
    if (row.userId != null && row.userId !== userId) return 'CONFLICT';
    if (row.userId === userId) return 'OK';
    const result = await this.db.execute(
      "UPDATE dingtalk_oauth_state SET user_id = ? WHERE state = ? AND status = 'PENDING' AND user_id IS NULL AND expires_at > CURRENT_TIMESTAMP",
      [userId, state],
    );
    return result.affectedRows === 1 ? 'OK' : 'MISSING';
  }

  async consume(state: string): Promise<DingtalkOauthStateRow | null> {
    const row = await this.findPending(state);
    if (row == null || row.userId == null) return null;
    const result = await this.db.execute(
      "UPDATE dingtalk_oauth_state SET status = 'USED' WHERE state = ? AND status = 'PENDING' AND user_id IS NOT NULL AND expires_at > CURRENT_TIMESTAMP",
      [state],
    );
    if (result.affectedRows !== 1) return null;
    return { ...row, status: 'USED' };
  }

  async fail(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE dingtalk_oauth_state SET status = 'FAILED' WHERE state = ? AND status = 'PENDING'",
      [state],
    );
  }
}
