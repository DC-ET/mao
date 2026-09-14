import type { Db } from '../db/db.js';

/** 会话当前活跃的飞书进度卡片（崩溃恢复后续更卡片的关键映射）。 */
export interface FeishuProgressCardRow {
  sessionId: number;
  botId: number;
  cardMessageId: string;
  chatType: string;
  chatId: string | null;
  senderOpenId: string | null;
}

export interface FeishuProgressCardRepository {
  upsert(row: FeishuProgressCardRow): Promise<void>;
  findBySessionId(sessionId: number): Promise<FeishuProgressCardRow | null>;
  deleteBySessionId(sessionId: number): Promise<void>;
}

/** Db.query / queryOne 已 toCamel；兼容未转换的 snake_case 行。字段不全视为无映射。 */
export function mapProgressCardRow(row: Record<string, unknown>): FeishuProgressCardRow | null {
  const sessionId = Number(row.sessionId ?? row.session_id);
  const botId = Number(row.botId ?? row.bot_id);
  const cardMessageId = String(row.cardMessageId ?? row.card_message_id ?? '');
  if (!Number.isFinite(sessionId) || sessionId <= 0 || !Number.isFinite(botId) || botId <= 0 || cardMessageId === '') {
    return null;
  }
  const chatIdRaw = row.chatId ?? row.chat_id;
  const senderRaw = row.senderOpenId ?? row.sender_open_id;
  return {
    sessionId,
    botId,
    cardMessageId,
    chatType: String(row.chatType ?? row.chat_type ?? ''),
    chatId: chatIdRaw == null ? null : String(chatIdRaw),
    senderOpenId: senderRaw == null ? null : String(senderRaw),
  };
}

export class MysqlFeishuProgressCardRepository implements FeishuProgressCardRepository {
  constructor(private readonly db: Db) {}

  async upsert(row: FeishuProgressCardRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO feishu_progress_card (session_id, bot_id, card_message_id, chat_type, chat_id, sender_open_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE bot_id = VALUES(bot_id), card_message_id = VALUES(card_message_id),
         chat_type = VALUES(chat_type), chat_id = VALUES(chat_id), sender_open_id = VALUES(sender_open_id)`,
      [row.sessionId, row.botId, row.cardMessageId, row.chatType, row.chatId, row.senderOpenId],
    );
  }

  async findBySessionId(sessionId: number): Promise<FeishuProgressCardRow | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      'SELECT session_id, bot_id, card_message_id, chat_type, chat_id, sender_open_id FROM feishu_progress_card WHERE session_id = ? LIMIT 1',
      [sessionId],
    );
    if (row == null) return null;
    return mapProgressCardRow(row);
  }

  async deleteBySessionId(sessionId: number): Promise<void> {
    await this.db.execute('DELETE FROM feishu_progress_card WHERE session_id = ?', [sessionId]);
  }
}
