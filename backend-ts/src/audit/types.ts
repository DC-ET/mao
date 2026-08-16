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

export interface AuditLogRepository {
  insert(log: AuditLog): Promise<number>;
  selectPage(
    page: number,
    size: number,
    filter: AuditListFilter,
  ): Promise<{ records: AuditLog[]; total: number }>;
  findById(id: number): Promise<AuditLog | null>;
}

export interface AuditRecordInput {
  path: string;
  method: string;
  queryString?: string | null;
  ip?: string | null;
  status: number;
  errorMessage?: string | null;
  userId?: number | null;
  username?: string | null;
}
