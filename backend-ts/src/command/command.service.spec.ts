import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { SYSTEM_USER_ID, UserCommandService } from './command.service.js';
import type { UserCommand, UserCommandRepository } from './types.js';

function command(id: number, userId: number, name: string, content: string, visibility?: string): UserCommand {
  return { id, userId, name, content, visibility };
}

describe('UserCommandService', () => {
  const repo: UserCommandRepository = {
    listByUserId: vi.fn(),
    listVisibleSystemForUser: vi.fn(async () => []),
    listIllegalSystemVisibilities: vi.fn(async () => []),
    isVisibleToUser: vi.fn(async () => false),
    listActiveRoles: vi.fn(async () => []),
    findActiveRolesByIds: vi.fn(async () => []),
    listActiveRoleGrants: vi.fn(async () => []),
    listPersonalAll: vi.fn(),
    listPersonalFiltered: vi.fn(),
    listPersonalPaged: vi.fn(async () => ({ records: [], total: 0 })),
    findByIdAndUserId: vi.fn(),
    findByUserIdAndName: vi.fn(),
    insert: vi.fn(async (c) => {
      c.id = c.id ?? 1;
      return c.id;
    }),
    insertWithVisibility: vi.fn(async (c) => {
      c.id = c.id ?? 1;
      return c.id!;
    }),
    updateById: vi.fn(),
    updateWithVisibility: vi.fn(),
    deleteById: vi.fn(),
  };
  const service = new UserCommandService(repo);

  it('listAvailableMergesSystemAndPersonalCommandsByName', async () => {
    const system = command(1, 0, 'build', 'system');
    const personalOverride = command(2, 7, 'build', 'personal');
    const personalOnly = command(3, 7, 'test', 'run');
    vi.mocked(repo.listVisibleSystemForUser).mockResolvedValueOnce([system]);
    vi.mocked(repo.listByUserId).mockResolvedValueOnce([personalOverride, personalOnly]);

    const result = await service.listAvailableForUser(7);
    expect(result.map((c) => c.content)).toEqual(['personal', 'run']);
  });

  it('lookupMethodsDelegateAndPreferPersonalCommandByName', async () => {
    const personal = command(10, 7, 'fix', 'personal');
    vi.mocked(repo.findByIdAndUserId).mockResolvedValue(personal);
    vi.mocked(repo.findByUserIdAndName).mockResolvedValue(personal);

    expect(await service.getByIdAndUserId(10, 7)).toBe(personal);
    expect(await service.getByUserIdAndName(7, 'fix')).toBe(personal);
    expect(service.isSystemCommand(command(1, 0, 'sys', 'c'))).toBe(true);
    expect(service.isSystemCommand(null)).toBe(false);
  });

  it('createValidatesNameAllowsSystemOverrideAndRejectsPersonalDuplicates', async () => {
    vi.mocked(repo.findByUserIdAndName).mockResolvedValue(null);
    const created = await service.create(7, '修复_build-1', 'content');
    expect(created.userId).toBe(7);
    expect(created.name).toBe('修复_build-1');
    expect(repo.insert).toHaveBeenCalledWith(created);

    await expect(service.create(7, 'bad name', 'content')).rejects.toBeInstanceOf(BusinessException);

    vi.mocked(repo.findByUserIdAndName).mockImplementation(async (userId) => {
      return userId === SYSTEM_USER_ID ? command(1, 0, 'system_name', 'system content') : null;
    });
    const override = await service.create(7, 'system_name', 'personal content');
    expect(override.userId).toBe(7);
    expect(override.name).toBe('system_name');

    vi.mocked(repo.findByUserIdAndName).mockResolvedValue(command(2, 7, 'dup', 'personal'));
    await expect(service.create(7, 'dup', 'content')).rejects.toBeInstanceOf(BusinessException);
  });

  it('updateRejectsMissingSystemOrDuplicateAndUpdatesNormalCommand', async () => {
    vi.mocked(repo.findByIdAndUserId).mockResolvedValue(null);
    await expect(service.update(7, 1, 'new', 'content')).rejects.toBeInstanceOf(BusinessException);

    vi.mocked(repo.findByIdAndUserId).mockResolvedValue(command(1, 0, 'sys', 'content'));
    await expect(service.update(0, 1, 'new', 'content')).rejects.toBeInstanceOf(BusinessException);

    const current = command(2, 7, 'old', 'old content');
    vi.mocked(repo.findByIdAndUserId).mockResolvedValue(current);
    vi.mocked(repo.findByUserIdAndName).mockResolvedValue(null);
    const updated = await service.update(7, 2, 'new', 'new content');
    expect(updated.name).toBe('new');
    expect(updated.content).toBe('new content');
    expect(repo.updateById).toHaveBeenCalledWith(current);
  });

  it('deleteRejectsMissingOrSystemAndDeletesNormalCommand', async () => {
    vi.mocked(repo.findByIdAndUserId).mockResolvedValue(null);
    await expect(service.delete(7, 1)).rejects.toBeInstanceOf(BusinessException);

    vi.mocked(repo.findByIdAndUserId).mockResolvedValue(command(1, 0, 'sys', 'content'));
    await expect(service.delete(0, 1)).rejects.toBeInstanceOf(BusinessException);

    vi.mocked(repo.findByIdAndUserId).mockResolvedValue(command(2, 7, 'own', 'content'));
    await service.delete(7, 2);
    expect(repo.deleteById).toHaveBeenCalledWith(2);
  });

  it('showsRoleScopedCommandsOnlyWhenTheUserOverlapsAndKeepsPersonalOverride', async () => {
    const global = command(1, 0, 'review', '全局', 'all');
    const scoped = command(2, 0, 'warehouse', '数仓', 'roles');
    vi.mocked(repo.listVisibleSystemForUser).mockResolvedValueOnce([global, scoped]);
    vi.mocked(repo.listByUserId).mockResolvedValueOnce([]);
    const visible = await service.listAvailableForUser(7);
    expect(visible.map((c) => c.name)).toEqual(['review', 'warehouse']);

    vi.mocked(repo.listVisibleSystemForUser).mockResolvedValueOnce([global]);
    vi.mocked(repo.listByUserId).mockResolvedValueOnce([]);
    const hidden = await service.listAvailableForUser(8);
    expect(hidden.map((c) => c.name)).toEqual(['review']);

    const personal = command(9, 8, 'warehouse', '我的');
    vi.mocked(repo.findByUserIdAndName).mockImplementation(async (userId, name) => {
      if (userId === 8 && name === 'warehouse') return personal;
      if (userId === 0 && name === 'warehouse') return scoped;
      return null;
    });
    expect(await service.getByUserIdAndName(8, 'warehouse')).toBe(personal);
    expect(repo.isVisibleToUser).not.toHaveBeenCalled();

    vi.mocked(repo.findByUserIdAndName).mockImplementation(async (userId, name) => (
      userId === 0 && name === 'warehouse' ? scoped : null
    ));
    vi.mocked(repo.isVisibleToUser).mockResolvedValueOnce(false);
    expect(await service.getByUserIdAndName(8, 'warehouse')).toBeNull();

    vi.mocked(repo.isVisibleToUser).mockResolvedValueOnce(true);
    expect(await service.getByUserIdAndName(7, 'warehouse')).toBe(scoped);
  });

  it('doesNotTreatUserZeroAsAPersonalBypassAndWarnsOnIllegalVisibility', async () => {
    const hidden = command(5, 0, 'secret', '正文', 'roles');
    vi.mocked(repo.listByUserId).mockClear();
    vi.mocked(repo.listVisibleSystemForUser).mockResolvedValueOnce([command(1, 0, 'review', '全局', 'all')]);
    const listed = await service.listAvailableForUser(0);
    expect(listed.map((c) => c.name)).toEqual(['review']);
    expect(repo.listByUserId).not.toHaveBeenCalled();

    vi.mocked(repo.findByUserIdAndName).mockImplementation(async (userId, name) => (
      userId === 0 && name === 'secret' ? hidden : null
    ));
    vi.mocked(repo.isVisibleToUser).mockResolvedValue(false);
    expect(await service.getByUserIdAndName(0, 'secret')).toBeNull();
    expect(repo.isVisibleToUser).toHaveBeenCalledWith(5, 0);

    const dirty = command(6, 0, 'oops', '正文', 'public');
    vi.mocked(repo.findByUserIdAndName).mockImplementation(async (userId, name) => (
      userId === 0 && name === 'oops' ? dirty : null
    ));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await service.getByUserIdAndName(4, 'oops')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('illegal visibility=public'));
    vi.mocked(repo.listIllegalSystemVisibilities).mockResolvedValueOnce([{ id: 6, visibility: 'public' }]);
    vi.mocked(repo.listVisibleSystemForUser).mockResolvedValueOnce([]);
    vi.mocked(repo.listByUserId).mockResolvedValueOnce([]);
    await service.listAvailableForUser(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('id=6'));
    warn.mockRestore();
  });
});
