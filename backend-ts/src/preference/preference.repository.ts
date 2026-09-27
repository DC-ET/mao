import type { Db } from '../db/db.js';
import type {
  UserTaskPanelPreference,
  UserTaskPanelPreferenceRepository,
  UserWeixinPreference,
  UserWeixinPreferenceRepository,
} from './types.js';

export class MysqlUserWeixinPreferenceRepository implements UserWeixinPreferenceRepository {
  constructor(private readonly db: Db) {}

  findByUserId(userId: number): Promise<UserWeixinPreference | null> {
    return this.db.queryOne<UserWeixinPreference>(
      'SELECT * FROM user_weixin_preference WHERE user_id = ?',
      [userId],
    );
  }

  async insert(row: UserWeixinPreference): Promise<void> {
    await this.db.insert('user_weixin_preference', {
      userId: row.userId,
      voiceReply: row.voiceReply ?? 0,
    });
  }

  async updateByUserId(row: UserWeixinPreference): Promise<void> {
    await this.db.execute('UPDATE user_weixin_preference SET voice_reply = ? WHERE user_id = ?', [
      row.voiceReply,
      row.userId,
    ]);
  }
}

export class MysqlUserTaskPanelPreferenceRepository implements UserTaskPanelPreferenceRepository {
  constructor(private readonly db: Db) {}

  findByUserId(userId: number): Promise<UserTaskPanelPreference | null> {
    return this.db.queryOne<UserTaskPanelPreference>(
      'SELECT * FROM user_task_panel_preference WHERE user_id = ?',
      [userId],
    );
  }

  async insert(row: UserTaskPanelPreference): Promise<void> {
    await this.db.insert('user_task_panel_preference', {
      userId: row.userId,
      groupOrder: row.groupOrder,
      collapsedGroups: row.collapsedGroups,
      groupAliases: row.groupAliases ?? '{}',
      version: row.version ?? 0,
    });
  }

  /**
   * 乐观锁更新：WHERE user_id = ? AND version = ?，命中才写并 version + 1。
   * 返回 false 表示期间已有别的请求写过这行（并发保存），调用方必须重取合并而不是覆盖。
   */
  async updateByUserId(row: UserTaskPanelPreference): Promise<boolean> {
    const expectedVersion = row.version ?? 0;
    const result = await this.db.execute(
      `UPDATE user_task_panel_preference
          SET group_order = ?, collapsed_groups = ?, group_aliases = ?, version = ?
        WHERE user_id = ? AND version = ?`,
      [row.groupOrder, row.collapsedGroups, row.groupAliases ?? '{}', expectedVersion + 1, row.userId, expectedVersion],
    );
    return result.affectedRows === 1;
  }
}
