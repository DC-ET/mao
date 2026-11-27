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

  it('只审计定时任务的变更方法，预览接口不写日志', () => {
    expect(shouldAudit('/v1/scheduled-tasks', 'GET')).toBe(false);
    expect(shouldAudit('/v1/scheduled-tasks/all', 'GET')).toBe(false);
    expect(shouldAudit('/v1/scheduled-tasks/12', 'GET')).toBe(false);
    expect(shouldAudit('/v1/scheduled-tasks/12', 'PUT')).toBe(true);
    expect(shouldAudit('/v1/scheduled-tasks/12', 'DELETE')).toBe(true);
    expect(shouldAudit('/v1/scheduled-tasks/cron-preview', 'POST')).toBe(false);
  });

  it('菜单可见性读取不写日志（首屏必拉），其它系统设置读取与写入仍照常审计', () => {
    expect(shouldAudit('/v1/system-settings/menu-visibility', 'GET')).toBe(false);
    expect(shouldAudit('/v1/system-settings', 'GET')).toBe(true);
    expect(shouldAudit('/v1/system-settings/admin.menu.hidden', 'PUT')).toBe(true);
    expect(shouldAudit('/v1/system-settings/admin.menu.hidden', 'GET')).toBe(true);
  });

  it('管理端浏览器回放：列表/timeline 照常审计，逐帧 frames 豁免（方案 2026-11-27 §D5）', () => {
    // 列表与 timeline：一次播放留一条打开痕迹
    expect(shouldAudit('/v1/admin/browser-replays', 'GET')).toBe(true);
    expect(shouldAudit('/v1/admin/browser-replays/12/L1732/frames/7', 'GET')).toBe(false);
    // 非法 seq 不命中豁免正则（仍审计，400 痕迹可查）
    expect(shouldAudit('/v1/admin/browser-replays/12/L1732/frames/1.5', 'GET')).toBe(true);
    // 非 frames 路径（timeline）不受豁免影响
    expect(shouldAudit('/v1/admin/browser-replays/12/L1732/timeline', 'GET')).toBe(true);
    // 豁免只对读方法：同路径的写方法仍审计（纵深防御，当前无写端点）
    expect(shouldAudit('/v1/admin/browser-replays/12/L1732/frames/7', 'DELETE')).toBe(true);
    // owner 侧 frames 路径不在豁免集（/v1/admin 前缀本就不审计读）
    expect(shouldAudit('/v1/sessions/12/browser-live/replays/L1732/frames/7', 'GET')).toBe(false);
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
