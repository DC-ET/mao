import type { Db } from '../db/db.js';
import { formatDateTime } from '../common/json.js';
import { camelToSnake } from '../common/case.js';
import type { SignalWatcher, SignalWatcherCheck } from './types.js';

/** DATETIME 列写入格式化（MySQL DATETIME 无时区，库内统一本地格式）。 */
function ts(date: Date | number): string {
  return formatDateTime(new Date(date));
}

/** `signal_watcher` 仓储（V148）。 */
export class MysqlSignalWatcherRepository {
  constructor(private readonly db: Db) {}

  insert(watcher: SignalWatcher): Promise<number> {
    return this.db.insert('signal_watcher', {
      userId: watcher.userId,
      agentId: watcher.agentId,
      name: watcher.name,
      url: watcher.url,
      method: watcher.method,
      headersJson: watcher.headersJson,
      body: watcher.body,
      intervalMinutes: watcher.intervalMinutes,
      compareMode: watcher.compareMode,
      jsonPath: watcher.jsonPath,
      promptTemplate: watcher.promptTemplate,
      probeType: watcher.probeType,
      scriptPath: watcher.scriptPath,
      scriptTimeoutSeconds: watcher.scriptTimeoutSeconds,
      status: watcher.status,
      lastValueHash: watcher.lastValueHash,
      lastValueSnippet: watcher.lastValueSnippet,
      lastChangeOldSnippet: watcher.lastChangeOldSnippet,
      lastChangeNewSnippet: watcher.lastChangeNewSnippet,
      lastCheckedAt: watcher.lastCheckedAt,
      lastChangedAt: watcher.lastChangedAt,
      consecutiveFailures: watcher.consecutiveFailures,
      triggerMode: watcher.triggerMode,
      reuseSessionId: watcher.reuseSessionId,
    });
  }

  findById(id: number): Promise<SignalWatcher | null> {
    return this.db.queryOne<SignalWatcher>('SELECT * FROM signal_watcher WHERE id = ?', [id]);
  }

  /** 本人单条（归属不匹配按不存在处理）。 */
  findOwned(id: number, userId: number): Promise<SignalWatcher | null> {
    return this.db.queryOne<SignalWatcher>(
      'SELECT * FROM signal_watcher WHERE id = ? AND user_id = ?',
      [id, userId],
    );
  }

  listByUser(userId: number): Promise<SignalWatcher[]> {
    return this.db.query<SignalWatcher>(
      'SELECT * FROM signal_watcher WHERE user_id = ? ORDER BY id DESC',
      [userId],
    );
  }

