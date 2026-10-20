import { TERMINAL_AUDIT_META, type TerminalAuditRecorder } from './harness/terminal/terminal-manager.js';
import { truncateAuditError } from './audit/audit.interceptor.js';
import type { AuditLogService } from './audit/audit.service.js';

export function createTerminalAudit(auditService: AuditLogService): TerminalAuditRecorder {
  return (event, terminal, ctx) => {
    const meta = TERMINAL_AUDIT_META[event];
    void auditService.record({
      action: meta.action,
      objectType: 'terminal',
      objectId: terminal.terminalId,
      method: meta.method,
      path: meta.path(terminal.sessionId, terminal.terminalId),
      userId: terminal.userId,
      username: ctx?.username ?? null,
      ip: ctx?.ip ?? null,
      status: ctx?.errorMessage == null ? 200 : 500,
      success: ctx?.errorMessage == null ? 1 : 0,
      errorMessage: truncateAuditError(ctx?.errorMessage),
    }).catch((e) => console.error('Failed to record terminal audit log', e));
  };
}
