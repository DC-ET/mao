import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { MessageQueue } from './types.js';

export class MessageQueueRepository {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: (tx: MessageQueueRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((txDb) => fn(new MessageQueueRepository(txDb)));
  }

  findLastPendingForUpdate(sessionId: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order DESC, id DESC LIMIT 1 FOR UPDATE`,
      [sessionId],
    );
  }

  findFirstPendingForUpdate(sessionId: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order ASC, id ASC LIMIT 1 FOR UPDATE`,
      [sessionId],
    );
  }

  findById(id: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(`SELECT * FROM message_queue WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  async insert(item: MessageQueue): Promise<number> {
    const id = await this.db.insert('message_queue', {
      sessionId: item.sessionId,
      userId: item.userId,
      content: item.content,
      images: item.images,
      sortOrder: item.sortOrder,
      status: item.status ?? 'PENDING',
      deleted: 0,
    });
    item.id = id;
    return id;
  }

  async updateById(item: MessageQueue): Promise<void> {
    if (item.id == null) {
      return;
    }
    await this.db.updateById('message_queue', item.id, {
      content: item.content,
      images: item.images,
      sortOrder: item.sortOrder,
      status: item.status,
    });
  }

  findLastPending(sessionId: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order DESC, id DESC LIMIT 1`,
      [sessionId],
    );
  }

  findHeadPending(sessionId: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order ASC, id ASC LIMIT 1`,
      [sessionId],
    );
  }

  findNeighborUp(sessionId: number, sortOrder: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} AND sort_order < ? ORDER BY sort_order DESC, id DESC LIMIT 1`,
      [sessionId, sortOrder],
    );
  }

  findNeighborDown(sessionId: number, sortOrder: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} AND sort_order > ? ORDER BY sort_order ASC, id ASC LIMIT 1`,
      [sessionId, sortOrder],
    );
  }

  listPending(sessionId: number): Promise<MessageQueue[]> {
    return this.db.query<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order ASC, id ASC`,
      [sessionId],
    );
  }

  async clearPending(sessionId: number): Promise<void> {
    await this.db.execute(
      `UPDATE message_queue SET status = 'DELETED' WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()}`,
      [sessionId],
    );
  }
}
