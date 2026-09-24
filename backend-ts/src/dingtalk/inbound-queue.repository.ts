import type { Db } from '../db/db.js';
import type { DingtalkInboundQueueRow } from './types.js';

export class DingtalkInboundQueueRepository {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: (tx: DingtalkInboundQueueRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((txDb) => fn(new DingtalkInboundQueueRepository(txDb)));
  }

  async insert(row: Omit<DingtalkInboundQueueRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    return this.db.insert('dingtalk_inbound_queue', {
      botId: row.botId,
      sessionId: row.sessionId,
      messageId: row.messageId,
      outTrackId: row.outTrackId,
      senderUserid: row.senderUserid,
      maoUserId: row.maoUserId,
      rankNo: row.rankNo,
      status: row.status,
      payload: row.payload,
    });
  }

  async setOutTrackId(id: number, outTrackId: string): Promise<void> {
    await this.db.execute('UPDATE dingtalk_inbound_queue SET out_track_id = ? WHERE id = ?', [outTrackId, id]);
  }

  findById(id: number): Promise<DingtalkInboundQueueRow | null> {
    return this.db.queryOne<DingtalkInboundQueueRow>('SELECT * FROM dingtalk_inbound_queue WHERE id = ?', [id]);
  }

  findByOutTrackId(outTrackId: string): Promise<DingtalkInboundQueueRow | null> {
    return this.db.queryOne<DingtalkInboundQueueRow>(
      'SELECT * FROM dingtalk_inbound_queue WHERE out_track_id = ? ORDER BY id DESC LIMIT 1',
      [outTrackId],
    );
  }

  findByBotAndMessage(botId: number, messageId: string): Promise<DingtalkInboundQueueRow | null> {
    return this.db.queryOne<DingtalkInboundQueueRow>(
      'SELECT * FROM dingtalk_inbound_queue WHERE bot_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1',
      [botId, messageId],
    );
  }

  async claimNextQueued(sessionId: number): Promise<DingtalkInboundQueueRow | null> {
    for (;;) {
      const row = await this.db.queryOne<DingtalkInboundQueueRow>(
        "SELECT * FROM dingtalk_inbound_queue WHERE session_id = ? AND status = 'QUEUED' ORDER BY rank_no ASC, id ASC LIMIT 1",
        [sessionId],
      );
      if (row == null) return null;
      const result = await this.db.execute(
        'UPDATE dingtalk_inbound_queue SET status = ? WHERE id = ? AND status = ?',
        ['RUNNING', row.id, 'QUEUED'],
      );
      if (result.affectedRows === 1) return { ...row, status: 'RUNNING' };
    }
  }

  async cancelQueued(id: number): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE dingtalk_inbound_queue SET status = 'CANCELLED' WHERE id = ? AND status = 'QUEUED'",
      [id],
    );
    return result.affectedRows === 1;
  }

  async jumpToFront(id: number): Promise<boolean> {
    return this.transaction(async (tx) => {
      const row = await tx.findById(id);
      if (row == null || row.status !== 'QUEUED') return false;
      const minRank = await tx.findMinRankForUpdate(row.sessionId);
      const result = await tx.db.execute(
        "UPDATE dingtalk_inbound_queue SET rank_no = ? WHERE id = ? AND status = 'QUEUED'",
        [minRank - 1, id],
      );
      return result.affectedRows === 1;
    });
  }

  async deleteById(id: number): Promise<void> {
    await this.db.execute('DELETE FROM dingtalk_inbound_queue WHERE id = ?', [id]);
  }

  async findMaxRankForUpdate(sessionId: number): Promise<number> {
    const row = await this.db.queryOne<{ rankNo: number }>(
      "SELECT rank_no AS rankNo FROM dingtalk_inbound_queue WHERE session_id = ? AND status = 'QUEUED' ORDER BY rank_no DESC LIMIT 1 FOR UPDATE",
      [sessionId],
    );
    return row?.rankNo ?? 0;
  }

  async findMinRankForUpdate(sessionId: number): Promise<number> {
    const row = await this.db.queryOne<{ rankNo: number }>(
      "SELECT rank_no AS rankNo FROM dingtalk_inbound_queue WHERE session_id = ? AND status = 'QUEUED' ORDER BY rank_no ASC LIMIT 1 FOR UPDATE",
      [sessionId],
    );
    return row?.rankNo ?? 1;
  }

  listRecoverable(): Promise<DingtalkInboundQueueRow[]> {
    return this.db.query<DingtalkInboundQueueRow>(
      "SELECT * FROM dingtalk_inbound_queue WHERE status IN ('QUEUED', 'RUNNING')",
    );
  }

  countPending(sessionId: number): Promise<number> {
    return this.db.queryOne<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM dingtalk_inbound_queue WHERE session_id = ? AND status = 'QUEUED'",
      [sessionId],
    ).then((row) => Number(row?.cnt ?? 0));
  }

  listRunning(): Promise<DingtalkInboundQueueRow[]> {
    return this.db.query<DingtalkInboundQueueRow>("SELECT * FROM dingtalk_inbound_queue WHERE status = 'RUNNING'");
  }

  async resetRunningToQueued(id: number): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE dingtalk_inbound_queue SET status = 'QUEUED' WHERE id = ? AND status = 'RUNNING'",
      [id],
    );
    return result.affectedRows === 1;
  }

  async findPersistedMessageByQueueId(sessionId: number, queueId: number): Promise<{ id: number } | null> {
    return this.db.queryOne<{ id: number }>(
      'SELECT id FROM `message` WHERE session_id = ? AND role = ? AND JSON_UNQUOTE(JSON_EXTRACT(metadata, ?)) = ? AND deleted = 0 LIMIT 1',
      [sessionId, 'USER', '$.dingtalkQueueId', String(queueId)],
    );
  }

  async deleteTerminal(): Promise<number> {
    const result = await this.db.execute("DELETE FROM dingtalk_inbound_queue WHERE status = 'CANCELLED'");
    return result.affectedRows;
  }
}
