import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { AuditLogService } from './audit.service.js';
import type { AuditLog, AuditLogRepository } from './types.js';

describe('AuditLogService', () => {
  const repo: AuditLogRepository = {
    insert: vi.fn(async (log) => {
      log.id = 11;
      return 11;
    }),
    selectPage: vi.fn(),
    findById: vi.fn(),
  };
  const service = new AuditLogService(repo);

  it('recordInsertsLog', async () => {
    const log: AuditLog = {
      action: 'READ',
      objectType: 'agents',
      method: 'GET',
      path: '/v1/agents',
    };
    await service.record(log);
    expect(repo.insert).toHaveBeenCalledWith(log);
    expect(log.id).toBe(11);
  });

  it('listDelegatesFilters', async () => {
    vi.mocked(repo.selectPage).mockResolvedValue({ records: [], total: 0 });
    const result = await service.list(1, 20, 7, 'READ', 'agents', true, '2026-01-01 00:00:00', '2026-01-31 23:59:59');
    expect(result.page).toBe(1);
    expect(result.size).toBe(20);
    expect(repo.selectPage).toHaveBeenCalledWith(1, 20, {
      userId: 7,
      action: 'READ',
      objectType: 'agents',
      success: true,
      startDate: '2026-01-01 00:00:00',
      endDate: '2026-01-31 23:59:59',
    });
  });

  it('getThrowsWhenMissing', async () => {
    vi.mocked(repo.findById).mockResolvedValue(null);
    await expect(service.get(9)).rejects.toBeInstanceOf(BusinessException);
  });
});
