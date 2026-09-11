import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type {
  Agent,
  AgentExperience,
  AgentExperienceRepository,
  AgentRepository,
  AgentPromptVersion,
  AgentSuggestedQuestion,
  AgentSuggestedQuestionRepository,
} from './types.js';

export class MysqlAgentRepository implements AgentRepository {
  constructor(private readonly db: Db) {}

  selectList(keyword?: string | null): Promise<Agent[]> {
    const where: string[] = [notDeleted()];
    const params: unknown[] = [];
    if (keyword != null && keyword.length > 0) {
      where.push('name LIKE ?');
      params.push(`%${keyword}%`);
    }
    return this.db.query<Agent>(
      `SELECT * FROM agent WHERE ${where.join(' AND ')} ORDER BY is_default DESC, created_at DESC`,
      params,
    );
  }

  findById(id: number): Promise<Agent | null> {
    return this.db.queryOne<Agent>(`SELECT * FROM agent WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  selectById(id: number): Promise<Agent | null> {
    return this.findById(id);
  }

  async findByIds(ids: number[]): Promise<Agent[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.query<Agent>(
      `SELECT * FROM agent WHERE id IN (${placeholders}) AND ${notDeleted()}`,
      ids,
    );
  }

  findDefault(): Promise<Agent | null> {
    return this.db.queryOne<Agent>(
      `SELECT * FROM agent WHERE is_default = 1 AND ${notDeleted()} LIMIT 1`,
    );
  }

  async insert(agent: Agent): Promise<number> {
    const id = await this.db.transaction(async (tx) => {
      const id = await tx.insert('agent', {
        name: agent.name,
        description: agent.description,
        avatarUrl: agent.avatarUrl ?? null,
        systemPrompt: agent.systemPrompt,
        creatorId: agent.creatorId,
        configJson: agent.configJson,
        skillNames: agent.skillNames,
        mcpServerIds: agent.mcpServerIds,
        defaultModelId: agent.defaultModelId ?? null,
        isDefault: agent.isDefault ?? 0,
        deleted: 0,
      });
      await tx.insert('agent_prompt_versions', {
        agentId: id, version: 1, systemPrompt: agent.systemPrompt,
        operatorId: agent.creatorId ?? null, sourceVersion: null,
      });
      return id;
    });
    agent.id = id;
    return id;
  }

  async updateById(agent: Agent, operatorId: number, writePrompt: boolean): Promise<void> {
    if (agent.id == null) return;
    await this.db.transaction(async (tx) => {
      const current = await tx.queryOne<Agent>(
        `SELECT * FROM agent WHERE id = ? AND ${notDeleted()} FOR UPDATE`, [agent.id],
      );
      if (!current) throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
      if (!writePrompt) agent.systemPrompt = current.systemPrompt;
      await tx.updateById('agent', agent.id!, {
        name: agent.name,
        description: agent.description,
        avatarUrl: agent.avatarUrl ?? null,
        systemPrompt: agent.systemPrompt,
        creatorId: agent.creatorId,
        configJson: agent.configJson,
        skillNames: agent.skillNames ?? null,
        mcpServerIds: agent.mcpServerIds ?? null,
        defaultModelId: agent.defaultModelId ?? null,
        isDefault: agent.isDefault,
      });
      if (agent.systemPrompt !== current.systemPrompt) {
        await this.appendPromptVersion(tx, agent.id!, agent.systemPrompt, operatorId, null);
      }
    });
  }

  listPromptVersions(agentId: number): Promise<AgentPromptVersion[]> {
    return this.db.query<AgentPromptVersion>(
      'SELECT * FROM agent_prompt_versions WHERE agent_id = ? ORDER BY version DESC', [agentId],
    );
  }

  private async appendPromptVersion(
    tx: Db, agentId: number, systemPrompt: string,
    operatorId: number | null, sourceVersion: number | null,
  ): Promise<void> {
    const latest = await tx.queryOne<{ version: number }>(
      'SELECT version FROM agent_prompt_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1', [agentId],
    );
    await tx.insert('agent_prompt_versions', {
      agentId, version: (latest?.version ?? 0) + 1, systemPrompt, operatorId, sourceVersion,
    });
  }

  async rollbackPrompt(agentId: number, version: number, operatorId: number): Promise<Agent> {
    return this.db.transaction(async (tx) => {
      const agent = await tx.queryOne<Agent>(`SELECT * FROM agent WHERE id = ? AND ${notDeleted()} FOR UPDATE`, [agentId]);
      if (!agent) throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
      const target = await tx.queryOne<AgentPromptVersion>('SELECT * FROM agent_prompt_versions WHERE agent_id = ? AND version = ?', [agentId, version]);
      if (!target) throw new BusinessException(ErrorCode.PARAM_INVALID, '提示词版本不存在');
      if (target.systemPrompt !== agent.systemPrompt) {
        await tx.updateById('agent', agentId, { systemPrompt: target.systemPrompt });
        await this.appendPromptVersion(tx, agentId, target.systemPrompt, operatorId, version);
        agent.systemPrompt = target.systemPrompt;
      }
      return agent;
    });
  }

  async deleteById(id: number): Promise<void> {
    await this.db.updateById('agent', id, { deleted: 1 });
  }

  async clearDefaultFlag(): Promise<void> {
    await this.db.execute(`UPDATE agent SET is_default = 0 WHERE is_default = 1 AND ${notDeleted()}`);
  }

  async removeSkillName(skillName: string): Promise<number> {
    // 从所有 agent 的 skillNames JSON 数组中移除指定 skillName
    // 如果移除后数组为空，则置为 NULL
    const raw = await this.db.query<{ id: number; skillNames: string | null }>(
      `SELECT id, skill_names AS skillNames FROM agent WHERE skill_names IS NOT NULL AND ${notDeleted()}`,
    );
    let affected = 0;
    for (const row of raw) {
      if (row.skillNames == null) continue;
      try {
        const names: string[] = JSON.parse(row.skillNames);
        const idx = names.indexOf(skillName);
        if (idx === -1) continue;
        names.splice(idx, 1);
        const newVal = names.length === 0 ? null : JSON.stringify(names);
        await this.db.updateById('agent', row.id, { skillNames: newVal });
        affected++;
      } catch {
        // 跳过解析失败的记录
        continue;
      }
    }
    return affected;
  }
}

export class MysqlAgentExperienceRepository implements AgentExperienceRepository {
  constructor(private readonly db: Db) {}

  listByAgentId(agentId: number): Promise<AgentExperience[]> {
    return this.db.query<AgentExperience>(
      'SELECT * FROM agent_experiences WHERE agent_id = ? ORDER BY sort_order ASC, id ASC',
      [agentId],
    );
  }

  listEnabledByAgentId(agentId: number): Promise<AgentExperience[]> {
    return this.db.query<AgentExperience>(
      'SELECT * FROM agent_experiences WHERE agent_id = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC',
      [agentId],
    );
  }

  findById(id: number): Promise<AgentExperience | null> {
    return this.db.queryOne<AgentExperience>('SELECT * FROM agent_experiences WHERE id = ?', [id]);
  }

  async insert(experience: AgentExperience): Promise<number> {
    const id = await this.db.insert('agent_experiences', {
      agentId: experience.agentId,
      content: experience.content,
      sortOrder: experience.sortOrder ?? 0,
      enabled: experience.enabled ?? 1,
    });
    experience.id = id;
    return id;
  }

  async updateById(experience: AgentExperience): Promise<void> {
    if (experience.id == null) {
      return;
    }
    await this.db.updateById('agent_experiences', experience.id, {
      agentId: experience.agentId,
      content: experience.content,
      sortOrder: experience.sortOrder,
      enabled: experience.enabled,
    });
  }

  async deleteById(id: number): Promise<void> {
    await this.db.execute('DELETE FROM agent_experiences WHERE id = ?', [id]);
  }

  async deleteByAgentId(agentId: number): Promise<void> {
    await this.db.execute('DELETE FROM agent_experiences WHERE agent_id = ?', [agentId]);
  }
}

export class MysqlAgentSuggestedQuestionRepository implements AgentSuggestedQuestionRepository {
  constructor(private readonly db: Db) {}

  listByAgentId(agentId: number): Promise<AgentSuggestedQuestion[]> {
    return this.db.query<AgentSuggestedQuestion>(
      'SELECT * FROM agent_suggested_questions WHERE agent_id = ? ORDER BY sort_order ASC, id ASC',
      [agentId],
    );
  }

  findById(id: number): Promise<AgentSuggestedQuestion | null> {
    return this.db.queryOne<AgentSuggestedQuestion>(
      'SELECT * FROM agent_suggested_questions WHERE id = ?', [id],
    );
  }

  async insert(question: AgentSuggestedQuestion): Promise<number> {
    const id = await this.db.insert('agent_suggested_questions', {
      agentId: question.agentId,
      content: question.content,
      sortOrder: question.sortOrder ?? 0,
    });
    question.id = id;
    return id;
  }

  async updateById(question: AgentSuggestedQuestion): Promise<void> {
    if (question.id == null) return;
    await this.db.updateById('agent_suggested_questions', question.id, {
      agentId: question.agentId,
      content: question.content,
      sortOrder: question.sortOrder,
    });
  }

  async deleteById(id: number): Promise<void> {
    await this.db.execute('DELETE FROM agent_suggested_questions WHERE id = ?', [id]);
  }

  async deleteByAgentId(agentId: number): Promise<void> {
    await this.db.execute('DELETE FROM agent_suggested_questions WHERE agent_id = ?', [agentId]);
  }
}
