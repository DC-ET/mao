import { describe, expect, it, vi } from 'vitest';
import { UserTaskPanelPreferenceService, isGroupRenameable } from './task-panel-preference.service.js';
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
    expect((await service.get(1)).groupAliases).toEqual({});

    const invalid: UserTaskPanelPreference = { userId: 2, groupOrder: 'not-json', collapsedGroups: '' };
    vi.mocked(mapper.findByUserId).mockResolvedValue(invalid);
    expect((await service.get(2)).groupOrder).toEqual([]);
    expect((await service.get(2)).groupAliases).toEqual({});

    const row: UserTaskPanelPreference = {
      userId: 3,
      groupOrder: '["a","b"]',
      collapsedGroups: '["x"]',
      groupAliases: '{"LOCAL:/ws/a":"AI 项目"}',
    };
    vi.mocked(mapper.findByUserId).mockResolvedValue(row);
    expect((await service.get(3)).groupOrder).toEqual(['a', 'b']);
    expect((await service.get(3)).collapsedGroups).toEqual(['x']);
    expect((await service.get(3)).groupAliases).toEqual({ 'LOCAL:/ws/a': 'AI 项目' });

    const parsedRow: UserTaskPanelPreference = {
      userId: 4,
      groupOrder: ['a', 'b'],
      collapsedGroups: ['x'],
      groupAliases: { 'LOCAL:/ws/a': 'AI 项目' },
    };
    vi.mocked(mapper.findByUserId).mockResolvedValue(parsedRow);
    expect((await service.get(4)).groupOrder).toEqual(['a', 'b']);
    expect((await service.get(4)).collapsedGroups).toEqual(['x']);
    expect((await service.get(4)).groupAliases).toEqual({ 'LOCAL:/ws/a': 'AI 项目' });

    const invalidAliasRow: UserTaskPanelPreference = { userId: 5, groupAliases: 'not-json' };
    vi.mocked(mapper.findByUserId).mockResolvedValue(invalidAliasRow);
    expect((await service.get(5)).groupAliases).toEqual({});

    const arrayAliasRow: UserTaskPanelPreference = { userId: 6, groupAliases: '["a"]' };
    vi.mocked(mapper.findByUserId).mockResolvedValue(arrayAliasRow);
    expect((await service.get(6)).groupAliases).toEqual({});
  });

  it('saveNormalizesAndInsertsOrUpdatesRows', async () => {
    vi.mocked(mapper.findByUserId).mockResolvedValue(null);
    const inserted = await service.save(7, {
      groupOrder: [' a ', null as unknown as string, '', 'a', 'b'],
      collapsedGroups: ['x', ' x ', 'y'],
      groupAliases: {},
    });
    expect(inserted.groupOrder).toEqual(['a', 'b']);
    expect(inserted.collapsedGroups).toEqual(['x', 'y']);
    expect(inserted.groupAliases).toEqual({});
    expect(mapper.insert).toHaveBeenCalled();

    const existing: UserTaskPanelPreference = { userId: 7 };
    vi.mocked(mapper.findByUserId).mockResolvedValue(existing);
    const updated = await service.save(7, {
      groupOrder: null as unknown as string[],
      collapsedGroups: [],
      groupAliases: undefined,
    });
    expect(updated.groupOrder).toEqual([]);
    expect(mapper.updateByUserId).toHaveBeenCalledWith(existing);
  });
});

