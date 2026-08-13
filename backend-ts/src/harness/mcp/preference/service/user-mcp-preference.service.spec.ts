import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMcpPreferenceService } from './user-mcp-preference.service.js';
import type { UserMcpPreferenceMapper } from '../../mapper/mcp-server.mapper.js';

describe('UserMcpPreferenceService', () => {
  const mapper = {
    listDisabledServerIds: vi.fn(),
    get: vi.fn(),
    insert: vi.fn(),
    updateById: vi.fn(),
    deleteById: vi.fn(),
    deleteByServer: vi.fn(),
    listByUser: vi.fn(),
  } as unknown as UserMcpPreferenceMapper & Record<string, ReturnType<typeof vi.fn>>;
  const service = new UserMcpPreferenceService(mapper);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getDisabledServerIdsReturnsOnlyDisabledRows', async () => {
    mapper.listDisabledServerIds.mockResolvedValue([
      { id: 1, userId: 9, serverId: 2, enabled: 0 },
      { id: 2, userId: 9, serverId: 3, enabled: 0 },
    ]);
    expect(await service.getDisabledServerIds(9)).toEqual([2, 3]);
    expect(await service.getDisabledServerIds(null)).toEqual([]);
  });

  it('saveDisableInsertsNewRowWhenNoneExists', async () => {
    mapper.get.mockResolvedValue(null);
    await service.save(9, 5, false);
    expect(mapper.insert).toHaveBeenCalledWith({ userId: 9, serverId: 5, enabled: 0 });
  });

  it('saveDisableUpdatesExistingRow', async () => {
    mapper.get.mockResolvedValue({ id: 1, userId: 9, serverId: 5, enabled: 1 });
    await service.save(9, 5, false);
    expect(mapper.updateById).toHaveBeenCalledWith(1, { enabled: 0 });
  });

  it('saveEnableDeletesRowToFollowGlobal', async () => {
    mapper.get.mockResolvedValue({ id: 1, userId: 9, serverId: 5, enabled: 0 });
    await service.save(9, 5, true);
    expect(mapper.deleteById).toHaveBeenCalledWith(1);
  });

  it('saveEnableWithNoRowIsNoop', async () => {
    mapper.get.mockResolvedValue(null);
    await service.save(9, 5, true);
    expect(mapper.insert).not.toHaveBeenCalled();
    expect(mapper.updateById).not.toHaveBeenCalled();
  });

  it('saveIgnoresNullArgs', async () => {
    await service.save(null, 5, false);
    await service.save(9, null, false);
    expect(mapper.insert).not.toHaveBeenCalled();
  });
});
