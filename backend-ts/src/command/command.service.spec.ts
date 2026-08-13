import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { SYSTEM_USER_ID, UserCommandService } from './command.service.js';
import type { UserCommand, UserCommandRepository } from './types.js';

function command(id: number, userId: number, name: string, content: string): UserCommand {
  return { id, userId, name, content };
}

describe('UserCommandService', () => {
  const repo: UserCommandRepository = {
    listByUserId: vi.fn(),
    findByIdAndUserId: vi.fn(),
    findByUserIdAndName: vi.fn(),
    insert: vi.fn(async (c) => {
      c.id = c.id ?? 1;
      return c.id;
    }),
    updateById: vi.fn(),
    deleteById: vi.fn(),
  };
  const service = new UserCommandService(repo);

  it('listAvailableMergesSystemAndPersonalCommandsByName', async () => {
    const system = command(1, 0, 'build', 'system');
    const personalOverride = command(2, 7, 'build', 'personal');
    const personalOnly = command(3, 7, 'test', 'run');
    vi.mocked(repo.listByUserId)
      .mockResolvedValueOnce([system])
      .mockResolvedValueOnce([personalOverride, personalOnly]);

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
});
