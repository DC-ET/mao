import { randomBytes } from 'node:crypto';
import type { Db } from '../db/db.js';
import { nowSql } from '../common/datetime.js';

export interface SessionShareRow {
  id: number;
  sessionId: number;
  shareToken: string;
  messageWatermark: number;
  createdBy: number;
  viewCount: number;
  lastViewedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface SessionShareStore {
  transaction<T>(fn: (tx: SessionShareStore) => Promise<T>): Promise<T>;
  /** 锁定该会话全部分享行（含已撤销），空结果也持有间隙锁，避免并发双建。 */
  lockBySession(sessionId: number): Promise<SessionShareRow[]>;
  findActiveBySession(sessionId: number): Promise<SessionShareRow | null>;
  findByToken(token: string): Promise<SessionShareRow | null>;
  insert(row: {
    sessionId: number;
    shareToken: string;
    messageWatermark: number;
    createdBy: number;
    viewCount: number;
    expiresAt?: string | null;
  }): Promise<number>;
  updateWatermark(id: number, watermark: number): Promise<void>;
  revoke(id: number, revokedAt: string): Promise<void>;
  incrementView(id: number, viewedAt: string): Promise<void>;
}

export function newShareToken(): string {
  return randomBytes(32).toString('hex');
}

export class MysqlSessionShareRepository implements SessionShareStore {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: (tx: SessionShareStore) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new MysqlSessionShareRepository(tx)));
  }

  lockBySession(sessionId: number): Promise<SessionShareRow[]> {
    return this.db.query<SessionShareRow>(
      'SELECT * FROM session_share WHERE session_id = ? ORDER BY id ASC FOR UPDATE',
      [sessionId],
    );
  }

  findActiveBySession(sessionId: number): Promise<SessionShareRow | null> {
    return this.db.queryOne<SessionShareRow>(
      'SELECT * FROM session_share WHERE session_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1',
      [sessionId],
    );
  }

  findByToken(token: string): Promise<SessionShareRow | null> {
    return this.db.queryOne<SessionShareRow>(
      'SELECT * FROM session_share WHERE share_token = ? LIMIT 1',
      [token],
    );
  }

  insert(row: {
    sessionId: number;
    shareToken: string;
    messageWatermark: number;
    createdBy: number;
    viewCount: number;
    expiresAt?: string | null;
  }): Promise<number> {
    return this.db.insert('session_share', {
      sessionId: row.sessionId,
      shareToken: row.shareToken,
      messageWatermark: row.messageWatermark,
      createdBy: row.createdBy,
      viewCount: row.viewCount,
      expiresAt: row.expiresAt ?? null,
    });
  }

  async updateWatermark(id: number, watermark: number): Promise<void> {
    await this.db.execute(
      'UPDATE session_share SET message_watermark = ? WHERE id = ? AND revoked_at IS NULL',
      [watermark, id],
    );
  }

  async revoke(id: number, revokedAt: string): Promise<void> {
    await this.db.execute(
      'UPDATE session_share SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      [revokedAt, id],
    );
  }

  async incrementView(id: number, viewedAt: string): Promise<void> {
    await this.db.execute(
      'UPDATE session_share SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?',
      [viewedAt, id],
    );
  }
}

export function isDuplicateKey(err: unknown): boolean {
  if (typeof err !== 'object' || err == null) return false;
  const code = (err as { code?: string; errno?: number }).code;
  const errno = (err as { errno?: number }).errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

export { nowSql };
