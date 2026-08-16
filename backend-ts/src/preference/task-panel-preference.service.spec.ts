import { describe, expect, it, vi } from 'vitest';
import { UserTaskPanelPreferenceService } from './task-panel-preference.service.js';
import type { UserTaskPanelPreference, UserTaskPanelPreferenceRepository } from './types.js';

describe('UserTaskPanelPreferenceService', () => {
  const mapper: UserTaskPanelPreferenceRepository = {
    findByUserId: vi.fn(),
    insert: vi.fn(),
    updateByUserId: vi.fn(),
  };
  const service = new UserTaskPanelPreferenceService(mapper);

  it('getReturnsEmptyMissingOrInvalidRowsAndParsesValidRows', async () => {
    vi.mocked(mapper.findByUserId).mockResolvedValue(null);
    expect((await service.get(1)).groupOrder).toEqual([]);

    const invalid: UserTaskPanelPreference = { userId: 2, groupOrder: 'not-json', collapsedGroups: '' };
    vi.mocked(mapper.findByUserId).mockResolvedValue(invalid);
    expect((await service.get(2)).groupOrder).toEqual([]);

    const row: UserTaskPanelPreference = {
      userId: 3,
      groupOrder: '["a","b"]',
      collapsedGroups: '["x"]',
    };
    vi.mocked(mapper.findByUserId).mockResolvedValue(row);
    expect((await service.get(3)).groupOrder).toEqual(['a', 'b']);
    expect((await service.get(3)).collapsedGroups).toEqual(['x']);

    const parsedRow: UserTaskPanelPreference = {
      userId: 4,
      groupOrder: ['a', 'b'],
      collapsedGroups: ['x'],
    };
    vi.mocked(mapper.findByUserId).mockResolvedValue(parsedRow);
    expect((await service.get(4)).groupOrder).toEqual(['a', 'b']);
    expect((await service.get(4)).collapsedGroups).toEqual(['x']);
  });

  it('saveNormalizesAndInsertsOrUpdatesRows', async () => {
    vi.mocked(mapper.findByUserId).mockResolvedValue(null);
    const inserted = await service.save(7, {
      groupOrder: [' a ', null as unknown as string, '', 'a', 'b'],
      collapsedGroups: ['x', ' x ', 'y'],
    });
    expect(inserted.groupOrder).toEqual(['a', 'b']);
    expect(inserted.collapsedGroups).toEqual(['x', 'y']);
    expect(mapper.insert).toHaveBeenCalled();

    const existing: UserTaskPanelPreference = { userId: 7 };
    vi.mocked(mapper.findByUserId).mockResolvedValue(existing);
    const updated = await service.save(7, { groupOrder: null as unknown as string[], collapsedGroups: [] });
    expect(updated.groupOrder).toEqual([]);
    expect(mapper.updateByUserId).toHaveBeenCalledWith(existing);
  });
});
