import { decryptAesGcm, encryptAesGcmNonNull } from '../crypto/aes-gcm.js';
import type { Db } from '../db/db.js';
import { formatDateTime } from '../common/json.js';

export type EcpRenewStatus = 'ACTIVE' | 'RENEWING' | 'FAILED';

export interface UserEcpSession {
  id?: number;
  userId: number;
  sessionTokenEnc: string;
  expiresAt: string;
  renewStatus: EcpRenewStatus;
  lastRenewAt?: string | null;
}

export interface EcpSessionStore {
  findByUserId(userId: number): Promise<UserEcpSession | null>;
  upsert(userId: number, sessionTokenEnc: string, expiresAt: Date): Promise<void>;
  listDueForRenew(before: string, limit: number): Promise<UserEcpSession[]>;
  markRenewing(id: number): Promise<boolean>;
  saveRenewed(id: number, sessionTokenEnc: string, expiresAt: Date): Promise<void>;
  markFailed(id: number): Promise<void>;
  clearFailed(userId: number): Promise<void>;
}

export class MysqlEcpSessionRepository implements EcpSessionStore {
  constructor(
    private readonly db: Db,
    private readonly secretKey: string,
  ) {}

  encryptToken(token: string): string {
    return encryptAesGcmNonNull(token, this.secretKey, 'ECP sessionToken 加密失败');
  }

  decryptToken(enc: string): string | null {
    return decryptAesGcm(enc, this.secretKey);
  }

  async findByUserId(userId: number): Promise<UserEcpSession | null> {
    return this.db.queryOne<UserEcpSession>(
      'SELECT * FROM user_ecp_session WHERE user_id = ?',
      [userId],
    );
  }

  async upsert(userId: number, sessionTokenEnc: string, expiresAt: Date): Promise<void> {
    const expiresAtStr = formatDateTime(expiresAt);
    const existing = await this.findByUserId(userId);
    if (existing?.id != null) {
      await this.db.updateById('user_ecp_session', existing.id, {
        sessionTokenEnc,
        expiresAt: expiresAtStr,
        renewStatus: 'ACTIVE',
        lastRenewAt: null,
      });
      return;
    }
    await this.db.insert('user_ecp_session', {
      userId,
      sessionTokenEnc,
      expiresAt: expiresAtStr,
      renewStatus: 'ACTIVE',
    });
  }

  async listDueForRenew(before: string, limit: number): Promise<UserEcpSession[]> {
    return this.db.query<UserEcpSession>(
      `SELECT * FROM user_ecp_session
       WHERE renew_status = 'ACTIVE' AND expires_at <= ?
       ORDER BY expires_at ASC LIMIT ?`,
      [before, limit],
    );
  }

  async markRenewing(id: number): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE user_ecp_session SET renew_status = 'RENEWING' WHERE id = ? AND renew_status = 'ACTIVE'`,
      [id],
    );
    return result.affectedRows === 1;
  }

  async saveRenewed(id: number, sessionTokenEnc: string, expiresAt: Date): Promise<void> {
    const now = formatDateTime(new Date());
    await this.db.updateById('user_ecp_session', id, {
      sessionTokenEnc,
      expiresAt: formatDateTime(expiresAt),
      renewStatus: 'ACTIVE',
      lastRenewAt: now,
    });
  }

  async markFailed(id: number): Promise<void> {
    await this.db.updateById('user_ecp_session', id, { renewStatus: 'FAILED' });
  }

  async clearFailed(userId: number): Promise<void> {
    const row = await this.findByUserId(userId);
    if (row?.id != null && row.renewStatus === 'FAILED') {
      await this.db.updateById('user_ecp_session', row.id, { renewStatus: 'ACTIVE' });
    }
  }
}
