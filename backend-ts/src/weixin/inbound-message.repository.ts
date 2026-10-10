import { createHash } from 'node:crypto';
import type { Db } from '../db/db.js';

export interface WeixinInboundRecord {
  id?: number;
  accountId: string;
  messageKey: string;
  payload: string;
  status?: string;
}

/**
 * 微信入站消息幂等记录。
 * ilink getupdates 协议没有服务端 message_id，用消息内容指纹做幂等键；
 * 状态机与钉钉/飞书一致：CLAIMED / DONE / FAILED，FAILED 与超时 CLAIMED 可重放。
 */
export class WeixinInboundMessageRepository {
  /** DONE 行的去重窗口：窗口内同指纹视为服务端重投跳过，窗口外视为用户合法重发放行。 */
  static readonly DONE_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
  /** 处理期心跳间隔：必须显著小于重认领超时（10 分钟）。 */
  static readonly HEARTBEAT_INTERVAL_MS = 60 * 1000;

  constructor(private readonly db: Db) {}

  /** 消息内容指纹：对 item_list（含正文/媒体引用）与发送方序列化取 SHA-256。 */
  static messageKeyOf(message: Record<string, unknown>): string {
    const basis = {
      from: message.from_user_id ?? null,
      items: message.item_list ?? null,
      description: message.description ?? null,
    };
    return createHash('sha256').update(JSON.stringify(basis)).digest('hex');
  }

  /**
   * 入队一条拉取到的消息（持久化 payload 供失败重放）。
   * 返回是否由本次调用新入队（重复消息返回 false）。
   */
  async enqueue(accountId: string, messageKey: string, payload: string): Promise<boolean> {
    const result = await this.db.execute(
      `INSERT IGNORE INTO weixin_inbound_message (account_id, message_key, payload, status)
       VALUES (?, ?, ?, 'CLAIMED')`,
      [accountId, messageKey, payload],
    );
    return Number(result.affectedRows ?? 0) > 0;
  }

  /**
   * 取回待重放消息（FAILED，或 CLAIMED 超时视为上次处理中断），并重新置为 CLAIMED。
   * 微信处理是 Agent 长执行，故 CLAIMED 期间由处理方定期心跳刷新 updated_at，
   * 「超时」语义为「无心跳即中断」（进程崩溃/异常退出），正常长执行不会被误回收。
   * CLAIMED 超过 10 分钟无心跳允许重认领。
   */
  async reclaimStuck(accountId: string, limit = 20): Promise<WeixinInboundRecord[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<WeixinInboundRecord & { id: number }>(
        `SELECT * FROM weixin_inbound_message
         WHERE account_id = ?
           AND (status = 'FAILED'
             OR (status = 'CLAIMED' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)))
         ORDER BY id ASC LIMIT ? FOR UPDATE`,
        [accountId, limit],
      );
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      // 显式刷新 updated_at：对已超时 CLAIMED 行，SET status='CLAIMED' 是原值重赋值，
      // 不会触发 ON UPDATE CURRENT_TIMESTAMP；不刷新则回收后至首次心跳（60s）之间
      // 会被下一轮 reclaim 再次回收，造成同一消息并发重放。
      await tx.execute(
        `UPDATE weixin_inbound_message SET status = 'CLAIMED', updated_at = CURRENT_TIMESTAMP WHERE id IN (${ids.map(() => '?').join(', ')})`,
        ids,
      );
      return rows;
    });
  }

  /** 是否有未完成（CLAIMED 且心跳未超时）的在途消息：决定游标能否安全推进。 */
  async hasInFlight(accountId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM weixin_inbound_message
       WHERE account_id = ? AND status = 'CLAIMED'
         AND updated_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)`,
      [accountId],
    );
    return Number(row?.cnt ?? 0) > 0;
  }

  /** 处理期心跳：刷新 updated_at，向重放器表明「处理仍在进行」。 */
  async heartbeat(accountId: string, messageKey: string): Promise<void> {
    await this.db.execute(
      `UPDATE weixin_inbound_message SET updated_at = CURRENT_TIMESTAMP
       WHERE account_id = ? AND message_key = ? AND status = 'CLAIMED'`,
      [accountId, messageKey],
    );
  }

  /**
   * 该账号最近一次入站时间，无记录返回 null。
   * ilink 的 `context_token` 只在用户最近一条入站消息后的 24 小时内有效，
   * 主动发送（如定时任务）前必须先查这里，超窗发送必然被拒。
   */
  async findLatestInboundAt(accountId: string): Promise<Date | null> {
    const row = await this.db.queryOne<{ createdAt: Date | string }>(
      `SELECT created_at FROM weixin_inbound_message
       WHERE account_id = ? ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    if (row == null) return null;
    return row.createdAt instanceof Date
      ? row.createdAt
      : new Date(String(row.createdAt).replace(' ', 'T') + 'Z');
  }

  /**
   * 幂等键占用检查：指纹命中且（未 DONE 或 DONE 未满去重窗口）视为同一消息的
   * 服务端重投，跳过处理；DONE 超过窗口视为用户合法重发相同内容，放行处理。
   */
  async shouldSkipDuplicate(accountId: string, messageKey: string): Promise<boolean> {
    const row = await this.db.queryOne<{ status: string; updatedAt: Date | string }>(
      `SELECT status, updated_at FROM weixin_inbound_message
       WHERE account_id = ? AND message_key = ? LIMIT 1`,
      [accountId, messageKey],
    );
    if (row == null) return false;
    if (row.status !== 'DONE') return true;
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(String(row.updatedAt).replace(' ', 'T') + 'Z');
    return Date.now() - updatedAt.getTime() < WeixinInboundMessageRepository.DONE_DEDUP_WINDOW_MS;
  }

  /** 合法重发相同内容（DONE 超窗口）时把既有行重新置回 CLAIMED，进入处理。 */
  async reclaimForResend(accountId: string, messageKey: string, payload: string): Promise<void> {
    await this.db.execute(
      `UPDATE weixin_inbound_message SET status = 'CLAIMED', payload = ?, updated_at = CURRENT_TIMESTAMP
       WHERE account_id = ? AND message_key = ?`,
      [payload, accountId, messageKey],
    );
  }

  async markDone(accountId: string, messageKey: string): Promise<void> {
    await this.db.execute(
      `UPDATE weixin_inbound_message SET status = 'DONE' WHERE account_id = ? AND message_key = ?`,
      [accountId, messageKey],
    );
  }

  async markFailed(accountId: string, messageKey: string): Promise<void> {
    await this.db.execute(
      `UPDATE weixin_inbound_message SET status = 'FAILED'
       WHERE account_id = ? AND message_key = ? AND status = 'CLAIMED'`,
      [accountId, messageKey],
    );
  }
}
