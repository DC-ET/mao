import type { AgentBrowserDepsEnsurer } from '../agent/agent.service.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { isValidSkillName } from '../harness/skill/skill-md.js';
import type { RoleRepository, UserRoleRepository } from '../user/types.js';
import type { RoleSkillGrantInput, RoleSkillGrantRepository, RoleSkillGrantView } from './role-skill-grant.repository.js';

export interface SkillGrantAgentLookup {
  findById(id: number): Promise<{ id?: number } | null>;
}

export interface SkillGrantLoader {
  hasSkill(name: string): boolean;
}

/**
 * 角色技能授权。运行时只暴露 namesFor；写入校验失败不碰表。
 * includeAgentSpecific 缺省为 true。当前 Agent 已软删时传 false，只留「全部 Agent」的授权。
 */
export class RoleSkillGrantService {
  constructor(
    private readonly repo: RoleSkillGrantRepository,
    private readonly userRoles: Pick<UserRoleRepository, 'findByUserId'>,
    private readonly roles: Pick<RoleRepository, 'findById'>,
    private readonly agents: SkillGrantAgentLookup,
    private readonly skillLoader: SkillGrantLoader,
    private readonly browserDepsEnsurer?: AgentBrowserDepsEnsurer,
  ) {}

  async namesFor(userId: number, agentId: number, includeAgentSpecific = true): Promise<string[]> {
    const memberships = await this.userRoles.findByUserId(userId);
    if (memberships.length === 0) return [];
    const roleIds = memberships.map((row) => row.roleId);
    return this.repo.namesForRoles(roleIds, agentId, includeAgentSpecific);
  }

  async listForRole(roleId: number): Promise<RoleSkillGrantInput[]> {
    await this.requireRole(roleId);
    return this.repo.listByRole(roleId);
  }

  listAll(): Promise<RoleSkillGrantView[]> {
    return this.repo.listAll();
  }

  async replaceForRole(roleId: number, rawGrants: unknown): Promise<void> {
    await this.requireRole(roleId);
    const grants = this.parseGrants(rawGrants);
    await this.assertAgentsExist(grants);
    await this.repo.replace(roleId, grants);
    const names = [...new Set(grants.map((grant) => grant.skillName))];
    this.browserDepsEnsurer?.ensureForSkills(names);
  }

  deleteBySkillName(skillName: string): Promise<void> {
    return this.repo.deleteBySkillName(skillName);
  }

  deleteByAgentId(agentId: number): Promise<void> {
    return this.repo.deleteByAgentId(agentId);
  }

  private async requireRole(roleId: number): Promise<void> {
    const role = await this.roles.findById(roleId);
    if (role == null) {
      throw new BusinessException(ErrorCode.ROLE_NOT_FOUND);
    }
  }

  private parseGrants(rawGrants: unknown): RoleSkillGrantInput[] {
    if (!Array.isArray(rawGrants)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'grants 必须是数组');
    }
    const grants: RoleSkillGrantInput[] = [];
    const seen = new Set<string>();
    const allAgents = new Set<string>();
    const specific = new Set<string>();
    for (const item of rawGrants) {
      if (item == null || typeof item !== 'object') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '授权项格式不正确');
      }
      const record = item as { skillName?: unknown; agentId?: unknown };
      if (typeof record.skillName !== 'string' || !isValidSkillName(record.skillName)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '技能名不合法');
      }
      if (!this.skillLoader.hasSkill(record.skillName)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `技能不存在: ${record.skillName}`);
      }
      const agentId = normalizeAgentId(record.agentId);
      const key = `${record.skillName}\0${agentId}`;
      if (seen.has(key)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '授权重复');
      }
      seen.add(key);
      if (agentId === 0) allAgents.add(record.skillName);
      else specific.add(record.skillName);
      grants.push({ skillName: record.skillName, agentId });
    }
    for (const name of allAgents) {
      if (specific.has(name)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `技能 ${name} 不能同时授权给全部 Agent 和某个 Agent`);
      }
    }
    return grants;
  }

  private async assertAgentsExist(grants: readonly RoleSkillGrantInput[]): Promise<void> {
    const ids = [...new Set(grants.map((grant) => grant.agentId).filter((id) => id !== 0))];
    for (const id of ids) {
      const agent = await this.agents.findById(id);
      if (agent == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'Agent 不存在或已删除');
      }
    }
  }
}

function normalizeAgentId(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'agentId 必须是非负整数');
  }
  return value;
}
