import type { Db } from '../db/db.js';
import type { FeishuInboundQueueRow } from './types.js';

/** feishu_inbound_queue 表的 CRUD + CAS 状态变更。 */
export class FeishuInboundQueueRepository {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: (tx: FeishuInboundQueueRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((txDb) => fn(new FeishuInboundQueueRepository(txDb)));
  }

  async insert(row: Omit<FeishuInboundQueueRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    return this.db.insert('feishu_inbound_queue', {
      botId: row.botId,
      sessionId: row.sessionId,
      messageId: row.messageId,
      cardMessageId: row.cardMessageId,
      senderOpenId: row.senderOpenId,
      maoUserId: row.maoUserId,
      rankNo: row.rankNo,
      status: row.status,
      payload: row.payload,
    });
  }

  async setCardMessageId(id: number, cardMessageId: string): Promise<void> {
    await this.db.execute(
      'UPDATE feishu_inbound_queue SET card_message_id = ? WHERE id = ?',
      [cardMessageId, id],
    );
  }

  findById(id: number): Promise<FeishuInboundQueueRow | null> {
    return this.db.queryOne<FeishuInboundQueueRow>(
      'SELECT * FROM feishu_inbound_queue WHERE id = ?',
      [id],
    );
  }

  findByCardMessageId(cardMessageId: string): Promise<FeishuInboundQueueRow | null> {
    return this.db.queryOne<FeishuInboundQueueRow>(
      'SELECT * FROM feishu_inbound_queue WHERE card_message_id = ? ORDER BY id DESC LIMIT 1',
      [cardMessageId],
    );
  }

  findByBotAndMessage(botId: number, messageId: string): Promise<FeishuInboundQueueRow | null> {
    return this.db.queryOne<FeishuInboundQueueRow>(
      'SELECT * FROM feishu_inbound_queue WHERE bot_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1',
      [botId, messageId],
    );
  }

  /** CAS: status QUEUED → RUNNING，保证只有一方认领成功。 */
  async claimNextQueued(sessionId: number): Promise<FeishuInboundQueueRow | null> {
    const row = await this.db.queryOne<FeishuInboundQueueRow>(
      "SELECT * FROM feishu_inbound_queue WHERE session_id = ? AND status = 'QUEUED' ORDER BY rank_no ASC, id ASC LIMIT 1",
      [sessionId],
    );
    if (row == null) return null;
    const result = await this.db.execute(
      'UPDATE feishu_inbound_queue SET status = ? WHERE id = ? AND status = ?',
      ['RUNNING', row.id, 'QUEUED'],
    );
    if (result.affectedRows !== 1) return null;
    return { ...row, status: 'RUNNING' };
  }

  /** CAS: status QUEUED → CANCELLED。 */
  async cancelQueued(id: number): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE feishu_inbound_queue SET status = 'CANCELLED' WHERE id = ? AND status = 'QUEUED'",
      [id],
    );
    return result.affectedRows === 1;
  }

  /** 事务化 CAS：将 QUEUED 行的 rank_no 调整为会话内最小 rank-1（跳队首），并锁定顺序保证并发下严格单调。 */
  async jumpToFront(id: number): Promise<boolean> {
    return this.transaction(async (tx) => {
      const row = await tx.findById(id);
      if (row == null || row.status !== 'QUEUED') return false;
      const minRank = await tx.findMinRankForUpdate(row.sessionId);
      const result = await tx.db.execute(
        "UPDATE feishu_inbound_queue SET rank_no = ? WHERE id = ? AND status = 'QUEUED'",
        [minRank - 1, id],
      );
      return result.affectedRows === 1;
    });
  }

  async deleteById(id: number): Promise<void> {
    await this.db.execute('DELETE FROM feishu_inbound_queue WHERE id = ?', [id]);
  }

  async findMaxRankForUpdate(sessionId: number): Promise<number> {
    const row = await this.db.queryOne<{ rankNo: number }>(
      "SELECT rank_no AS rankNo FROM feishu_inbound_queue WHERE session_id = ? AND status = 'QUEUED' ORDER BY rank_no DESC LIMIT 1 FOR UPDATE",
      [sessionId],
    );
    return row?.rankNo ?? 0;
  }

  async findMinRankForUpdate(sessionId: number): Promise<number> {
    const row = await this.db.queryOne<{ rankNo: number }>(
      "SELECT rank_no AS rankNo FROM feishu_inbound_queue WHERE session_id = ? AND status = 'QUEUED' ORDER BY rank_no ASC LIMIT 1 FOR UPDATE",
      [sessionId],
    );
    return row?.rankNo ?? 1;
  }

  listRecoverable(): Promise<FeishuInboundQueueRow[]> {
    return this.db.query<FeishuInboundQueueRow>(
      "SELECT * FROM feishu_inbound_queue WHERE status IN ('QUEUED', 'RUNNING')",
    );
  }

  countPending(sessionId: number): Promise<number> {
    return this.db.queryOne<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM feishu_inbound_queue WHERE session_id = ? AND status = 'QUEUED'",
      [sessionId],
    ).then((row) => row?.cnt ?? 0);
  }

  /** 列出当前所有 RUNNING 行（供 hydrate 逐行判定消息是否已落库）。 */
  listRunning(): Promise<FeishuInboundQueueRow[]> {
    return this.db.query<FeishuInboundQueueRow>(
      "SELECT * FROM feishu_inbound_queue WHERE status = 'RUNNING'",
    );
  }

  /** CAS: 将单条 RUNNING 行复位为 QUEUED（用于崩溃在该消息落库之前时重新消费，避免丢消息）。 */
  async resetRunningToQueued(id: number): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE feishu_inbound_queue SET status = 'QUEUED' WHERE id = ? AND status = 'RUNNING'",
      [id],
    );
    return result.affectedRows === 1;
  }

  /** 判定某队列行对应的用户消息是否已写入会话历史（通过写消息时注入的 metadata 标记 feishuQueueId）。 */
  async findPersistedMessageByQueueId(sessionId: number, queueId: number): Promise<{ id: number } | null> {
    return this.db.queryOne<{ id: number }>(
      'SELECT id FROM `message` WHERE session_id = ? AND role = ? AND JSON_UNQUOTE(JSON_EXTRACT(metadata, ?)) = ? AND deleted = 0 LIMIT 1',
      [sessionId, 'USER', '$.feishuQueueId', String(queueId)],
    );
  }

  async deleteTerminal(): Promise<number> {
    const result = await this.db.execute(
      "DELETE FROM feishu_inbound_queue WHERE status IN ('CANCELLED')",
    );
    return result.affectedRows;
  }
}
