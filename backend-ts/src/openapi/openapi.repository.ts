export type { ApiToken, OutboundDelivery, OutboundSubscription, WebhookTrigger } from './types.js';
import type { Db } from '../db/db.js';
import { formatDateTime } from '../common/json.js';
import type { ApiToken, OutboundDelivery, OutboundSubscription, WebhookTrigger } from './types.js';

/** DATETIME 列写入格式化（MySQL DATETIME 无时区，库内统一本地格式）。 */
function ts(date: Date | number): string {
  return formatDateTime(new Date(date));
}

export class MysqlApiTokenRepository {
  constructor(private readonly db: Db) {}

  insert(token: ApiToken): Promise<number> {
    return this.db.insert('api_token', {
      userId: token.userId,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      tokenHash: token.tokenHash,
      scopes: token.scopes ?? '[]',
      expiresAt: token.expiresAt ?? null,
    });
  }

  findByHash(tokenHash: string): Promise<ApiToken | null> {
    return this.db.queryOne<ApiToken>('SELECT * FROM api_token WHERE token_hash = ?', [tokenHash]);
  }

  listByUser(userId: number): Promise<ApiToken[]> {
    return this.db.query<ApiToken>(
      'SELECT * FROM api_token WHERE user_id = ? ORDER BY id DESC',
      [userId],
    );
  }

  findById(id: number): Promise<ApiToken | null> {
    return this.db.queryOne<ApiToken>('SELECT * FROM api_token WHERE id = ?', [id]);
  }

  countActive(userId: number): Promise<number> {
    return this.countActiveAt(userId, formatDateTime(new Date()));
  }