describe('task-panel 别名归一化', () => {
  const mapper: UserTaskPanelPreferenceRepository = {
    findByUserId: vi.fn(),
    insert: vi.fn(),
    updateByUserId: vi.fn(),
  };
  const service = new UserTaskPanelPreferenceService(mapper);

  it('saveTrimsTruncatesAndFiltersNonRenameableKeys', async () => {
    vi.mocked(mapper.findByUserId).mockResolvedValue(null);
    const saved = await service.save(10, {
      groupOrder: [],
      collapsedGroups: [],
      groupAliases: {
        'LOCAL:/ws/a': '  AI 项目  ',
        'LOCAL:未设置': '不允许',
        'CLOUD:临时工作区': '不允许',
        'FEISHU_PRIVATE:7': '不允许',
        'FEISHU_GROUP:/ws/f': '不允许',
        'DINGTALK_PRIVATE:7': '不允许',
        'DINGTALK_GROUP:/ws/d': '不允许',
        'LOCAL:/ws/b': 'x'.repeat(60),
        '': '空 key',
        'LOCAL:/ws/c': '   ',
      },
    });
    expect(saved.groupAliases).toEqual({
      'LOCAL:/ws/a': 'AI 项目',
      'LOCAL:/ws/b': 'x'.repeat(50),
    });
  });

  it('saveDropsNonStringValueEntries', async () => {
    vi.mocked(mapper.findByUserId).mockResolvedValue(null);
    // 值为非 string（数字/对象）时整体剔除该条目
    const saved = await service.save(11, {
      groupOrder: [],
      collapsedGroups: [],
      groupAliases: {
        'LOCAL:/ws/a': 'ok',
        'LOCAL:/ws/b': 123,
        'LOCAL:/ws/c': { nested: true },
      } as unknown as Record<string, string>,
    });
    expect(saved.groupAliases).toEqual({ 'LOCAL:/ws/a': 'ok' });
  });

  it('saveKeepsExistingAliasesWhenClientOmitsGroupAliases', async () => {
    const existing: UserTaskPanelPreference = {
      userId: 12,
      groupOrder: '[]',
      collapsedGroups: '[]',
      groupAliases: '{"LOCAL:/ws/a":"AI 项目"}',
    };
    vi.mocked(mapper.findByUserId).mockResolvedValue(existing);
    // 模拟旧客户端：不传 groupAliases 字段
    const saved = await service.save(12, {
      groupOrder: ['a'],
      collapsedGroups: [],
      groupAliases: undefined,
    });
    expect(saved.groupAliases).toEqual({ 'LOCAL:/ws/a': 'AI 项目' });
    expect(mapper.updateByUserId).toHaveBeenCalled();
    const updatedRow = vi.mocked(mapper.updateByUserId).mock.calls[0][0];
    expect(updatedRow.groupAliases).toBe('{"LOCAL:/ws/a":"AI 项目"}');
  });

  it('saveClearsAliasesWhenExplicitEmptyMapGiven', async () => {
    const existing: UserTaskPanelPreference = {
      userId: 13,
      groupOrder: '[]',
      collapsedGroups: '[]',
      groupAliases: '{"LOCAL:/ws/a":"AI 项目"}',
    };
    vi.mocked(mapper.findByUserId).mockResolvedValue(existing);
    const saved = await service.save(13, {
      groupOrder: [],
      collapsedGroups: [],
      groupAliases: {},
    });
    expect(saved.groupAliases).toEqual({});
    const updatedRow = vi.mocked(mapper.updateByUserId).mock.calls.at(-1)![0];
    expect(updatedRow.groupAliases).toBe('{}');
  });

  it('insertWithoutAliasesWritesEmptyMap', async () => {
    vi.mocked(mapper.findByUserId).mockResolvedValue(null);
    await service.save(14, { groupOrder: [], collapsedGroups: [], groupAliases: undefined });
    const insertedRow = vi.mocked(mapper.insert).mock.calls.at(-1)![0];
    expect(insertedRow.groupAliases).toBe('{}');
  });
});

describe('isGroupRenameable', () => {
  it('allows workspace-backed local and cloud groups', () => {
    expect(isGroupRenameable('LOCAL:/Users/me/code')).toBe(true);
    expect(isGroupRenameable('LOCAL:D:\\projects\\aiprojects')).toBe(true);
    expect(isGroupRenameable('CLOUD:/opt/mao/2/projects/mao')).toBe(true);
  });

  it('rejects system buckets and agent-identity groups', () => {
    expect(isGroupRenameable('LOCAL:未设置')).toBe(false);
    expect(isGroupRenameable('CLOUD:临时工作区')).toBe(false);
    expect(isGroupRenameable('FEISHU_PRIVATE:7')).toBe(false);
    expect(isGroupRenameable('FEISHU_GROUP:/ws/feishu-chat/1/oc_a')).toBe(false);
    expect(isGroupRenameable('DINGTALK_PRIVATE:7')).toBe(false);
    expect(isGroupRenameable('DINGTALK_GROUP:/ws/dingtalk-chat/1/p2p-x')).toBe(false);
    expect(isGroupRenameable('WEIRD_KEY')).toBe(false);
  });
});
