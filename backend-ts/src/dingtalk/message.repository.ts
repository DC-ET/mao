import type { Db } from '../db/db.js';

export interface DingtalkConversation {
  id: number;
  botId: number;
  conversationId: string;
  chatType: 'p2p' | 'group';
  sessionId: number;
  ownerUserId: number;
  workspace?: string | null;
  title?: string | null;
}

export interface DingtalkGroupLog {
  id?: number;
  botId: number;
  conversationId: string;
  senderUserid: string;
  senderName: string;
  direction: 'IN' | 'OUT';
  content?: string | null;
  messageId?: string | null;
  createdAt?: string | null;
}

export class MysqlDingtalkMessageRepository {
  constructor(private readonly db: Db) {}

  findConversation(botId: number, conversationId: string): Promise<DingtalkConversation | null> {
    return this.db.queryOne<DingtalkConversation>(
      'SELECT * FROM dingtalk_chat WHERE bot_id = ? AND conversation_id = ? LIMIT 1',
      [botId, conversationId],
    );
  }

  async saveConversation(row: Omit<DingtalkConversation, 'id'>): Promise<DingtalkConversation> {
    await this.db.execute(
      `INSERT INTO dingtalk_chat (bot_id, conversation_id, chat_type, session_id, owner_user_id, workspace, title)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE session_id = VALUES(session_id), title = COALESCE(VALUES(title), title)`,
      [row.botId, row.conversationId, row.chatType, row.sessionId, row.ownerUserId, row.workspace ?? null, row.title ?? null],
    );
    const saved = await this.findConversation(row.botId, row.conversationId);
    if (saved == null) throw new Error('钉钉会话指针保存失败');
    return saved;
  }

  async addMember(botId: number, conversationId: string, userId: number, userid: string, displayName: string | null): Promise<void> {
    await this.db.execute(
      `INSERT IGNORE INTO dingtalk_chat_member (bot_id, conversation_id, user_id, userid, display_name)
       VALUES (?, ?, ?, ?, ?)`,
      [botId, conversationId, userId, userid, displayName],
    );
  }

  /**
   * CLAIMED 超过 10 分钟，或 FAILED，允许再次认领；DONE 直接丢弃。
   * affectedRows：插入 1，抢回更新 2，未变化 0。
   */
  async claimInboundMessage(botId: number, messageId: string, chatId: string | null): Promise<boolean> {
    const result = await this.db.execute(
      `INSERT INTO dingtalk_inbound_event (bot_id, message_id, chat_id, status)
       VALUES (?, ?, ?, 'CLAIMED')
       ON DUPLICATE KEY UPDATE
         status = IF(status = 'FAILED' OR (status = 'CLAIMED' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)), 'CLAIMED', status),
         updated_at = IF(status = 'FAILED' OR (status = 'CLAIMED' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)), CURRENT_TIMESTAMP, updated_at)`,
      [botId, messageId, chatId],
    );
    return Number(result.affectedRows ?? 0) > 0;
  }

  async releaseInboundMessage(botId: number, messageId: string): Promise<void> {
    await this.db.execute(
      `UPDATE dingtalk_inbound_event SET status = 'FAILED' WHERE bot_id = ? AND message_id = ? AND status = 'CLAIMED'`,
      [botId, messageId],
    );
  }

  async completeInboundMessage(botId: number, messageId: string): Promise<void> {
    await this.db.execute(
      `UPDATE dingtalk_inbound_event SET status = 'DONE' WHERE bot_id = ? AND message_id = ?`,
      [botId, messageId],
    );
  }

  async appendGroupMessage(message: DingtalkGroupLog): Promise<number> {
    if (message.messageId != null && message.messageId !== '' && message.direction === 'IN') {
      const existing = await this.db.queryOne<{ id: number }>(
        `SELECT id FROM dingtalk_group_message_log WHERE bot_id = ? AND conversation_id = ? AND message_id = ? AND direction = 'IN' LIMIT 1`,
        [message.botId, message.conversationId, message.messageId],
      );
      if (existing?.id != null) return existing.id;
    }
    return this.db.insert('dingtalk_group_message_log', {
      botId: message.botId,
      conversationId: message.conversationId,
      senderUserid: message.senderUserid,
      senderName: message.senderName,
      direction: message.direction,
      content: message.content ?? null,
      messageId: message.messageId ?? null,
    });
  }

  listGroupMessages(botId: number, conversationId: string, limit: number, maxMinutes: number): Promise<DingtalkGroupLog[]> {
    return this.db.query<DingtalkGroupLog>(
      `SELECT * FROM dingtalk_group_message_log
       WHERE bot_id = ? AND conversation_id = ? AND created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)
       ORDER BY id DESC LIMIT ?`,
      [botId, conversationId, maxMinutes, limit],
    );
  }
}
