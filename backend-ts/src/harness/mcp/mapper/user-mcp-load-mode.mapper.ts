import type { Db } from '../../../db/db.js';

/** user_mcp_load_mode 行（用户级单值偏好，见 V159 迁移）。 */
export interface UserMcpLoadModeRow {
  id?: number;
  userId: number;
  /** DB 存大写：WORKING_SET | FULL */
  loadMode: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export class UserMcpLoadModeMapper {
  constructor(private readonly db: Db) {}

  get(userId: number): Promise<UserMcpLoadModeRow | null> {
    return this.db.queryOne<UserMcpLoadModeRow>(
      'SELECT * FROM user_mcp_load_mode WHERE user_id = ? LIMIT 1',
      [userId],
    );
  }

  insert(userId: number, loadMode: string): Promise<number> {
    return this.db.insert('user_mcp_load_mode', { userId, loadMode });
  }

  async updateById(id: number, loadMode: string): Promise<void> {
    await this.db.updateById('user_mcp_load_mode', id, { loadMode });
  }
}
