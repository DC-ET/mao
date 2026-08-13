import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Db } from '../db/db.js';
import type { BindingStatus, WeixinChannelAccount } from './types.js';

const NOT_DELETED = 'deleted = 0';

export class WeixinAccountRepository {
  constructor(private readonly db: Db) {}

  findByUserId(userId: number): Promise<WeixinChannelAccount | null> {
    return this.db.queryOne<WeixinChannelAccount>(
      `SELECT * FROM weixin_channel_account WHERE user_id = ? AND enabled = 1 AND ${NOT_DELETED} LIMIT 1`,
      [userId],
    );
  }

  findByAccountId(accountId: string): Promise<WeixinChannelAccount | null> {
    return this.db.queryOne<WeixinChannelAccount>(
      `SELECT * FROM weixin_channel_account WHERE account_id = ? AND enabled = 1 AND ${NOT_DELETED} LIMIT 1`,
      [accountId],
    );
  }

  findById(id: number): Promise<WeixinChannelAccount | null> {
    return this.db.queryOne<WeixinChannelAccount>(
      `SELECT * FROM weixin_channel_account WHERE id = ? AND ${NOT_DELETED}`,
      [id],
    );
  }

  async create(account: WeixinChannelAccount): Promise<number> {
    const id = await this.db.insert('weixin_channel_account', {
      userId: account.userId,
      accountId: account.accountId,
      payloadJson: account.payloadJson,
      getUpdatesBuf: account.getUpdatesBuf ?? null,
      enabled: account.enabled ?? 1,
      deleted: 0,
    });
    account.id = id;
    return id;
  }

  async update(account: WeixinChannelAccount): Promise<void> {
    if (account.id == null) return;
    await this.db.updateById('weixin_channel_account', account.id, {
      userId: account.userId,
      accountId: account.accountId,
      payloadJson: account.payloadJson,
      getUpdatesBuf: account.getUpdatesBuf,
      enabled: account.enabled,
    });
  }

  async getBindingStatus(userId: number): Promise<BindingStatus> {
    const account = await this.findByUserId(userId);
    if (account == null) {
      return { bound: false };
    }
    try {
      const payload = JSON.parse(account.payloadJson ?? '{}') as { userId?: string; savedAt?: string };
      const ilinkUserId = payload.userId ?? null;
      const savedAt = payload.savedAt ?? null;
      return { bound: true, accountId: ilinkUserId, boundAt: savedAt };
    } catch (e) {
      console.error('解析账号payload失败', e);
      return { bound: true, accountId: account.accountId };
    }
  }

  async unbind(userId: number): Promise<void> {
    const account = await this.findByUserId(userId);
    if (account == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '未找到绑定的微信Bot账号');
    }
    account.enabled = 0;
    await this.update(account);
    console.info(`解绑微信Bot成功, userId=${userId}`);
  }

  findAllEnabled(): Promise<WeixinChannelAccount[]> {
    return this.db.query<WeixinChannelAccount>(
      `SELECT * FROM weixin_channel_account WHERE enabled = 1 AND ${NOT_DELETED}`,
    );
  }

  async updateGetUpdatesBuf(accountId: number, getUpdatesBuf: string): Promise<void> {
    const account = await this.findById(accountId);
    if (account != null) {
      account.getUpdatesBuf = getUpdatesBuf;
      await this.update(account);
    }
  }

  async disableAccount(accountId: number): Promise<void> {
    const account = await this.findById(accountId);
    if (account != null) {
      account.enabled = 0;
      await this.update(account);
      console.info(`禁用微信Bot账号, accountId=${accountId}`);
    }
  }
}
