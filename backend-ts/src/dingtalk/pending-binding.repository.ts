import type { Db } from '../db/db.js';
import type { DingtalkNormalizedMessage } from './types.js';

export interface DingtalkPendingBindingMessage {
  state: string;
  botId: number;
  event: DingtalkNormalizedMessage;
  status?: string;
}

export class MysqlDingtalkPendingBindingRepository {
  constructor(private readonly db: Db) {}

  async insert(row: DingtalkPendingBindingMessage, expiresAt: Date): Promise<void> {
    await this.db.insert('dingtalk_pending_binding_message', {
      state: row.state,
      botId: row.botId,
      payload: JSON.stringify(row.event),
      status: row.status ?? 'PENDING',
      expiresAt,
    });
  }

  async markSent(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE dingtalk_pending_binding_message SET status = 'SENT' WHERE state = ? AND status = 'PENDING'",
      [state],
    );
  }

  async fail(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE dingtalk_pending_binding_message SET status = 'FAILED' WHERE state = ? AND status IN ('PENDING', 'SENT', 'CLAIMED')",
      [state],
    );
  }

  async complete(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE dingtalk_pending_binding_message SET status = 'COMPLETED' WHERE state = ? AND status = 'CLAIMED'",
      [state],
    );
  }

  async release(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE dingtalk_pending_binding_message SET status = 'SENT' WHERE state = ? AND status = 'CLAIMED'",
      [state],
    );
  }

  /**
   * 按 state 取待完成行（密码绑定预览用）：只认 SENT 且未过期（claim 同款口径）。
   * 不消费状态；claim 才是原子消费点。
   */
  async findByState(state: string): Promise<(DingtalkPendingBindingMessage & { expiresAt?: string | null }) | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      "SELECT * FROM dingtalk_pending_binding_message WHERE state = ? AND status = 'SENT' AND expires_at > CURRENT_TIMESTAMP LIMIT 1",
      [state],
    );
    if (row == null) return null;
    return {
      state: String(row.state),
      botId: Number(row.botId),
      event: JSON.parse(String(row.payload)) as DingtalkNormalizedMessage,
      status: 'SENT',
      expiresAt: row.expires_at == null ? null : String(row.expires_at),
    };
  }

  async claim(state: string): Promise<DingtalkPendingBindingMessage | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      "SELECT * FROM dingtalk_pending_binding_message WHERE state = ? AND status = 'SENT' AND expires_at > CURRENT_TIMESTAMP LIMIT 1",
      [state],
    );
    if (row == null) return null;
    const result = await this.db.execute(
      "UPDATE dingtalk_pending_binding_message SET status = 'CLAIMED' WHERE state = ? AND status = 'SENT' AND expires_at > CURRENT_TIMESTAMP",
      [state],
    );
    if (result.affectedRows !== 1) return null;
    return {
      state: String(row.state),
      botId: Number(row.botId),
      event: JSON.parse(String(row.payload)) as DingtalkNormalizedMessage,
      status: 'CLAIMED',
    };
  }
}
