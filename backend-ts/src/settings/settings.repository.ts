import { hasText } from '../common/case.js';
import type { Db } from '../db/db.js';
import type { SystemSetting, SystemSettingRepository } from './types.js';

export class MysqlSystemSettingRepository implements SystemSettingRepository {
  constructor(private readonly db: Db) {}

  list(category?: string | null): Promise<SystemSetting[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (hasText(category)) {
      where.push('category = ?');
      params.push(category);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.query<SystemSetting>(
      `SELECT * FROM system_setting ${whereSql} ORDER BY category ASC, id ASC`,
      params,
    );
  }

  findByKey(key: string): Promise<SystemSetting | null> {
    return this.db.queryOne<SystemSetting>('SELECT * FROM system_setting WHERE setting_key = ?', [key]);
  }

  async updateById(setting: SystemSetting): Promise<void> {
    if (setting.id == null) {
      return;
    }
    await this.db.updateById('system_setting', setting.id, {
      settingKey: setting.settingKey,
      value: setting.value,
      category: setting.category,
      description: setting.description,
      editable: setting.editable,
    });
  }
}
