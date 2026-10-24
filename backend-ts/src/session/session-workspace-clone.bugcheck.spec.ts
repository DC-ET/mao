import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../testing/tmp-dir.js';
import { SessionService } from './session.service.js';

/**
 * 「以 Git 仓库创建工作区」失败时，不得删除已存在的项目工作区。
 *
 * 项目工作区是 <root>/<userId>/projects/<slug>（同用户同仓库的多个会话共用）。
 * initializeCloudWorkspace 在 clone 失败时无条件 deleteWorkspaceDirectory(projectPath)，
 * 于是第二次用同一仓库建会话（目录已存在，git clone 必然以 "already exists and is not
 * an empty directory" 失败）会把上一条会话正在使用的整个仓库连工作区一起删掉。
 */
function makeService(root: string, cloneResult: { success: boolean; error: string | null }) {
  const sessionRepo = {
    insert: vi.fn(async (s: { id?: number }) => { s.id = 11; return 11; }),
    updateById: vi.fn(),
    findById: vi.fn(),
    updateFields: vi.fn(),
    logicalDelete: vi.fn(),
    list: vi.fn(async () => []),
  };
  const service = new SessionService(
    sessionRepo as never,
    {
      insert: vi.fn(),
      updateById: vi.fn(),
      listBySession: vi.fn(async () => []),
      selectUserStarts: vi.fn(async () => []),
      selectRange: vi.fn(async () => []),
      selectToolMessagesByCallIds: vi.fn(async () => []),
    } as never,
    { listBySession: vi.fn(async () => []), listByMessageIds: vi.fn(async () => []) } as never,
    {
      requireDefaultAgent: vi.fn(async () => ({ id: 9, name: 'A' })),
      findById: vi.fn(async () => ({ id: 9, name: 'A', enabled: 1 })),
    } as never,
    { getWorkspaceRoot: () => root } as never,
    { detect: vi.fn(async () => ({ isGit: false, platform: 'linux', shell: 'bash', osVersion: 'Linux' })) } as never,
    { listAvailableForUser: vi.fn() } as never,
    { clone: vi.fn(async () => cloneResult) } as never,
    { deleteBySessionId: vi.fn(), loadValidated: vi.fn(async () => null), boundaryOf: vi.fn(() => 0) } as never,
    { deleteBySessionId: vi.fn() } as never,
  );
  return { service, sessionRepo };
}

describe('Git 克隆失败不得删除已有项目工作区', () => {
  it('第二次用同一个仓库建会话失败时，上一条会话的仓库文件必须保留', async () => {
    const root = useTmpDir('mao-clone-');
    const projectDir = join(root, '7', 'projects', 'demo');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'keep-me.txt'), 'uncommitted work', 'utf8');

    const { service, sessionRepo } = makeService(root, {
      success: false,
      error: 'fatal: destination path already exists and is not an empty directory',
    });

    await expect(service.createSession(
      7, null, 'again', 'CLOUD',
      null, null, null, null, null, null, null,
      null, 'git', 'https://git.acg.team/team/demo.git', null,
    )).rejects.toThrow();

    // 克隆失败只应回滚本次新建的会话，不能动既有的项目工作区
    expect(existsSync(join(projectDir, 'keep-me.txt'))).toBe(true);
    expect(sessionRepo.logicalDelete).toHaveBeenCalledWith(11);
  });
});
