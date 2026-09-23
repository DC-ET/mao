import { createHash, randomUUID } from 'node:crypto';
import { hasText } from '../common/case.js';
import type { Db } from '../db/db.js';

/** `user`.`username` 为 VARCHAR(64)。 */
export const USERNAME_MAX_LENGTH = 64;

/**
 * 邮箱前缀规范化为用户名：小写，非 [a-z0-9_] 字符转下划线，去首尾与连续下划线。
 * 无法规范化（无邮箱、前缀为空）时返回 null。
 */
export function usernameFromEmail(email: string): string | null {
  if (!hasText(email)) {
    return null;
  }
  const at = email.indexOf('@');
  const prefix = at > 0 ? email.slice(0, at) : email;
  const normalized = prefix.trim().toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!hasText(normalized)) {
    return null;
  }
  return truncate(normalized);
}

/** 邮箱不可用时的兜底用户名，如 `ecp_<id>`。 */
export function fallbackUsername(prefix: string, seed: string): string {
  return truncate(`${prefix}_${seed.replace(/[^A-Za-z0-9_]/g, '_')}`);
}

/** 在基础用户名后追加由种子派生的稳定后缀，保证截断后仍不超长。 */
export function usernameWithSuffix(base: string, seed: string): string {
  const suffix = `_${createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;
  return `${truncate(base, USERNAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

/**
 * 生成外部身份（ECP / 公司 SSO / 飞书）首次登录自动建号的用户名：
 * 优先取邮箱前缀（与飞书、LDAP 账号习惯一致），重名时追加稳定后缀，
 * 极端情况下再用随机后缀兜底，保证建号不会因重名失败。
 */
export async function buildUniqueUsername(
  email: string,
  fallback: { prefix: string; seed: string },
  isTaken: (username: string) => Promise<boolean>,
): Promise<string> {
  const base = usernameFromEmail(email) ?? fallbackUsername(fallback.prefix, fallback.seed);
  if (!(await isTaken(base))) {
    return base;
  }
  const seeded = usernameWithSuffix(base, `${fallback.prefix}:${fallback.seed}`);
  if (!(await isTaken(seeded))) {
    return seeded;
  }
  return usernameWithSuffix(base, `${fallback.prefix}:${fallback.seed}:${randomUUID()}`);
}

/** 事务内按用户名查重；identity 写锁已在事务开头持有，无需 FOR UPDATE。 */
export function usernameTaken(tx: Db): (username: string) => Promise<boolean> {
  return async (username: string) => {
    const row = await tx.queryOne<{ id: number }>('SELECT id FROM `user` WHERE username = ? LIMIT 1', [username]);
    return row !== null;
  };
}

function truncate(value: string, max = USERNAME_MAX_LENGTH): string {
  return value.length > max ? value.slice(0, max) : value;
}