  /** 管理后台分页（可按状态/属主/判定模式筛选）。 */
  async listForAdmin(
    page: number,
    size: number,
    filter: { status?: string | null; userId?: number | null; compareMode?: string | null },
  ): Promise<{ rows: SignalWatcher[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status != null && filter.status !== '') {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.userId != null) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.compareMode != null && filter.compareMode !== '') {
      where.push('compare_mode = ?');
      params.push(filter.compareMode);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const totalRow = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM signal_watcher${clause}`,
      params,
    );
    // LIMIT 与 OFFSET 必须用同一个钳制后的 size，否则深页会跳过数据
    const safeSize = Math.max(1, Math.min(200, size));
    const rows = await this.db.query<SignalWatcher>(
      `SELECT * FROM signal_watcher${clause} ORDER BY id DESC LIMIT ${safeSize} OFFSET ${Math.max(0, (page - 1) * safeSize)}`,
      params,
    );
    return { rows, total: Number(totalRow?.c ?? 0) };
  }

  update(id: number, userId: number, patch: Partial<SignalWatcher>): Promise<boolean> {
    const row: Record<string, unknown> = {};
    if (patch.agentId !== undefined) row.agentId = patch.agentId;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.url !== undefined) row.url = patch.url;
    if (patch.method !== undefined) row.method = patch.method;
    if (patch.headersJson !== undefined) row.headersJson = patch.headersJson;
    if (patch.body !== undefined) row.body = patch.body;
    if (patch.intervalMinutes !== undefined) row.intervalMinutes = patch.intervalMinutes;
    if (patch.compareMode !== undefined) row.compareMode = patch.compareMode;
    if (patch.jsonPath !== undefined) row.jsonPath = patch.jsonPath;
    if (patch.promptTemplate !== undefined) row.promptTemplate = patch.promptTemplate;
    if (patch.probeType !== undefined) row.probeType = patch.probeType;
    if (patch.scriptPath !== undefined) row.scriptPath = patch.scriptPath;
    if (patch.scriptTimeoutSeconds !== undefined) row.scriptTimeoutSeconds = patch.scriptTimeoutSeconds;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.lastValueHash !== undefined) row.lastValueHash = patch.lastValueHash;
    // 本次补漏（2026-11-04 方案 §5.7）：基线重置 / 重新启用的
    // patch.lastValueSnippet = null 此前被静默丢弃，片段永远清不掉。
    if (patch.lastValueSnippet !== undefined) row.lastValueSnippet = patch.lastValueSnippet;
    if (patch.lastChangeOldSnippet !== undefined) row.lastChangeOldSnippet = patch.lastChangeOldSnippet;
    if (patch.lastChangeNewSnippet !== undefined) row.lastChangeNewSnippet = patch.lastChangeNewSnippet;
    if (patch.lastChangedAt !== undefined) row.lastChangedAt = patch.lastChangedAt;
    if (patch.lastCheckedAt !== undefined) row.lastCheckedAt = patch.lastCheckedAt;
    if (patch.consecutiveFailures !== undefined) row.consecutiveFailures = patch.consecutiveFailures;
    if (patch.triggerMode !== undefined) row.triggerMode = patch.triggerMode;
    if (patch.reuseSessionId !== undefined) row.reuseSessionId = patch.reuseSessionId;
    const keys = Object.keys(row);
    if (keys.length === 0) return Promise.resolve(false);
    return this.updateByIds(id, userId, row);
  }

  private async updateByIds(id: number, userId: number, row: Record<string, unknown>): Promise<boolean> {
    const assignments = Object.entries(row)
      .map(([key, value]) => `${snake(key)} = ?`)
      .join(', ');
    const result = await this.db.execute(
      `UPDATE signal_watcher SET ${assignments} WHERE id = ? AND user_id = ?`,
      [...Object.values(row), id, userId],
    );
    return result.affectedRows === 1;
  }

  /**
   * 到期扫描（技术方案 §5.3：`last_checked_at` 为空或早于 `NOW() - interval_minutes`）。
   *
   * 阈值按行扣减 `interval_minutes`：DATE_SUB 作用于参数侧而非列，索引
   * idx_watcher_due(status, last_checked_at) 仍可用于范围扫描。若只与原始 now
   * 比较，markChecked 成功路径把 last_checked_at 写成当前时刻后，下一轮 30s
   * 扫描必然再次命中，配置的轮询间隔（1~1440 分钟）被彻底旁路。
   */
  listDue(now: string, limit: number): Promise<SignalWatcher[]> {
    return this.db.query<SignalWatcher>(
      `SELECT * FROM signal_watcher
       WHERE status = 'ACTIVE'
         AND (last_checked_at IS NULL OR last_checked_at < DATE_SUB(?, INTERVAL interval_minutes MINUTE))
       ORDER BY last_checked_at IS NOT NULL, last_checked_at
       LIMIT ${Math.max(1, Math.min(200, limit))}`,
      [now],
    );
  }

  /**
   * 轮询成功/建基线后回写（含失败清零与 last_checked_at 推进到当前时刻）。
   *
   * `consecutive_failures` 只在 resetFailures 不为 false、且「库里仍是本次读到的值」时才清零：
   * 探针在途 10~15 秒内可能有并发失败把库里累加到更大值，此时不能把在途的失败计数打回 0，
   * 否则「连续 N 次自动停用」永远达不到（BUG-G）。若库内值没被并发改动（常态），照常清零。
   * 触发失败路径传 resetFailures=false：这次本来就要接着 recordFailure +1，先清零会让连败停在 1。
   */
  async markChecked(
    id: number,
    patch: {
      lastValueHash: string | null;
      lastValueSnippet: string | null;
      lastChangedAt: string | null;
      consecutiveFailures: number;
      /** 「上次变化」新旧值对（V184）：带了键才写，不带键保持原值（缺省行为不变）。 */
      lastChangeOldSnippet?: string | null;
      lastChangeNewSnippet?: string | null;
      /**
       * 默认 true：库内值仍等于本次快照时清零（成功路径）。
       * 触发失败路径必须传 false——随后还会 recordFailure +1，先清零会让连败永远停在 1。
       */
      resetFailures?: boolean;
    },
  ): Promise<void> {
    const changes: string[] = [];
    const params: unknown[] = [
      patch.lastValueHash,
      patch.lastValueSnippet == null ? null : patch.lastValueSnippet.slice(0, 1024),
      patch.lastChangedAt,
      ts(Date.now()),
      patch.resetFailures === false ? 0 : 1,
      patch.consecutiveFailures,
    ];
    // 带了键才参与 SET：不带键的老调用方行为逐字不变。触发失败路径也传了这组键，
    // watcher 行就是「上次变化」了（本轮 markChanged 已生效），列表卡读到最新变化对。
    if ('lastChangeOldSnippet' in patch) {
      changes.push('last_change_old_snippet = ?');
      params.push(patch.lastChangeOldSnippet == null ? null : patch.lastChangeOldSnippet.slice(0, 1024));
    }
    if ('lastChangeNewSnippet' in patch) {
      changes.push('last_change_new_snippet = ?');
      params.push(patch.lastChangeNewSnippet == null ? null : patch.lastChangeNewSnippet.slice(0, 1024));
    }
    params.push(id);
    await this.db.execute(
      `UPDATE signal_watcher
       SET last_value_hash = ?, last_value_snippet = ?, last_changed_at = ?, last_checked_at = ?,
           consecutive_failures = IF(? = 0, consecutive_failures, IF(consecutive_failures = ?, 0, consecutive_failures))${changes.length > 0 ? `, ${changes.join(', ')}` : ''}
       WHERE id = ?`,
      params,
    );
  }

  /**
   * 失败累加 + 退避推进 + 达阈值自动停用（单条条件更新）。
   * 退避分钟数 = interval_minutes * min(2^failures, 32)，由调用方算好传入。
   *
   * 退避时刻必须与成功路径（markChecked 的 `last_checked_at = ?`）同源：都用 Node 时钟算好再传参。
   * 混用 `DATE_ADD(NOW(), INTERVAL ? MINUTE)` 会在 DB 会话时区 ≠ 应用时区时整体漂移
   * （落后 → 退避被旁路、约每 30s 重试；超前 → 一次失败后静默停摆），
   * 而 listDue 的到期比较用的正是调用方传入的 Node 时钟。
   *
   * 停用判定必须用「累加后的当前值」：MySQL 的 SET 从左到右求值，第一个赋值
   * 已把 consecutive_failures 加成新值，因此这里直接与阈值比即可。
   * 若写成 `consecutive_failures + 1 >= ?`，等于多算一次，实际第 4 次失败就停用（BUG-I）。
   */
  async recordFailure(id: number, backoffMinutes: number, threshold: number): Promise<SignalWatcher | null> {
    const backoffUntil = ts(Date.now() + backoffMinutes * 60_000);
    const result = await this.db.execute(
      `UPDATE signal_watcher
       SET consecutive_failures = consecutive_failures + 1,
           last_checked_at = ?,
           status = IF(consecutive_failures >= ?, 'DISABLED', status)
       WHERE id = ? AND status = 'ACTIVE'`,
      [backoffUntil, threshold, id],
    );
    if (result.affectedRows !== 1) return null;
    return this.findById(id);
  }

  delete(id: number, userId: number): Promise<boolean> {
    return this.db
      .execute('DELETE FROM signal_watcher WHERE id = ? AND user_id = ?', [id, userId])
      .then((result) => result.affectedRows === 1);
  }
}

/** `signal_watcher_check` 仓储（V148）。 */
export class MysqlSignalCheckRepository {
  constructor(private readonly db: Db) {}

  insert(check: SignalWatcherCheck): Promise<number> {
    return this.db.insert('signal_watcher_check', {
      watcherId: check.watcherId,
      httpStatus: check.httpStatus,
      exitCode: check.exitCode ?? null,
      valueHash: check.valueHash,
      changed: check.changed,
      triggeredSessionId: check.triggeredSessionId,
      error: check.error,
      durationMs: check.durationMs,
      warning: check.warning,
    });
  }

  /** 补写触发产生的会话 id（触发成功后回填）。 */
  async markTriggered(id: number, sessionId: number): Promise<void> {
    await this.db.execute(
      'UPDATE signal_watcher_check SET triggered_session_id = ? WHERE id = ?',
      [sessionId, id],
    );
  }

  /**
   * 补写判定值哈希 + 新旧值片段（探针成功、判定值算出来后回填，V185）。
   * 一次 UPDATE 写三列：未变行 / 首轮建基线的行同样留痕（§5.2，不写在 markChanged 收尾处）。
   */
  async updateValue(id: number, patch: { valueHash: string; oldValueSnippet: string | null; newValueSnippet: string | null }): Promise<void> {
    await this.db.execute(
      'UPDATE signal_watcher_check SET value_hash = ?, old_value_snippet = ?, new_value_snippet = ? WHERE id = ?',
      [
        patch.valueHash,
        patch.oldValueSnippet == null ? null : patch.oldValueSnippet.slice(0, 1024),
        patch.newValueSnippet == null ? null : patch.newValueSnippet.slice(0, 1024),
        id,
      ],
    );
  }

  /** @deprecated 改用 updateValue（同写旧/新片段）；保留供存量/测试调用链，避免断链。 */
  async updateHash(id: number, valueHash: string): Promise<void> {
    await this.db.execute('UPDATE signal_watcher_check SET value_hash = ? WHERE id = ?', [valueHash, id]);
  }

  /** 标记本次判定值变化。 */
  async markChanged(id: number): Promise<void> {
    await this.db.execute('UPDATE signal_watcher_check SET changed = 1 WHERE id = ?', [id]);
  }

  /** 打非失败告警标记（决策 7：触发频次超限）。 */
  async markWarning(id: number, warning: string): Promise<void> {
    await this.db.execute('UPDATE signal_watcher_check SET warning = ? WHERE id = ?', [warning, id]);
  }

  /** 回填失败原因（判定值计算失败的场景：check 行先落、后改失败口径）。 */
  async markError(id: number, error: string): Promise<void> {
    await this.db.execute('UPDATE signal_watcher_check SET error = ? WHERE id = ?', [error, id]);
  }

  /** 删除单行（失败回写时行已被删/已停用的孤儿清理）。 */
  async remove(id: number): Promise<void> {
    await this.db.execute('DELETE FROM signal_watcher_check WHERE id = ?', [id]);
  }

  listByWatcher(watcherId: number, page: number, size: number): Promise<SignalWatcherCheck[]> {
    const safeSize = Math.max(1, Math.min(100, size));
    const offset = Math.max(0, (page - 1) * safeSize);
    return this.db.query<SignalWatcherCheck>(
      `SELECT * FROM signal_watcher_check
       WHERE watcher_id = ?
       ORDER BY id DESC
       LIMIT ${safeSize} OFFSET ${offset}`,
      [watcherId],
    );
  }

  async countByWatcher(watcherId: number): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM signal_watcher_check WHERE watcher_id = ?', [watcherId]);
    return Number(row?.c ?? 0);
  }

  /** 近一小时的触发次数（频次上限口径：只数真正触发过的行）。 */
  async countRecentTriggers(watcherId: number, since: string): Promise<number> {
    const row = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM signal_watcher_check
       WHERE watcher_id = ? AND triggered_session_id IS NOT NULL AND checked_at >= ?`,
      [watcherId, since],
    );
    return Number(row?.c ?? 0);
  }

  async deleteByWatcher(watcherId: number): Promise<number> {
    const result = await this.db.execute('DELETE FROM signal_watcher_check WHERE watcher_id = ?', [watcherId]);
    return result.affectedRows;
  }

  /** 滚动清理：删除 cutoff 之前的记录，返回删除行数。 */
  async deleteBatch(cutoff: string, limit: number): Promise<number> {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    const result = await this.db.execute(
      `DELETE FROM signal_watcher_check WHERE checked_at < ? ORDER BY id LIMIT ${safeLimit}`,
      [cutoff],
    );
    return result.affectedRows;
  }
}

/** camelCase → snake_case（复用 common/case.ts，与 toSnakeRow 同规则）。 */
function snake(key: string): string {
  return camelToSnake(key);
}
