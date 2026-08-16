import { describe, expect, it, vi } from 'vitest';
import { recordAudit, resolveAction, resolveObjectId, resolveObjectType, shouldAudit } from './audit.interceptor.js';
import type { AuditLogService } from './audit.service.js';

describe('audit interceptor', () => {
  it('shouldAuditMatchesJavaPrefixes', () => {
    expect(shouldAudit('/v1/agents', 'GET')).toBe(true);
    expect(shouldAudit('/v1/models/1', 'DELETE')).toBe(true);
    expect(shouldAudit('/v1/system-settings', 'PUT')).toBe(true);
    expect(shouldAudit('/v1/admin/foo', 'GET')).toBe(true);
    expect(shouldAudit('/v1/auth/login', 'POST')).toBe(false);
    expect(shouldAudit('/v1/audit/logs', 'GET')).toBe(false);
    expect(shouldAudit('/v1/sessions', 'GET')).toBe(false);
    expect(shouldAudit(null)).toBe(false);
  });

  it('resolveActionAndObjectFields', () => {
    expect(resolveAction('POST')).toBe('CREATE');
    expect(resolveAction('PUT')).toBe('UPDATE');
    expect(resolveAction('PATCH')).toBe('UPDATE');
    expect(resolveAction('DELETE')).toBe('DELETE');
    expect(resolveAction('GET')).toBe('READ');
    expect(resolveAction('OPTIONS')).toBe('EXECUTE');
    expect(resolveObjectType('/v1/agents/12')).toBe('agents');
    expect(resolveObjectType('/v1/admin/users')).toBe('admin.users');
    expect(resolveObjectType('/v1')).toBe('unknown');
    expect(resolveObjectId('/v1/agents/12/experiences/9')).toBe('12');
    expect(resolveObjectId('/v1/models')).toBeNull();
  });

  it('recordAuditPersistsAndSwallowsErrors', async () => {
    const record = vi.fn();
    const service = { record } as unknown as AuditLogService;
    await recordAudit(service, {
      path: '/v1/agents/3',
      method: 'DELETE',
      status: 200,
      userId: 7,
      username: 'alice',
      ip: '1.1.1.1',
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'DELETE',
      objectType: 'agents',
      objectId: '3',
      success: 1,
      userId: 7,
    }));

    record.mockRejectedValue(new Error('db down'));
    await expect(recordAudit(service, {
      path: '/v1/models',
      method: 'GET',
      status: 500,
      errorMessage: 'boom',
    })).resolves.toBeUndefined();
  });

  it('recordAuditSkipsUnauditedPaths', async () => {
    const record = vi.fn();
    const service = { record } as unknown as AuditLogService;
    await recordAudit(service, { path: '/v1/auth/login', method: 'POST', status: 200 });
    expect(record).not.toHaveBeenCalled();
  });
});
