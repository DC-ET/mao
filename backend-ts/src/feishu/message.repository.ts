import type { Db } from '../db/db.js';

export interface FeishuConversation {
  id: number;
  appId: string;
  chatId: string;
  sessionId: number;
  ownerUserId: number;
  workspace?: string | null;
  /** 群聊上下文增量注入水位线：上次已注入的最大群消息 log id。 */
  lastContextLogId?: number | null;
}

export interface FeishuGroupMessage {
  id?: number;
  appId: string;
  chatId: string;
  senderOpenId: string;
  senderName: string;
  msgType?: string;
  content?: string | null;
  fileKey?: string | null;
  fileName?: string | null;
  messageId?: string | null;
  isMention: boolean;
  createdAt?: string | null;
}

export interface FeishuMessageRepository {
  findP2pConversation(appId: string, userOpenId: string, userId?: number): Promise<FeishuConversation | null>;
  findGroupConversation(appId: string, chatId: string, ownerUserId?: number): Promise<FeishuConversation | null>;
  /** 按会话 ID 反查飞书会话（工具层用于定位会话所属 bot）。 */
  findConversationBySessionId(sessionId: number): Promise<FeishuConversation | null>;
  /** 按消息 ID 查询群消息中的媒体元数据（下载工具用）。 */
  findMediaByMessageId(messageId: string): Promise<{ appId: string; fileKey: string | null; fileName: string | null; msgType: string | null } | null>;
  /** 按消息 ID 查询群消息完整记录（引用消息内容预取优先走日志，免 API 调用）。 */
  findGroupMessageByMessageId(appId: string, chatId: string, messageId: string): Promise<FeishuGroupMessage | null>;
  saveConversation(conversation: Omit<FeishuConversation, 'id'>): Promise<FeishuConversation>;
  claimInboundMessage(appId: string, messageId: string, eventId: string | null, chatId: string | null): Promise<boolean>;
  releaseInboundMessage(appId: string, messageId: string): Promise<void>;
  completeInboundMessage(appId: string, messageId: string): Promise<void>;
  appendGroupMessage(message: FeishuGroupMessage): Promise<number>;
  listGroupMessages(appId: string, chatId: string, limit: number, maxMinutes?: number): Promise<FeishuGroupMessage[]>;
  /** 推进群聊上下文增量注入水位线（只前进不后退）。 */
  updateGroupContextWatermark(appId: string, chatId: string, logId: number): Promise<void>;
  isGroupMember(appId: string, chatId: string, userId: number): Promise<boolean>;
  addGroupMember(appId: string, chatId: string, userId: number, openId: string, displayName: string): Promise<void>;
}

/** Persistence boundary for Feishu conversations. Session creation is deliberately
 * supplied by the caller because this module must not depend on create-app. */
export class MysqlFeishuMessageRepository implements FeishuMessageRepository {
  constructor(private readonly db: Db) {}

  findP2pConversation(appId: string, userOpenId: string, userId?: number): Promise<FeishuConversation | null> {
    return this.findGroupConversation(appId, `p2p:${userOpenId}`, userId);
  }

  findGroupConversation(appId: string, chatId: string, ownerUserId?: number): Promise<FeishuConversation | null> {
    const sql = ownerUserId == null
      ? 'SELECT * FROM feishu_chat WHERE app_id = ? AND chat_id = ? LIMIT 1'
      : 'SELECT * FROM feishu_chat WHERE app_id = ? AND chat_id = ? AND owner_user_id = ? LIMIT 1';
    const params = ownerUserId == null ? [appId, chatId] : [appId, chatId, ownerUserId];
    return this.db.queryOne<FeishuConversation>(sql, params);
  }

  findConversationBySessionId(sessionId: number): Promise<FeishuConversation | null> {
    return this.db.queryOne<FeishuConversation>('SELECT * FROM feishu_chat WHERE session_id = ? LIMIT 1', [sessionId]);
  }

  findMediaByMessageId(messageId: string): Promise<{ appId: string; fileKey: string | null; fileName: string | null; msgType: string | null } | null> {
    return this.db.queryOne(
      'SELECT app_id, file_key, file_name, msg_type FROM feishu_group_message_log WHERE message_id = ? AND file_key IS NOT NULL LIMIT 1',
      [messageId],
    );
  }

  findGroupMessageByMessageId(appId: string, chatId: string, messageId: string): Promise<FeishuGroupMessage | null> {
    return this.db.queryOne<FeishuGroupMessage>(
      'SELECT * FROM feishu_group_message_log WHERE app_id = ? AND chat_id = ? AND message_id = ? LIMIT 1',
      [appId, chatId, messageId],
    );
  }

