import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Db } from '../db/db.js';

export interface FeishuBindingStatus { bound: boolean; unionId?: string | null; botId?: number | null; boundAt?: string | null; }
export interface FeishuBindingRepository { getStatus(userId: number): Promise<FeishuBindingStatus>; findUserIdByUnionId(unionId: string): Promise<number | null>; bind(userId: number, unionId: string, botId?: number | null): Promise<void>; unbind(userId: number): Promise<void>; }

export class MysqlFeishuBindingRepository implements FeishuBindingRepository {
  constructor(private readonly db: Db) {}
  async getStatus(userId: number): Promise<FeishuBindingStatus> {
    const row = await this.db.queryOne<{ unionId?: string | null; updatedAt?: string | null }>(
      'SELECT union_id, updated_at FROM feishu_binding WHERE user_id = ? AND deleted = 0 LIMIT 1', [userId],
    );
    if (row?.unionId == null || row.unionId === '') return { bound: false };
    return { bound: true, unionId: row.unionId, boundAt: row.updatedAt ?? null };
  }
  async findUserIdByUnionId(unionId: string): Promise<number | null> {
    const row = await this.db.queryOne<{ userId?: number | null }>(
      'SELECT user_id FROM feishu_binding WHERE union_id = ? AND deleted = 0 LIMIT 1', [unionId],
    );
    return row?.userId ?? null;
  }

  async bind(userId: number, unionId: string, _botId?: number | null): Promise<void> {
    if (unionId.trim() === '') throw new BusinessException(ErrorCode.PARAM_INVALID, 'union_id不能为空');
    await this.db.transaction(async (tx) => {
      const previous = await tx.queryOne<{ userId?: number | null }>(
        'SELECT user_id FROM feishu_binding WHERE union_id = ? AND deleted = 0 LIMIT 1', [unionId],
      );
      await tx.execute('UPDATE feishu_binding SET deleted = 1 WHERE user_id = ? AND deleted = 0', [userId]);
      await tx.execute('UPDATE feishu_binding SET deleted = 1 WHERE union_id = ? AND deleted = 0', [unionId]);
      if (previous?.userId != null && previous.userId !== userId) {
        await tx.execute('UPDATE `user` SET feishu_user_id = NULL WHERE id = ?', [previous.userId]);
      }
      await tx.execute(
        'INSERT INTO feishu_binding (user_id, union_id, deleted) VALUES (?, ?, 0)', [userId, unionId],
      );
      await tx.execute('UPDATE `user` SET feishu_user_id = ? WHERE id = ?', [unionId, userId]);
    });
  }
  async unbind(userId: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute('UPDATE feishu_binding SET deleted = 1 WHERE user_id = ? AND deleted = 0', [userId]);
      await tx.execute('UPDATE `user` SET feishu_user_id = NULL WHERE id = ?', [userId]);
    });
  }
}
