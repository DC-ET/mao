import type { Db } from '../../db/db.js';
import type { UserTaskNotificationPreference, TaskNotificationDelivery } from './types.js';
import type { PreferenceStore } from './preference.service.js';
import type { DeliveryStore } from './delivery.service.js';

export class PreferenceDbStore implements PreferenceStore {
  constructor(private readonly db: Db) {}

  findByUserId(userId: number): Promise<UserTaskNotificationPreference | null> {
    return this.db.queryOne('SELECT * FROM user_task_notification_preference WHERE user_id = ?', [userId]);
  }

  insert(row: UserTaskNotificationPreference): Promise<number> {
    return this.db.insert('user_task_notification_preference', row);
  }

  updateById(row: UserTaskNotificationPreference): Promise<void> {
    return this.db.updateById('user_task_notification_preference', row.id!, row);
  }
}

export class DeliveryDbStore implements DeliveryStore {
  constructor(private readonly db: Db) {}

  insert(row: TaskNotificationDelivery): Promise<number> {
    return this.db.insert('task_notification_delivery', row);
  }

  updateById(row: Partial<TaskNotificationDelivery> & { id: number }): Promise<void> {
    return this.db.updateById('task_notification_delivery', row.id, row);
  }

  async updateIfStatus(
    id: number,
    expectedStatus: string,
    row: Partial<TaskNotificationDelivery>,
  ): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE task_notification_delivery SET status = ?, next_retry_at = ? WHERE id = ? AND status = ?`,
      [row.status ?? null, row.nextRetryAt ?? null, id, expectedStatus],
    );
    return result.affectedRows > 0;
  }
}
