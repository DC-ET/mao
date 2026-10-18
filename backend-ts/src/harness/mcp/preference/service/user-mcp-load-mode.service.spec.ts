import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMcpLoadModeService } from './user-mcp-load-mode.service.js';
import type { UserMcpLoadModeMapper } from '../../mapper/user-mcp-load-mode.mapper.js';

describe('UserMcpLoadModeService', () => {
  const mapper = {
    get: vi.fn(),
    insert: vi.fn(),
    updateById: vi.fn(),
  } as unknown as UserMcpLoadModeMapper & Record<string, ReturnType<typeof vi.fn>>;
  const service = new UserMcpLoadModeService(mapper);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the stored mode in either spelling', async () => {
    mapper.get.mockResolvedValue({ id: 1, userId: 7, loadMode: 'FULL' });
    expect(await service.get(7)).toBe('full');
    mapper.get.mockResolvedValue({ id: 1, userId: 7, loadMode: 'WORKING_SET' });
    expect(await service.get(7)).toBe('working_set');
  });

  it('returns null for anonymous users / missing rows', async () => {
    expect(await service.get(null)).toBeNull();
    mapper.get.mockResolvedValue(null);
    expect(await service.get(7)).toBeNull();
  });

  it('inserts a row when the user has no preference', async () => {
    mapper.get.mockResolvedValue(null);
    await service.save(7, 'full');
    expect(mapper.insert).toHaveBeenCalledWith(7, 'FULL');
    expect(mapper.updateById).not.toHaveBeenCalled();
  });

  it('updates the existing row instead of inserting a duplicate', async () => {
    mapper.get.mockResolvedValue({ id: 3, userId: 7, loadMode: 'WORKING_SET' });
    await service.save(7, 'full');
    expect(mapper.updateById).toHaveBeenCalledWith(3, 'FULL');
    expect(mapper.insert).not.toHaveBeenCalled();
  });
});
