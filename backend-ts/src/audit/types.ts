import type { AuditLog, AuditListFilter } from '@mao/contracts';
export type { AuditLog, AuditListFilter };

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
