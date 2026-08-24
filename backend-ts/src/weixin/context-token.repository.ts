import type { Db } from '../db/db.js';
import type { WeixinChannelContextToken } from './types.js';

const NOT_DELETED = 'deleted = 0';

export class ContextTokenRepository {
  constructor(private readonly db: Db) {}

  async saveOrUpdate(accountId: string, wxUserId: string, token: string): Promise<void> {
    const existing = await this.db.queryOne<WeixinChannelContextToken>(
      `SELECT * FROM weixin_channel_context_token WHERE account_id = ? AND wx_user_id = ? AND ${NOT_DELETED} LIMIT 1`,
      [accountId, wxUserId],
    );
    if (existing != null && existing.id != null) {
      existing.token = token;
      await this.db.updateById('weixin_channel_context_token', existing.id, { token });
    } else {
      await this.db.insert('weixin_channel_context_token', {
        accountId,
        wxUserId,
        token,
        deleted: 0,
      });
    }
  }

  async getLatestToken(accountId: string, wxUserId: string): Promise<string | null> {
    const row = await this.db.queryOne<WeixinChannelContextToken>(
      `SELECT * FROM weixin_channel_context_token WHERE account_id = ? AND wx_user_id = ? AND ${NOT_DELETED} LIMIT 1`,
      [accountId, wxUserId],
    );
    return row?.token ?? null;
  }

  async deleteByAccountId(accountId: string): Promise<void> {
    await this.db.execute(
      `UPDATE weixin_channel_context_token SET deleted = 1 WHERE account_id = ? AND ${NOT_DELETED}`,
      [accountId],
    );
    console.info(`删除账号的所有context_token, accountId=${accountId}`);
  }

  findByAccountId(accountId: string): Promise<WeixinChannelContextToken[]> {
    return this.db.query<WeixinChannelContextToken>(
      `SELECT * FROM weixin_channel_context_token WHERE account_id = ? AND ${NOT_DELETED} ORDER BY updated_at DESC, id DESC`,
      [accountId],
    );
  }
}
