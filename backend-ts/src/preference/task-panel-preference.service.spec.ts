import { describe, expect, it, vi } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskPanelPreferenceConflictException, UserTaskPanelPreferenceService, isGroupRenameable } from './task-panel-preference.service.js';
import type { UserTaskPanelPreference, UserTaskPanelPreferenceRepository } from './types.js';

describe('UserTaskPanelPreferenceService', () => {
  const mapper: UserTaskPanelPreferenceRepository = {
    findByUserId: vi.fn(),
    insert: vi.fn(),
    updateByUserId: vi.fn(async () => true),
  };
  const service = new UserTaskPanelPreferenceService(mapper);

  beforeEach(() => {
    // 版本号相关用例会改 updateByUserId 的返回值，必须复位，否则跨用例泄漏
    vi.mocked(mapper.updateByUserId).mockReset();
    vi.mocked(mapper.updateByUserId).mockResolvedValue(true);
    vi.mocked(mapper.insert).mockReset();
  });

  it('getReturnsEmptyMissingOrInvalidRowsAndParsesValidRows', async () => {
    vi.mocked(mapper.findByUserId).mockResolvedValue(null);
    expect((await service.get(1)).groupOrder).toEqual([]);
    expect((await service.get(1)).groupAliases).toEqual({});
    expect((await service.get(1)).version).toBe(0);

    const invalid: UserTaskPanelPreference = { userId: 2, groupOrder: 'not-json', collapsedGroups: '' };
    vi.mocked(mapper.findByUserId).mockResolvedValue(invalid);
    expect((await service.get(2)).groupOrder).toEqual([]);
    expect((await service.get(2)).groupAliases).toEqual({});

    const row: UserTaskPanelPreference = {
      userId: 3,
      groupOrder: '["a","b"]',
      collapsedGroups: '["x"]',
      groupAliases: '{"LOCAL:/ws/a":"AI 项目"}',
      version: 4,
    };
    vi.mocked(mapper.findByUserId).mockResolvedValue(row);
    expect((await service.get(3)).groupOrder).toEqual(['a', 'b']);
    expect((await service.get(3)).collapsedGroups).toEqual(['x']);
    expect((await service.get(3)).groupAliases).toEqual({ 'LOCAL:/ws/a': 'AI 项目' });
    // version 必须透出：客户端要靠它做乐观锁校验
    expect((await service.get(3)).version).toBe(4);

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

  it('saveRejectsStaleExpectedVersionInsteadOfOverwriting', async () => {
    // 并发保存：A 端读到 version=3，B 端先写成 version=4。A 再保存必须失败，
    // 否则 B 已成功的写入被 A 的旧快照静默覆盖。
    vi.mocked(mapper.findByUserId).mockResolvedValue({ userId: 20, groupOrder: '[]', collapsedGroups: '[]', groupAliases: '{}', version: 4 });
    await expect(service.save(20, {
      groupOrder: ['a'],
      collapsedGroups: [],
      groupAliases: {},
      expectedVersion: 3,
    })).rejects.toBeInstanceOf(TaskPanelPreferenceConflictException);
    expect(mapper.updateByUserId).not.toHaveBeenCalled();
  });

  it('saveRejectsWhenConcurrentWriteLandsBetweenSelectAndUpdate', async () => {
    // SELECT 与 UPDATE 之间被抢先：updateByUserId 返回 false，同样按冲突处理。
    vi.mocked(mapper.findByUserId).mockResolvedValue({ userId: 21, groupOrder: '[]', collapsedGroups: '[]', groupAliases: '{}', version: 2 });
    vi.mocked(mapper.updateByUserId).mockResolvedValue(false);
    await expect(service.save(21, { groupOrder: ['a'], collapsedGroups: [], groupAliases: {} }))
      .rejects.toBeInstanceOf(TaskPanelPreferenceConflictException);
  });

  it('saveBumpsVersionOnSuccessAndKeepsWorkingWithoutExpectedVersion', async () => {
    // 旧客户端不传 expectedVersion：不校验但仍返回新版本号
    vi.mocked(mapper.findByUserId).mockResolvedValue({ userId: 22, groupOrder: '[]', collapsedGroups: '[]', groupAliases: '{}', version: 7 });
    const saved = await service.save(22, { groupOrder: ['a'], collapsedGroups: [], groupAliases: {} });
    expect(saved.version).toBe(8);
    const written = vi.mocked(mapper.updateByUserId).mock.calls.at(-1)![0];
    expect(written.version).toBe(7);

    // 新客户端带对版本号：正常写入并返回 +1
    const saved2 = await service.save(22, { groupOrder: ['b'], collapsedGroups: [], groupAliases: {}, expectedVersion: 7 });
    expect(saved2.version).toBe(8);
  });
});

describe('task-panel 别名归一化', () => {
  const mapper: UserTaskPanelPreferenceRepository = {
    findByUserId: vi.fn(),
    insert: vi.fn(),
    updateByUserId: vi.fn(async () => true),
  };
  const service = new UserTaskPanelPreferenceService(mapper);

  it('saveTrimsTruncatesAndFiltersInvalidEntries', async () => {
    vi.mocked(mapper.findByUserId).mockResolvedValue(null);
    const saved = await service.save(10, {
      groupOrder: [],
      collapsedGroups: [],
      groupAliases: {
        'LOCAL:/ws/a': '  AI 项目  ',
        // 方案 A：系统桶与渠道身份分组均允许别名
        'LOCAL:未设置': '未设置桶',
        'CLOUD:临时工作区': '临时桶',
        'FEISHU_PRIVATE:7': '私聊助手',
        'FEISHU_GROUP:/ws/f': '告警群',
        'DINGTALK_PRIVATE:7': '钉钉助手',
        'DINGTALK_GROUP:/ws/d': '项目群',
        'LOCAL:/ws/b': 'x'.repeat(60),
        '': '空 key',
        '   ': '空白 key',
        'LOCAL:/ws/c': '   ',
      },
    });
    expect(saved.groupAliases).toEqual({
      'LOCAL:/ws/a': 'AI 项目',
      'LOCAL:未设置': '未设置桶',
      'CLOUD:临时工作区': '临时桶',
      'FEISHU_PRIVATE:7': '私聊助手',
      'FEISHU_GROUP:/ws/f': '告警群',
      'DINGTALK_PRIVATE:7': '钉钉助手',
      'DINGTALK_GROUP:/ws/d': '项目群',
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

  it('allows system buckets and channel identity groups (方案 A 全部放开)', () => {
    expect(isGroupRenameable('LOCAL:未设置')).toBe(true);
    expect(isGroupRenameable('CLOUD:临时工作区')).toBe(true);
    expect(isGroupRenameable('FEISHU_PRIVATE:7')).toBe(true);
    expect(isGroupRenameable('FEISHU_GROUP:/ws/feishu-chat/1/oc_a')).toBe(true);
    expect(isGroupRenameable('DINGTALK_PRIVATE:7')).toBe(true);
    expect(isGroupRenameable('DINGTALK_GROUP:/ws/dingtalk-chat/1/p2p-x')).toBe(true);
  });

  it('rejects only empty keys', () => {
    expect(isGroupRenameable('')).toBe(false);
    expect(isGroupRenameable('   ')).toBe(false);
  });
});
