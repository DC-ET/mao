import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../common/error-code.js';
import { RoleSkillGrantService } from './role-skill-grant.service.js';
import type { RoleSkillGrantRepository } from './role-skill-grant.repository.js';

function service(opts?: {
  skills?: string[];
  agents?: number[];
  role?: { id: number } | null;
  rolesForUser?: number[];
}) {
  const skills = new Set(opts?.skills ?? ['bigdata', 'browser-use', 'git']);
  const agents = new Set(opts?.agents ?? [12]);
  const replace = vi.fn(async () => undefined);
  const namesForRoles = vi.fn(async () => ['bigdata']);
  const repo = {
    replace,
    namesForRoles,
    listByRole: vi.fn(async () => []),
    listAll: vi.fn(async () => []),
    deleteBySkillName: vi.fn(),
    deleteByAgentId: vi.fn(),
  } as unknown as RoleSkillGrantRepository;
  const ensureForSkills = vi.fn();
  const role = opts && 'role' in opts ? opts.role : { id: 3 };
  const svc = new RoleSkillGrantService(
    repo,
    { findByUserId: vi.fn(async () => (opts?.rolesForUser ?? [3, 4]).map((roleId) => ({ userId: 7, roleId }))) },
    { findById: vi.fn(async () => role) },
    { findById: vi.fn(async (id: number) => (agents.has(id) ? { id } : null)) },
    { hasSkill: (name: string) => skills.has(name) },
    { ensureForSkills },
  );
  return { svc, replace, ensureForSkills, namesForRoles };
}

describe('RoleSkillGrantService', () => {
  it('覆盖保存合法授权，并在写入后按名单 ensure', async () => {
    const { svc, replace, ensureForSkills } = service();
    await svc.replaceForRole(3, [
      { skillName: 'browser-use', agentId: 12 },
      { skillName: 'git' },
    ]);
    expect(replace).toHaveBeenCalledWith(3, [
      { skillName: 'browser-use', agentId: 12 },
      { skillName: 'git', agentId: 0 },
    ]);
    expect(ensureForSkills).toHaveBeenCalledWith(['browser-use', 'git']);
  });

  it('不含 browser-use 时 ensure 的名单也不含它', async () => {
    const { svc, ensureForSkills } = service();
    await svc.replaceForRole(3, [{ skillName: 'git', agentId: 0 }]);
    expect(ensureForSkills).toHaveBeenCalledWith(['git']);
    expect(ensureForSkills.mock.calls[0][0]).not.toContain('browser-use');
  });

  it('空数组清空，且不把校验失败写成半截数据', async () => {
    const { svc, replace, ensureForSkills } = service();
    await svc.replaceForRole(3, []);
    expect(replace).toHaveBeenCalledWith(3, []);
    expect(ensureForSkills).toHaveBeenCalledWith([]);

    replace.mockClear();
    await expect(svc.replaceForRole(3, undefined)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(svc.replaceForRole(3, [{ skillName: 'nope', agentId: 0 }])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(svc.replaceForRole(3, [{ skillName: 'Not Skill', agentId: 0 }])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(svc.replaceForRole(3, [{ skillName: 'git', agentId: 99 }])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(svc.replaceForRole(3, [{ skillName: 'git', agentId: -1 }])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(svc.replaceForRole(3, [{ skillName: 'git', agentId: 1.5 }])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(svc.replaceForRole(3, [{ skillName: 'git', agentId: '12' }])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(svc.replaceForRole(3, [
      { skillName: 'git', agentId: 0 },
      { skillName: 'git', agentId: 0 },
    ])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(svc.replaceForRole(3, [
      { skillName: 'git', agentId: 0 },
      { skillName: 'git', agentId: 12 },
    ])).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(replace).not.toHaveBeenCalled();
  });

  it('停用但未删除的 Agent 可以写入；角色不存在不写表', async () => {
    const { svc, replace } = service({ agents: [8] });
    await svc.replaceForRole(3, [{ skillName: 'git', agentId: 8 }]);
    expect(replace).toHaveBeenCalled();

    const missing = service({ role: null });
    await expect(missing.svc.replaceForRole(9, [])).rejects.toMatchObject({ code: ErrorCode.ROLE_NOT_FOUND.code });
    expect(missing.replace).not.toHaveBeenCalled();
    await expect(missing.svc.listForRole(9)).rejects.toMatchObject({ code: ErrorCode.ROLE_NOT_FOUND.code });
  });

  it('用户没有角色时不查授权表；有多个角色时把 id 交给查询', async () => {
    const none = service({ rolesForUser: [] });
    expect(await none.svc.namesFor(7, 12)).toEqual([]);
    expect(none.namesForRoles).not.toHaveBeenCalled();

    const { svc, namesForRoles } = service({ rolesForUser: [3, 4] });
    expect(await svc.namesFor(7, 12)).toEqual(['bigdata']);
    expect(namesForRoles).toHaveBeenCalledWith([3, 4], 12, true);
    await svc.namesFor(7, 12, false);
    expect(namesForRoles).toHaveBeenCalledWith([3, 4], 12, false);
  });
});
