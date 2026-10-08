import type { Db } from '../db/db.js';
import type { ApprovalRuleAdminFilter, ApprovalRuleAdminPage, ApprovalRuleAdminRow, ApprovalRuleRow, ApprovalRuleScope, ApprovalRuleType } from './types.js';

export class ApprovalRuleRepository {
  constructor(private readonly db: Db) {}

  async insert(row: {
    userId: number;
    scope: ApprovalRuleScope;
    sessionId: number | null;
    ruleType: ApprovalRuleType;
    ruleValue: string;
  }): Promise<number> {
    return this.db.insert('approval_rule', {
      userId: row.userId,
      scope: row.scope,
      sessionId: row.sessionId,
      ruleType: row.ruleType,
      ruleValue: row.ruleValue,
    });
  }

  findById(id: number): Promise<ApprovalRuleRow | null> {
    return this.db.queryOne<ApprovalRuleRow>('SELECT * FROM `approval_rule` WHERE id = ?', [id]);
  }

  /** alwaysAllow 落规则的幂等查重（表无唯一键，靠应用层保证恰好一条）。 */
  findBySessionAndValue(sessionId: number, ruleType: ApprovalRuleType, ruleValue: string): Promise<ApprovalRuleRow | null> {
    return this.db.queryOne<ApprovalRuleRow>(
      'SELECT * FROM `approval_rule` WHERE session_id = ? AND rule_type = ? AND rule_value = ? LIMIT 1',
      [sessionId, ruleType, ruleValue],
    );
  }

  /**
   * 匹配查询：该执行用户的启用规则（本会话的 SESSION 规则 + 全部 USER 规则）。
   * 一次拉取内存匹配——规则数量级小，避免逐类型多查。
   */
  listEnabledForMatch(userId: number, sessionId: number | null): Promise<ApprovalRuleRow[]> {
    const params: unknown[] = [userId];
    let sessionClause = "scope = 'USER'";
    if (sessionId != null) {
      sessionClause = "(scope = 'USER' OR (scope = 'SESSION' AND session_id = ?))";
      params.push(sessionId);
    }
    return this.db.query<ApprovalRuleRow>(
      `SELECT * FROM \`approval_rule\` WHERE user_id = ? AND enabled = 1 AND ${sessionClause} ORDER BY id ASC`,
      params,
    );
  }

  listByUser(userId: number, scope: ApprovalRuleScope | null, ruleType: ApprovalRuleType | null, limit: number, offset: number): Promise<ApprovalRuleRow[]> {
    const params: unknown[] = [userId];
    let filterClause = '';
    if (scope != null) {
      filterClause += ' AND scope = ?';
      params.push(scope);
    }
    if (ruleType != null) {
      filterClause += ' AND rule_type = ?';
      params.push(ruleType);
    }
    params.push(limit, offset);
    return this.db.query<ApprovalRuleRow>(
      // 按命中次数降序：设置页暴露「养大了的规则」（§8 风险对策）
      `SELECT * FROM \`approval_rule\` WHERE user_id = ?${filterClause} ORDER BY hit_count DESC, id DESC LIMIT ? OFFSET ?`,
      params,
    );
  }

  async countByUser(userId: number, scope: ApprovalRuleScope | null, ruleType: ApprovalRuleType | null): Promise<number> {
    const params: unknown[] = [userId];
    let filterClause = '';
    if (scope != null) {
      filterClause += ' AND scope = ?';
      params.push(scope);
    }
    if (ruleType != null) {
      filterClause += ' AND rule_type = ?';
      params.push(ruleType);
    }
    const row = await this.db.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM \`approval_rule\` WHERE user_id = ?${filterClause}`,
      params,
    );
    return row?.total ?? 0;
  }

  async updateEnabled(id: number, enabled: boolean): Promise<void> {
    await this.db.execute('UPDATE `approval_rule` SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  }

  async updateValue(id: number, ruleType: ApprovalRuleType, ruleValue: string): Promise<void> {
    await this.db.execute('UPDATE `approval_rule` SET rule_type = ?, rule_value = ? WHERE id = ?', [ruleType, ruleValue, id]);
  }

  async deleteById(id: number): Promise<void> {
    await this.db.execute('DELETE FROM `approval_rule` WHERE id = ?', [id]);
  }

  /** 会话删除级联：物理删该会话的全部 SESSION 规则（USER 规则不受影响）。 */
  async deleteBySessionId(sessionId: number): Promise<void> {
    await this.db.execute('DELETE FROM `approval_rule` WHERE scope = \'SESSION\' AND session_id = ?', [sessionId]);
  }

  async incrementHit(id: number): Promise<void> {
    await this.db.execute(
      'UPDATE `approval_rule` SET hit_count = hit_count + 1, last_hit_at = CURRENT_TIMESTAMP WHERE id = ?',
      [id],
    );
  }

  /** admin 只读清单：LEFT JOIN 用户名与会话标题，支持 user/type/enabled 筛选。 */
  async pageAdmin(filter: ApprovalRuleAdminFilter): Promise<ApprovalRuleAdminPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.userId != null) {
      conditions.push('r.user_id = ?');
      params.push(filter.userId);
    }
    if (filter.ruleType != null) {
      conditions.push('r.rule_type = ?');
      params.push(filter.ruleType);
    }
    if (filter.enabled != null) {
      conditions.push('r.enabled = ?');
      params.push(filter.enabled ? 1 : 0);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    interface AdminRawRow extends Omit<ApprovalRuleAdminRow, 'enabled'> {
      enabled: number;
    }
    const rows = await this.db.query<AdminRawRow>(
      `SELECT r.id, r.user_id AS userId, r.scope, r.session_id AS sessionId, r.rule_type AS ruleType,
              r.rule_value AS ruleValue, r.hit_count AS hitCount, r.last_hit_at AS lastHitAt,
              r.enabled, r.created_at AS createdAt, r.updated_at AS updatedAt,
              u.username AS username, s.title AS sessionTitle
       FROM \`approval_rule\` r
       LEFT JOIN \`user\` u ON u.id = r.user_id
       LEFT JOIN \`session\` s ON s.id = r.session_id
       ${where}
       ORDER BY r.hit_count DESC, r.id DESC
       LIMIT ? OFFSET ?`,
      [...params, filter.size, (filter.page - 1) * filter.size],
    );
    const countRow = await this.db.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM \`approval_rule\` r ${where}`,
      params,
    );
    return {
      records: rows.map((row) => ({ ...row, enabled: row.enabled === 1 })),
      total: countRow?.total ?? 0,
      page: filter.page,
      size: filter.size,
    };
  }
}
