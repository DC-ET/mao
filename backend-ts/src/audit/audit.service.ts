import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { AuditListFilter, AuditLog, AuditLogRepository } from './types.js';

export class AuditLogService {
  constructor(private readonly auditRepo: AuditLogRepository) {}

  record(log: AuditLog): Promise<number> {
    return this.auditRepo.insert(log);
  }

  async list(
    page: number,
    size: number,
    userId?: number | null,
    action?: string | null,
    objectType?: string | null,
    success?: boolean | null,
    startDate?: string | null,
    endDate?: string | null,
  ): Promise<{ records: AuditLog[]; total: number; page: number; size: number }> {
    const filter: AuditListFilter = { userId, action, objectType, success, startDate, endDate };
    const result = await this.auditRepo.selectPage(page, size, filter);
    return { records: result.records, total: result.total, page, size };
  }

  async get(id: number): Promise<AuditLog> {
    const log = await this.auditRepo.findById(id);
    if (!log) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '审计日志不存在');
    }
    return log;
  }
}
