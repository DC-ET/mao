import type { Db } from '../db/db.js';
import type { FeishuOauthState, FeishuOauthStateRepository } from './feishu-auth.service.js';

export class MysqlFeishuOauthStateRepository implements FeishuOauthStateRepository {
  constructor(private readonly db: Db) {}

  async insert(row: FeishuOauthState): Promise<void> {
    await this.db.insert('feishu_oauth_state', {
      state: row.state,
      status: row.status,
      userId: row.userId,
      errorMessage: row.errorMessage,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    });
  }

  findByState(state: string): Promise<FeishuOauthState | null> {
    return this.db.queryOne<FeishuOauthState>('SELECT * FROM feishu_oauth_state WHERE state = ?', [state]);
  }

  async updateByState(state: string, expectedStatus: string, patch: Partial<FeishuOauthState>): Promise<number> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.userId !== undefined) {
      sets.push('user_id = ?');
      params.push(patch.userId);
    }
    if (patch.errorMessage !== undefined) {
      sets.push('error_message = ?');
      params.push(patch.errorMessage);
    }
    if (patch.consumedAt !== undefined) {
      sets.push('consumed_at = ?');
      params.push(patch.consumedAt);
    }
    if (sets.length === 0) {
      return 0;
    }
    params.push(state, expectedStatus);
    const result = await this.db.execute(
      `UPDATE feishu_oauth_state SET ${sets.join(', ')} WHERE state = ? AND status = ?`,
      params,
    );
    return result.affectedRows;
  }

  async consumeSuccess(state: string, now: string): Promise<number> {
    const result = await this.db.execute(
      `UPDATE feishu_oauth_state SET consumed_at = ? WHERE state = ? AND status = 'SUCCESS' AND consumed_at IS NULL AND expires_at > ?`,
      [now, state, now],
    );
    return result.affectedRows;
  }
}
