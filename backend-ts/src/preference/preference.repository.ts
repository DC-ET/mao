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
    });
  }

  async updateByUserId(row: UserTaskPanelPreference): Promise<void> {
    await this.db.execute(
      'UPDATE user_task_panel_preference SET group_order = ?, collapsed_groups = ? WHERE user_id = ?',
      [row.groupOrder, row.collapsedGroups, row.userId],
    );
  }
}
