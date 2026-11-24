import type { Db } from '../db/db.js';

export interface RoleSkillGrantInput {
  skillName: string;
  agentId: number;
}

export interface RoleSkillGrantView {
  roleId: number;
  roleName: string;
  skillName: string;
  agentId: number;
}

/** 运行时按用户角色取技能名。includeAgentSpecific=false 时只留 agent_id = 0。 */
export interface RoleSkillNameQuery {
  namesForRoles(roleIds: number[], agentId: number, includeAgentSpecific: boolean): Promise<string[]>;
}

export class RoleSkillGrantRepository implements RoleSkillNameQuery {
  constructor(private readonly db: Db) {}

  async namesForRoles(roleIds: number[], agentId: number, includeAgentSpecific: boolean): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const placeholders = roleIds.map(() => '?').join(',');
    const scope = includeAgentSpecific ? '(agent_id = 0 OR agent_id = ?)' : 'agent_id = 0';
    const params = includeAgentSpecific ? [...roleIds, agentId] : roleIds;
    const rows = await this.db.query<{ skillName: string }>(
      `SELECT DISTINCT skill_name AS skillName FROM role_skill_grant
       WHERE role_id IN (${placeholders}) AND ${scope}`,
      params,
    );
    return rows.map((row) => row.skillName);
  }

  listByRole(roleId: number): Promise<RoleSkillGrantInput[]> {
    return this.db.query<RoleSkillGrantInput>(
      `SELECT skill_name AS skillName, agent_id AS agentId
       FROM role_skill_grant WHERE role_id = ? ORDER BY skill_name, agent_id`,
      [roleId],
    );
  }

  listAll(): Promise<RoleSkillGrantView[]> {
    return this.db.query<RoleSkillGrantView>(
      `SELECT g.role_id AS roleId, r.name AS roleName, g.skill_name AS skillName, g.agent_id AS agentId
       FROM role_skill_grant g
       INNER JOIN role r ON r.id = g.role_id AND r.deleted = 0
       ORDER BY r.name, g.skill_name, g.agent_id`,
    );
  }

  /** 覆盖式保存：先删后插，失败整单回滚。 */
  async replace(roleId: number, grants: readonly RoleSkillGrantInput[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute('DELETE FROM role_skill_grant WHERE role_id = ?', [roleId]);
      for (const grant of grants) {
        await tx.insert('role_skill_grant', {
          roleId,
          skillName: grant.skillName,
          agentId: grant.agentId,
        });
      }
    });
  }

  async deleteBySkillName(skillName: string): Promise<void> {
    await this.db.execute('DELETE FROM role_skill_grant WHERE skill_name = ?', [skillName]);
  }

  async deleteByAgentId(agentId: number): Promise<void> {
    await this.db.execute('DELETE FROM role_skill_grant WHERE agent_id = ?', [agentId]);
  }
}
