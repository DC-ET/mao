import type { Db } from '../db/db.js';
import type { EcpCallbackTarget } from './ecp.config.js';

export const ECP_PENDING = 'PENDING';
export const ECP_SUCCESS = 'SUCCESS';
export const ECP_FAILED = 'FAILED';
export const ECP_EXPIRED = 'EXPIRED';
const ECP_PROCESSING = 'PROCESSING';

export interface EcpOauthState {
  id?: number;
  state: string;
  callbackTarget: EcpCallbackTarget;
  status: string;
  userId?: number | null;
  errorMessage?: string | null;
  expiresAt: string;
  consumedAt?: string | null;
}

export interface EcpOauthStateRepository {
  insert(row: EcpOauthState): Promise<void>;
  findByState(state: string): Promise<EcpOauthState | null>;
  updateByState(state: string, expectedStatus: string, patch: Partial<EcpOauthState>): Promise<number>;
  consumeSuccess(state: string, now: string): Promise<number>;
  claimPending(state: string, now: string): Promise<number>;
}

export class MysqlEcpOauthStateRepository implements EcpOauthStateRepository {
  constructor(private readonly db: Db) {}

  async insert(row: EcpOauthState): Promise<void> {
    await this.db.insert('ecp_oauth_state', {
      state: row.state,
      callbackTarget: row.callbackTarget,
      status: row.status,
      userId: row.userId,
      errorMessage: row.errorMessage,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    });
  }

  findByState(state: string): Promise<EcpOauthState | null> {
    return this.db.queryOne<EcpOauthState>('SELECT * FROM ecp_oauth_state WHERE state = ?', [state]);
  }

  async updateByState(state: string, expectedStatus: string, patch: Partial<EcpOauthState>): Promise<number> {
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
    if (sets.length === 0) return 0;
    params.push(state, expectedStatus);
    const expiryClause = expectedStatus === ECP_PROCESSING && patch.status === ECP_SUCCESS ? ' AND expires_at > CURRENT_TIMESTAMP' : '';
    const result = await this.db.execute(
      `UPDATE ecp_oauth_state SET ${sets.join(', ')} WHERE state = ? AND status = ?${expiryClause}`,
      params,
    );
    return result.affectedRows;
  }

  async claimPending(state: string, now: string): Promise<number> {
    const result = await this.db.execute(
      `UPDATE ecp_oauth_state SET status = ? WHERE state = ? AND status = ? AND expires_at > ?`,
      [ECP_PROCESSING, state, ECP_PENDING, now],
    );
    return result.affectedRows;
  }

  async consumeSuccess(state: string, now: string): Promise<number> {
    const result = await this.db.execute(
      `UPDATE ecp_oauth_state SET consumed_at = ? WHERE state = ? AND status = ? AND consumed_at IS NULL AND expires_at > ?`,
      [now, state, ECP_SUCCESS, now],
    );
    return result.affectedRows;
  }
}
