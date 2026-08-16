/**
 * 审计日志契约（管理后台消费）。
 * 注意：AuditLog.success 为数据库存储的 0/1；AuditListFilter.success 为查询入参的 boolean。
 */
export interface AuditLog {
  id?: number;
  userId?: number | null;
  username?: string | null;
  action: string;
  objectType: string;
  objectId?: string | null;
  method: string;
  path: string;
  queryString?: string | null;
  ip?: string | null;
  status?: number | null;
  success?: number | null;
  errorMessage?: string | null;
  createdAt?: string | null;
}

export interface AuditListFilter {
  userId?: number | null;
  action?: string | null;
  objectType?: string | null;
  success?: boolean | null;
  startDate?: string | null;
  endDate?: string | null;
}
