import type { Db } from '../db/db.js';

export interface DingtalkProgressCardRow {
  sessionId: number;
  botId: number;
  outTrackId: string;
  chatType: string;
  conversationId: string | null;
  senderUserid: string | null;
}

export function mapProgressCardRow(row: Record<string, unknown>): DingtalkProgressCardRow | null {
  const sessionId = Number(row.sessionId ?? row.session_id);
  const botId = Number(row.botId ?? row.bot_id);
  const outTrackId = String(row.outTrackId ?? row.out_track_id ?? '');
  if (!Number.isFinite(sessionId) || sessionId <= 0 || !Number.isFinite(botId) || botId <= 0 || outTrackId === '') return null;
  const conversationRaw = row.conversationId ?? row.conversation_id;
  const senderRaw = row.senderUserid ?? row.sender_userid;
  return {
    sessionId,
    botId,
    outTrackId,
    chatType: String(row.chatType ?? row.chat_type ?? ''),
    conversationId: conversationRaw == null ? null : String(conversationRaw),
    senderUserid: senderRaw == null ? null : String(senderRaw),
  };
}

export class MysqlDingtalkProgressCardRepository {
  constructor(private readonly db: Db) {}

  async upsert(row: DingtalkProgressCardRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO dingtalk_progress_card (session_id, bot_id, out_track_id, chat_type, conversation_id, sender_userid)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE bot_id = VALUES(bot_id), out_track_id = VALUES(out_track_id),
         chat_type = VALUES(chat_type), conversation_id = VALUES(conversation_id), sender_userid = VALUES(sender_userid)`,
      [row.sessionId, row.botId, row.outTrackId, row.chatType, row.conversationId, row.senderUserid],
    );
  }

  async findBySessionId(sessionId: number): Promise<DingtalkProgressCardRow | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      'SELECT session_id, bot_id, out_track_id, chat_type, conversation_id, sender_userid FROM dingtalk_progress_card WHERE session_id = ? LIMIT 1',
      [sessionId],
    );
    return row == null ? null : mapProgressCardRow(row);
  }

  async findByOutTrackId(outTrackId: string): Promise<DingtalkProgressCardRow | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      'SELECT session_id, bot_id, out_track_id, chat_type, conversation_id, sender_userid FROM dingtalk_progress_card WHERE out_track_id = ? LIMIT 1',
      [outTrackId],
    );
    return row == null ? null : mapProgressCardRow(row);
  }

  async deleteBySessionId(sessionId: number): Promise<void> {
    await this.db.execute('DELETE FROM dingtalk_progress_card WHERE session_id = ?', [sessionId]);
  }
}
