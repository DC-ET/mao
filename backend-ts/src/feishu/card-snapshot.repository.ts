import type { Db } from '../db/db.js';

/** 飞书完成卡终态快照行：一张 COMPLETED 卡片对应一条（点踩归属与重绘的数据源）。 */
export interface FeishuCardSnapshotRow {
  cardMessageId: string;
  sessionId: number;
  botId: number;
  messageId: number;
  status: string;
  round: number;
  elapsedMs: number;
  content: string | null;
}

export interface FeishuCardSnapshotRepository {
  upsert(row: FeishuCardSnapshotRow): Promise<void>;
  findByCardMessageId(cardMessageId: string): Promise<FeishuCardSnapshotRow | null>;
}

/** Db.query / queryOne 已 toCamel；兼容未转换的 snake_case 行。主键字段不全视为无映射。 */
export function mapCardSnapshotRow(row: Record<string, unknown>): FeishuCardSnapshotRow | null {
  const cardMessageId = String(row.cardMessageId ?? row.card_message_id ?? '');
  const sessionId = Number(row.sessionId ?? row.session_id);
  const botId = Number(row.botId ?? row.bot_id);
  const messageId = Number(row.messageId ?? row.message_id);
  if (cardMessageId === '' || !Number.isFinite(sessionId) || sessionId <= 0
    || !Number.isFinite(botId) || botId <= 0 || !Number.isFinite(messageId) || messageId <= 0) {
    return null;
  }
  const contentRaw = row.content;
  const round = Number(row.round ?? 0);
  const elapsedMs = Number(row.elapsedMs ?? row.elapsed_ms ?? 0);
  return {
    cardMessageId,
    sessionId,
    botId,
    messageId,
    status: String(row.status ?? 'COMPLETED'),
    round: Number.isFinite(round) ? Math.max(0, Math.floor(round)) : 0,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs)) : 0,
    content: contentRaw == null ? null : String(contentRaw),
  };
}

export class MysqlFeishuCardSnapshotRepository implements FeishuCardSnapshotRepository {
  constructor(private readonly db: Db) {}

  async upsert(row: FeishuCardSnapshotRow): Promise<void> {
    // uk 在 card_message_id：重试为同一张卡重新完成时覆盖旧快照（消息/轮次/耗时不一致）。
    await this.db.execute(
      `INSERT INTO feishu_card_snapshot (card_message_id, session_id, bot_id, message_id, status, round, elapsed_ms, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE session_id = VALUES(session_id), bot_id = VALUES(bot_id),
         message_id = VALUES(message_id), status = VALUES(status), round = VALUES(round),
         elapsed_ms = VALUES(elapsed_ms), content = VALUES(content)`,
      [row.cardMessageId, row.sessionId, row.botId, row.messageId, row.status, row.round, row.elapsedMs, row.content],
    );
  }

  async findByCardMessageId(cardMessageId: string): Promise<FeishuCardSnapshotRow | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      'SELECT card_message_id, session_id, bot_id, message_id, status, round, elapsed_ms, content FROM feishu_card_snapshot WHERE card_message_id = ? LIMIT 1',
      [cardMessageId],
    );
    if (row == null) return null;
    return mapCardSnapshotRow(row);
  }
}
