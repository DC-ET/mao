import type { Db } from '../db/db.js';
import type { FeishuNormalizedMessage } from './types.js';

export interface FeishuPendingBindingMessage {
  id?: number;
  state: string;
  appId: number;
  messageId: string;
  cardMessageId?: string | null;
  event: FeishuNormalizedMessage;
  status?: string;
}

export class MysqlFeishuPendingBindingRepository {
  constructor(private readonly db: Db) {}

  async insert(row: FeishuPendingBindingMessage): Promise<void> {
    await this.db.insert('feishu_pending_binding_message', {
      state: row.state,
      appId: row.appId,
      messageId: row.messageId,
      cardMessageId: row.cardMessageId ?? null,
      eventJson: JSON.stringify(row.event),
      status: row.status ?? 'PENDING',
    });
  }

  async setCardMessageId(state: string, cardMessageId: string): Promise<void> {
    const result = await this.db.execute(
      "UPDATE feishu_pending_binding_message SET card_message_id = ?, status = 'SENT' WHERE state = ? AND status = 'PENDING'",
      [cardMessageId, state],
    );
    if (result.affectedRows !== 1) throw new Error('飞书绑定卡片状态更新失败');
  }

  async fail(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE feishu_pending_binding_message SET status = 'FAILED' WHERE state = ? AND status IN ('PENDING', 'SENT')",
      [state],
    );
  }

  async release(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE feishu_pending_binding_message SET status = 'SENT' WHERE state = ? AND status = 'CLAIMED'",
      [state],
    );
  }

  async complete(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE feishu_pending_binding_message SET status = 'COMPLETED' WHERE state = ? AND status = 'CLAIMED'",
      [state],
    );
  }

  async listRecoverable(): Promise<FeishuPendingBindingMessage[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM feishu_pending_binding_message WHERE status = 'SENT' OR (status = 'CLAIMED' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE))",
    );
    return rows.map((row) => ({
      id: Number(row.id), state: String(row.state), appId: Number(row.appId), messageId: String(row.messageId),
      cardMessageId: row.cardMessageId == null ? null : String(row.cardMessageId),
      event: JSON.parse(String(row.eventJson)) as FeishuNormalizedMessage, status: String(row.status),
    }));
  }

  async claim(state: string): Promise<FeishuPendingBindingMessage | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      "SELECT * FROM feishu_pending_binding_message WHERE state = ? AND (status = 'SENT' OR (status = 'CLAIMED' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE))) LIMIT 1", [state],
    );
    if (row == null) return null;
    const result = await this.db.execute(
      "UPDATE feishu_pending_binding_message SET status = 'CLAIMED' WHERE state = ? AND (status = 'SENT' OR (status = 'CLAIMED' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)))", [state],
    );
    if (result.affectedRows !== 1) return null;
    return {
      id: Number(row.id), state: String(row.state), appId: Number(row.appId), messageId: String(row.messageId),
      cardMessageId: row.cardMessageId == null ? null : String(row.cardMessageId),
      event: JSON.parse(String(row.eventJson)) as FeishuNormalizedMessage, status: 'CLAIMED',
    };
  }
}
