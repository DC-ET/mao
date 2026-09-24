import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Db } from '../db/db.js';

export interface DingtalkBindingStatus {
  bound: boolean;
  unionId?: string | null;
  userid?: string | null;
  boundAt?: string | null;
}

export class MysqlDingtalkBindingRepository {
  constructor(private readonly db: Db) {}

  async getStatus(userId: number): Promise<DingtalkBindingStatus> {
    const row = await this.db.queryOne<{ unionId?: string | null; userid?: string | null; updatedAt?: string | null }>(
      'SELECT union_id, userid, updated_at FROM dingtalk_binding WHERE user_id = ? AND deleted = 0 LIMIT 1',
      [userId],
    );
    if (row?.userid == null || row.userid === '') return { bound: false };
    return { bound: true, unionId: row.unionId ?? null, userid: row.userid, boundAt: row.updatedAt ?? null };
  }

  async findUserIdByUserid(userid: string): Promise<number | null> {
    const row = await this.db.queryOne<{ userId?: number | null }>(
      'SELECT user_id FROM dingtalk_binding WHERE userid = ? AND deleted = 0 LIMIT 1',
      [userid],
    );
    return row?.userId ?? null;
  }

  async findUserIdByUnionId(unionId: string): Promise<number | null> {
    const row = await this.db.queryOne<{ userId?: number | null }>(
      'SELECT user_id FROM dingtalk_binding WHERE union_id = ? AND deleted = 0 LIMIT 1',
      [unionId],
    );
    return row?.userId ?? null;
  }

  /** 先 userid，没有再 unionId。 */
  async findUserId(userid: string | null | undefined, unionId: string | null | undefined): Promise<number | null> {
    if (userid != null && userid !== '') {
      const byUser = await this.findUserIdByUserid(userid);
      if (byUser != null) return byUser;
    }
    if (unionId != null && unionId !== '') return this.findUserIdByUnionId(unionId);
    return null;
  }

  /**
   * 一个 userid 对应一个 Mao 用户，一个 Mao 用户对应一个钉钉身份。
   * 冲突时不自动改绑。
   */
  async bind(userId: number, unionId: string, userid: string): Promise<void> {
    if (unionId.trim() === '' || userid.trim() === '') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '钉钉身份不完整，无法绑定');
    }
    await this.db.transaction(async (tx) => {
      const byUserid = await tx.queryOne<{ userId?: number | null }>(
        'SELECT user_id FROM dingtalk_binding WHERE userid = ? AND deleted = 0 LIMIT 1',
        [userid],
      );
      if (byUserid?.userId != null && byUserid.userId !== userId) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '该钉钉账号已绑定其他 Mao 用户');
      }
      const byUnion = await tx.queryOne<{ userId?: number | null }>(
        'SELECT user_id FROM dingtalk_binding WHERE union_id = ? AND deleted = 0 LIMIT 1',
        [unionId],
      );
      if (byUnion?.userId != null && byUnion.userId !== userId) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '该钉钉账号已绑定其他 Mao 用户');
      }
      const own = await tx.queryOne<{ unionId?: string | null; userid?: string | null }>(
        'SELECT union_id, userid FROM dingtalk_binding WHERE user_id = ? AND deleted = 0 LIMIT 1',
        [userId],
      );
      if (own?.userid != null && own.userid !== '' && (own.userid !== userid || own.unionId !== unionId)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '当前账号已绑定其他钉钉身份，请先解绑');
      }
      if (own?.userid === userid && own.unionId === unionId) return;
      await tx.execute(
        'INSERT INTO dingtalk_binding (user_id, union_id, userid, deleted) VALUES (?, ?, ?, 0)',
        [userId, unionId, userid],
      );
    });
  }

  async unbind(userId: number): Promise<void> {
    await this.db.execute('UPDATE dingtalk_binding SET deleted = 1 WHERE user_id = ? AND deleted = 0', [userId]);
  }
}