  async saveConversation(conversation: Omit<FeishuConversation, 'id'>): Promise<FeishuConversation> {
    await this.db.execute(
      `INSERT INTO feishu_chat (app_id, chat_id, session_id, owner_user_id, workspace)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE session_id = VALUES(session_id), owner_user_id = VALUES(owner_user_id), workspace = VALUES(workspace)`,
      [conversation.appId, conversation.chatId, conversation.sessionId, conversation.ownerUserId, conversation.workspace ?? null],
    );
    const saved = await this.findGroupConversation(conversation.appId, conversation.chatId);
    if (saved == null) throw new Error('Failed to save Feishu conversation');
    return saved;
  }

  async claimInboundMessage(appId: string, messageId: string, eventId: string | null, chatId: string | null): Promise<boolean> {
    const result = await this.db.execute(
      `INSERT INTO feishu_inbound_event (app_id, message_id, event_id, chat_id, status)
       VALUES (?, ?, ?, ?, 'CLAIMED')
       ON DUPLICATE KEY UPDATE
         status = IF(status = 'FAILED' OR (status = 'CLAIMED' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)), 'CLAIMED', status),
         updated_at = IF(status = 'FAILED' OR (status = 'CLAIMED' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)), CURRENT_TIMESTAMP, updated_at)`, [appId, messageId, eventId, chatId],
    );
    return Number(result.affectedRows ?? 0) > 0;
  }

  async releaseInboundMessage(appId: string, messageId: string): Promise<void> {
    await this.db.execute(
      `UPDATE feishu_inbound_event SET status = 'FAILED' WHERE app_id = ? AND message_id = ? AND status = 'CLAIMED'`,
      [appId, messageId],
    );
  }

  async completeInboundMessage(appId: string, messageId: string): Promise<void> {
    await this.db.execute(
      `UPDATE feishu_inbound_event SET status = 'DONE' WHERE app_id = ? AND message_id = ?`,
      [appId, messageId],
    );
  }

  async appendGroupMessage(message: FeishuGroupMessage): Promise<number> {
    if (message.messageId == null || message.messageId === '') throw new Error('Feishu group message requires messageId');
    await this.db.execute(
      `INSERT IGNORE INTO feishu_group_message_log
       (app_id, chat_id, sender_open_id, sender_name, msg_type, content, file_key, file_name, message_id, is_mention)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [message.appId, message.chatId, message.senderOpenId, message.senderName, message.msgType ?? 'text', message.content ?? null,
        message.fileKey ?? null, message.fileName ?? null, message.messageId, message.isMention ? 1 : 0],
    );
    const saved = await this.db.queryOne<{ id?: number }>(
      'SELECT id FROM feishu_group_message_log WHERE app_id = ? AND chat_id = ? AND message_id = ? LIMIT 1',
      [message.appId, message.chatId, message.messageId],
    );
    if (saved?.id == null) throw new Error('Failed to record Feishu group message');
    return Number(saved.id);
  }

  async isGroupMember(appId: string, chatId: string, userId: number): Promise<boolean> {
    const row = await this.db.queryOne<{ id?: number }>(
      'SELECT id FROM feishu_chat_member WHERE app_id = ? AND chat_id = ? AND user_id = ? LIMIT 1', [appId, chatId, userId],
    );
    return row != null;
  }

  async addGroupMember(appId: string, chatId: string, userId: number, openId: string, displayName: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO feishu_chat_member (app_id, chat_id, user_id, open_id, display_name)
       VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), display_name = VALUES(display_name)`,
      [appId, chatId, userId, openId, displayName],
    );
  }

  listGroupMessages(appId: string, chatId: string, limit: number, maxMinutes = 120): Promise<FeishuGroupMessage[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const safeMinutes = Math.max(1, Math.min(10080, Math.floor(maxMinutes)));
    return this.db.query<FeishuGroupMessage>(
      `SELECT * FROM feishu_group_message_log WHERE app_id = ? AND chat_id = ?
       AND created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${safeMinutes} MINUTE)
       ORDER BY created_at DESC, id DESC LIMIT ${safeLimit}`, [appId, chatId],
    ).then((rows) => rows.reverse());
  }

  async updateGroupContextWatermark(appId: string, chatId: string, logId: number): Promise<void> {
    await this.db.execute(
      'UPDATE feishu_chat SET last_context_log_id = GREATEST(last_context_log_id, ?) WHERE app_id = ? AND chat_id = ?',
      [logId, appId, chatId],
    );
  }
}