  async countActiveAt(userId: number, now: string): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(
      'SELECT COUNT(*) AS c FROM api_token WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
      [userId, now],
    );
    return Number(row?.c ?? 0);
  }

  async revoke(id: number, userId: number): Promise<boolean> {
    const result = await this.db.execute(
      'UPDATE api_token SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [ts(new Date()), id, userId],
    );
    return result.affectedRows === 1;
  }

  /** 命中即刷 last_used_at：fire-and-forget，不阻塞请求、失败不影响鉴权。 */
  async touchLastUsed(id: number): Promise<void> {
    try {
      await this.db.execute('UPDATE api_token SET last_used_at = ? WHERE id = ?', [ts(new Date()), id]);
    } catch (e) {
      console.warn(`[openapi] failed to touch token last_used_at, id=${id}: ${(e as Error).message}`);
    }
  }

  async setLogFullBody(id: number, userId: number, enabled: boolean): Promise<boolean> {
    const result = await this.db.execute(
      'UPDATE api_token SET log_full_body = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [enabled ? 1 : 0, id, userId],
    );
    return result.affectedRows === 1;
  }

  async clearAutoDisable(id: number, userId: number): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE api_token
       SET auto_disabled_at = NULL, auto_disable_reason = NULL, failure_count = 0, failure_window_started_at = NULL
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      [id, userId],
    );
    return result.affectedRows === 1;
  }

  async resetFailures(id: number): Promise<void> {
    await this.db.execute(
      'UPDATE api_token SET failure_count = 0, failure_window_started_at = NULL WHERE id = ?',
      [id],
    );
  }

  /**
   * 单条条件更新累加失败次数。窗口空或超过 1 小时则从 1 重新计。
   * 已停用或已吊销的行影响 0 行，返回 null。
   */
  async bumpFailure(id: number, now: string): Promise<number | null> {
    const result = await this.db.execute(
      `UPDATE api_token
       SET failure_count = IF(failure_window_started_at IS NULL OR failure_window_started_at < DATE_SUB(?, INTERVAL 1 HOUR), 1, failure_count + 1),
           failure_window_started_at = IF(failure_window_started_at IS NULL OR failure_window_started_at < DATE_SUB(?, INTERVAL 1 HOUR), ?, failure_window_started_at)
       WHERE id = ? AND auto_disabled_at IS NULL AND revoked_at IS NULL`,
      [now, now, now, id],
    );
    if (result.affectedRows !== 1) return null;
    const row = await this.findById(id);
    return row?.failureCount == null ? null : Number(row.failureCount);
  }

  async casAutoDisable(id: number, now: string, reason: string): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE api_token
       SET auto_disabled_at = ?, auto_disable_reason = ?
       WHERE id = ? AND auto_disabled_at IS NULL AND revoked_at IS NULL`,
      [now, reason, id],
    );
    return result.affectedRows === 1;
  }
}

export class MysqlWebhookTriggerRepository {
  constructor(private readonly db: Db) {}

  insert(trigger: WebhookTrigger): Promise<number> {
    return this.db.insert('webhook_trigger', {
      userId: trigger.userId,
      agentId: trigger.agentId,
      sessionId: trigger.sessionId ?? null,
      name: trigger.name,
      pathToken: trigger.pathToken,
      secretCipher: trigger.secretCipher,
      enabled: trigger.enabled ?? 1,
    });
  }

  findByPathToken(pathToken: string): Promise<WebhookTrigger | null> {
    return this.db.queryOne<WebhookTrigger>('SELECT * FROM webhook_trigger WHERE path_token = ?', [pathToken]);
  }

  findById(id: number): Promise<WebhookTrigger | null> {
    return this.db.queryOne<WebhookTrigger>('SELECT * FROM webhook_trigger WHERE id = ?', [id]);
  }

  listByUser(userId: number): Promise<WebhookTrigger[]> {
    return this.db.query<WebhookTrigger>('SELECT * FROM webhook_trigger WHERE user_id = ? ORDER BY id DESC', [userId]);
  }

  countByUser(userId: number): Promise<number> {
    return this.countByUserAt(userId);
  }

  async countByUserAt(userId: number): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM webhook_trigger WHERE user_id = ?', [userId]);
    return Number(row?.c ?? 0);
  }

  async updateFields(id: number, fields: Partial<Pick<WebhookTrigger, 'name' | 'agentId' | 'sessionId' | 'enabled' | 'consecutiveFailures' | 'secretCipher'>>): Promise<void> {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) data[k] = v;
    }
    if (Object.keys(data).length === 0) return;
    await this.db.updateById('webhook_trigger', id, data);
  }

  async deleteById(id: number, userId: number): Promise<boolean> {
    const result = await this.db.execute('DELETE FROM webhook_trigger WHERE id = ? AND user_id = ?', [id, userId]);
    return result.affectedRows === 1;
  }

  /**
   * 连续失败计数回写（队列消费侧/直跑路径共用）：
   * - COMPLETED：清零；
   * - FAILED：+1，达到阈值时停用（读-改-写包在事务内，防并发回写丢计数）。
   * CANCELLED 不计不清（决策 11）。返回停用前的最新计数供通知决策。
   */
  async recordOutcome(id: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', disableAfter: number, now: string): Promise<{ consecutiveFailures: number; disabled: boolean } | null> {
    if (phase === 'CANCELLED') return null;
    if (phase === 'COMPLETED') {
      await this.db.execute(
        'UPDATE webhook_trigger SET consecutive_failures = 0, last_fired_at = ? WHERE id = ?',
        [now, id],
      );
      return { consecutiveFailures: 0, disabled: false };
    }
    // FAILED 的读-改-写必须在同一事务同一连接上完成：池化 autocommit 下
    // FOR UPDATE 的行锁随 SELECT 语句结束即释放，两条 statements 分别取连接时
    // 并发回写（未绑定会话每次新建会话天然并行）会读到同一快照互相覆盖丢计数，
    // 陈旧快照还会把用户刚重新启用的触发器再次停用、重复发停用通知。
    return this.db.transaction(async (tx) => {
      // 结果键走 Db 层的 camelCase 转换（toCamelList），必须按 consecutiveFailures 读
      const row = await tx.queryOne<{ consecutiveFailures: number; enabled: number }>(
        'SELECT consecutive_failures, enabled FROM webhook_trigger WHERE id = ? FOR UPDATE',
        [id],
      );
      if (row == null || Number(row.enabled) !== 1) {
        // 行已删或已停用：只刷 last_fired，不再累加（停用后的 settle 不产生新失败）
        await tx.execute('UPDATE webhook_trigger SET last_fired_at = ? WHERE id = ?', [now, id]);
        return null;
      }
      const next = Number(row.consecutiveFailures ?? 0) + 1;
      const disable = next >= disableAfter;
      await tx.execute(
        'UPDATE webhook_trigger SET consecutive_failures = ?, enabled = ?, last_fired_at = ? WHERE id = ?',
        [next, disable ? 0 : 1, now, id],
      );
      return { consecutiveFailures: next, disabled: disable };
    });
  }
}

export class MysqlOutboundSubscriptionRepository {
  constructor(private readonly db: Db) {}

  insert(subscription: OutboundSubscription): Promise<number> {
    return this.db.insert('outbound_subscription', {
      userId: subscription.userId,
      event: subscription.event,
      targetUrl: subscription.targetUrl,
      secretCipher: subscription.secretCipher,
      enabled: subscription.enabled ?? 1,
    });
  }

  listByUser(userId: number): Promise<OutboundSubscription[]> {
    return this.db.query<OutboundSubscription>('SELECT * FROM outbound_subscription WHERE user_id = ? ORDER BY id DESC', [userId]);
  }

  listEnabledByEvent(userId: number, event: string): Promise<OutboundSubscription[]> {
    return this.db.query<OutboundSubscription>(
      'SELECT * FROM outbound_subscription WHERE user_id = ? AND event = ? AND enabled = 1',
      [userId, event],
    );
  }

  findById(id: number): Promise<OutboundSubscription | null> {
    return this.db.queryOne<OutboundSubscription>('SELECT * FROM outbound_subscription WHERE id = ?', [id]);
  }

  countByUser(userId: number): Promise<number> {
    return this.countByUserAt(userId);
  }

  async countByUserAt(userId: number): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM outbound_subscription WHERE user_id = ?', [userId]);
    return Number(row?.c ?? 0);
  }

  async setEnabled(id: number, userId: number, enabled: boolean): Promise<boolean> {
    const result = await this.db.execute(
      'UPDATE outbound_subscription SET enabled = ? WHERE id = ? AND user_id = ?',
      [enabled ? 1 : 0, id, userId],
    );
    return result.affectedRows === 1;
  }

  async deleteById(id: number, userId: number): Promise<boolean> {
    const result = await this.db.execute('DELETE FROM outbound_subscription WHERE id = ? AND user_id = ?', [id, userId]);
    return result.affectedRows === 1;
  }
}

export class MysqlOutboundDeliveryRepository {
  constructor(private readonly db: Db) {}

  insert(delivery: OutboundDelivery): Promise<number> {
    return this.db.insert('outbound_delivery', {
      subscriptionId: delivery.subscriptionId,
      event: delivery.event,
      payload: delivery.payload,
      status: delivery.status ?? 'PENDING',
      attemptCount: delivery.attemptCount ?? 0,
      nextRetryAt: delivery.nextRetryAt ?? null,
    });
  }

  /** 到期待投递：PENDING（含到期重试）。 */
  listDue(now: string, limit: number): Promise<OutboundDelivery[]> {
    return this.db.query<OutboundDelivery>(
      `SELECT d.* FROM outbound_delivery d
       JOIN outbound_subscription s ON s.id = d.subscription_id AND s.enabled = 1
       WHERE d.status = 'PENDING' AND d.next_retry_at <= ?
       ORDER BY d.id ASC LIMIT ?`,
      [now, limit],
    );
  }

  /** 认领：PENDING → SENDING（CAS，防多 worker/重复 tick 重复投递）。 */
  async claim(id: number): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE outbound_delivery SET status = 'SENDING' WHERE id = ? AND status = 'PENDING'",
      [id],
    );
    return result.affectedRows === 1;
  }

  /** SENDING 卡死行恢复（进程重启/发送中断）：超时 cutoff 前的 SENDING 复位回 PENDING。 */
  async recoverInterrupted(cutoff: string, now: string): Promise<void> {
    await this.db.execute(
      "UPDATE outbound_delivery SET status = 'PENDING', next_retry_at = ? WHERE status = 'SENDING' AND created_at < ?",
      [now, cutoff],
    );
  }

  async markSucceeded(id: number, attemptCount: number, httpStatus: number | null, now: string): Promise<void> {
    await this.db.execute(
      "UPDATE outbound_delivery SET status = 'SUCCEEDED', attempt_count = ?, last_http_status = ?, last_error = NULL, sent_at = ?, next_retry_at = NULL WHERE id = ?",
      [attemptCount, httpStatus, now, id],
    );
  }

  async markFailed(id: number, attemptCount: number, httpStatus: number | null, error: string | null): Promise<void> {
    await this.db.execute(
      "UPDATE outbound_delivery SET status = 'FAILED', attempt_count = ?, last_http_status = ?, last_error = ?, next_retry_at = NULL WHERE id = ?",
      [attemptCount, httpStatus, error, id],
    );
  }

  async scheduleRetry(id: number, attemptCount: number, httpStatus: number | null, error: string | null, nextRetryAt: string): Promise<void> {
    await this.db.execute(
      "UPDATE outbound_delivery SET status = 'PENDING', attempt_count = ?, last_http_status = ?, last_error = ?, next_retry_at = ? WHERE id = ?",
      [attemptCount, httpStatus, error, nextRetryAt, id],
    );
  }

  listBySubscription(subscriptionId: number, limit: number): Promise<OutboundDelivery[]> {
    return this.db.query<OutboundDelivery>(
      'SELECT * FROM outbound_delivery WHERE subscription_id = ? ORDER BY id DESC LIMIT ?',
      [subscriptionId, limit],
    );
  }

  findById(id: number): Promise<OutboundDelivery | null> {
    return this.db.queryOne<OutboundDelivery>('SELECT * FROM outbound_delivery WHERE id = ?', [id]);
  }

  /** 终态历史清理（90 天，对齐任务通知投递的清理口径）。 */
  async deleteHistory(cutoff: string): Promise<void> {
    await this.db.execute(
      "DELETE FROM outbound_delivery WHERE status IN ('SUCCEEDED', 'FAILED') AND created_at < ?",
      [cutoff],
    );
  }
}
