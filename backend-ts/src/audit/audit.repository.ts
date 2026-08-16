import { hasText } from '../common/case.js';
import type { Db } from '../db/db.js';
import type { AuditListFilter, AuditLog, AuditLogRepository } from './types.js';

export class MysqlAuditLogRepository implements AuditLogRepository {
  constructor(private readonly db: Db) {}

  async insert(log: AuditLog): Promise<number> {
    const id = await this.db.insert('audit_log', {
      userId: log.userId,
      username: log.username,
      action: log.action,
      objectType: log.objectType,
      objectId: log.objectId,
      method: log.method,
      path: log.path,
      queryString: log.queryString,
      ip: log.ip,
      status: log.status,
      success: log.success ?? 1,
      errorMessage: log.errorMessage,
    });
    log.id = id;
    return id;
  }

  async selectPage(
    page: number,
    size: number,
    filter: AuditListFilter,
  ): Promise<{ records: AuditLog[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.userId != null) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    if (hasText(filter.action)) {
      where.push('action = ?');
      params.push(filter.action);
    }
    if (hasText(filter.objectType)) {
      where.push('object_type = ?');
      params.push(filter.objectType);
    }
    if (filter.success != null) {
      where.push('success = ?');
      params.push(filter.success ? 1 : 0);
    }
    if (filter.startDate) {
      where.push('created_at >= ?');
      params.push(filter.startDate);
    }
    if (filter.endDate) {
      where.push('created_at <= ?');
      params.push(filter.endDate);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM audit_log ${whereSql}`,
      params,
    );
    const total = Number(countRow?.cnt ?? 0);
    const current = Math.max(page, 1);
    const offset = (current - 1) * size;
    const records = await this.db.query<AuditLog>(
      `SELECT * FROM audit_log ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, size, offset],
    );
    return { records, total };
  }

  findById(id: number): Promise<AuditLog | null> {
    return this.db.queryOne<AuditLog>('SELECT * FROM audit_log WHERE id = ?', [id]);
  }
}
