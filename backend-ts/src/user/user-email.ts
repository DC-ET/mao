import type { Db } from '../db/db.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

/** Serialize identity creation and every repository email write in the same transaction.
 * A single DB row deliberately avoids collation-dependent lock keys and unbounded lock rows.
 */
export async function lockUserIdentityWrites(db: Db): Promise<void> {
  const lock = await db.queryOne<{ id: number }>('SELECT id FROM user_identity_write_lock WHERE id = 1 FOR UPDATE');
  if (!lock) throw new Error('User identity write lock is missing');
}

/** Exact email comparison; include deleted records so they cannot be silently reassigned. */
export async function assertEmailAvailable(db: Db, email: unknown, userId?: number): Promise<void> {
  if (email == null || email === '') return;
  const rows = await db.query<{ id: number }>(
    'SELECT id FROM `user` WHERE BINARY email = BINARY ? AND id <> ? FOR UPDATE', [email, userId ?? 0],
  );
  if (rows.length) throw new BusinessException(ErrorCode.PARAM_INVALID, '该邮箱已被其他用户使用');
}
