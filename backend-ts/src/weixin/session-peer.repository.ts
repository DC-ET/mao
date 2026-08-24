import type { Db } from '../db/db.js';

export class WeixinSessionPeerRepository {
  constructor(private readonly db: Db) {}

  async save(sessionId: number, wxUserId: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO weixin_session_peer (session_id, wx_user_id) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE wx_user_id = VALUES(wx_user_id)`,
      [sessionId, wxUserId],
    );
  }

  async findBySessionId(sessionId: number): Promise<string | undefined> {
    const row = await this.db.queryOne<{ wxUserId: string }>(
      `SELECT wx_user_id FROM weixin_session_peer WHERE session_id = ? LIMIT 1`,
      [sessionId],
    );
    return row?.wxUserId;
  }
}
