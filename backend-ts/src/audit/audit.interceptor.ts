import type { AuditLogService } from './audit.service.js';
import type { AuditLog, AuditRecordInput } from './types.js';

const MAX_QUERY_LENGTH = 1024;
const MAX_ERROR_LENGTH = 1024;
const AUDITED_PREFIXES = [
  '/v1/agents',
  '/v1/models',
  '/v1/users',
  '/v1/roles',
  '/v1/permissions',
  '/v1/skill-docs',
  '/v1/admin',
  '/v1/system-settings',
];

export function shouldAudit(path: string | null | undefined, _method?: string): boolean {
  if (path == null || path.startsWith('/v1/auth') || path.startsWith('/v1/audit/logs')) {
    return false;
  }
  return AUDITED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function resolveAction(method: string): string {
  switch (method) {
    case 'POST':
      return 'CREATE';
    case 'PUT':
    case 'PATCH':
      return 'UPDATE';
    case 'DELETE':
      return 'DELETE';
    case 'GET':
      return 'READ';
    default:
      return 'EXECUTE';
  }
}

export function resolveObjectType(path: string | null | undefined): string {
  if (path == null) {
    return 'unknown';
  }
  const parts = path.split('/');
  if (parts.length >= 3) {
    if (parts[2] === 'admin' && parts.length >= 4) {
      return `admin.${parts[3]}`;
    }
    return parts[2];
  }
  return 'unknown';
}

export function resolveObjectId(path: string | null | undefined): string | null {
  if (path == null) {
    return null;
  }
  const parts = path.split('/');
  for (let i = 3; i < parts.length; i++) {
    if (/^\d+$/.test(parts[i])) {
      return parts[i];
    }
  }
  return null;
}

export function resolveIp(headers: Record<string, string | string[] | undefined>, remoteAddr?: string | null): string | undefined {
  const forwarded = headerValue(headers, 'x-forwarded-for');
  if (forwarded && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = headerValue(headers, 'x-real-ip');
  return realIp && realIp.trim() ? realIp : (remoteAddr ?? undefined);
}

export async function recordAudit(service: AuditLogService, input: AuditRecordInput): Promise<void> {
  if (!shouldAudit(input.path, input.method)) {
    return;
  }
  const log: AuditLog = {
    method: input.method,
    path: input.path,
    queryString: truncate(input.queryString, MAX_QUERY_LENGTH),
    ip: input.ip,
    status: input.status,
    success: input.errorMessage == null && input.status < 400 ? 1 : 0,
    errorMessage: input.errorMessage != null ? truncate(input.errorMessage, MAX_ERROR_LENGTH) : null,
    action: resolveAction(input.method),
    objectType: resolveObjectType(input.path),
    objectId: resolveObjectId(input.path),
    userId: input.userId,
    username: input.username,
  };
  try {
    await service.record(log);
  } catch {
    // Audit must never break the business request.
  }
}

function truncate(value: string | null | undefined, max: number): string | null | undefined {
  if (value == null || value.length <= max) {
    return value;
  }
  return value.slice(0, max);
}

/** 供拦截器之外的审计写入方（如云端终端）复用同一截断策略。 */
export function truncateAuditError(value: string | null | undefined): string | null {
  return truncate(value, MAX_ERROR_LENGTH) ?? null;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}
