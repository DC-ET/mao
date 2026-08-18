import type { ExperienceVO, AgentVO } from '@mao/contracts';
export type { ExperienceVO, AgentVO };

export interface Agent {
  id?: number;
  name: string;
  description?: string | null;
  systemPrompt: string;
  creatorId?: number | null;
  configJson?: string | null;
  skillNames?: string | null;
  mcpServerIds?: string | null;
  isDefault?: number | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AgentTag {
  id?: number;
  agentId: number;
  tag: string;
}

export interface AgentExperience {
  id?: number;
  agentId: number;
  content: string;
  sortOrder?: number | null;
  enabled?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ExperienceInput {
  id?: number | null;
  content?: string | null;
  sortOrder?: number | null;
  enabled?: boolean | null;
}

export interface AgentRepository {
  selectList(keyword?: string | null): Promise<Agent[]>;
  findById(id: number): Promise<Agent | null>;
  findDefault(): Promise<Agent | null>;
  insert(agent: Agent): Promise<number>;
  updateById(agent: Agent): Promise<void>;
  deleteById(id: number): Promise<void>;
  clearDefaultFlag(): Promise<void>;
  removeSkillName(skillName: string): Promise<number>;
}

export interface AgentTagRepository {
  listByAgentId(agentId: number): Promise<AgentTag[]>;
  insert(tag: AgentTag): Promise<number>;
  deleteByAgentId(agentId: number): Promise<void>;
}

export interface AgentExperienceRepository {
  listByAgentId(agentId: number): Promise<AgentExperience[]>;
  listEnabledByAgentId(agentId: number): Promise<AgentExperience[]>;
  findById(id: number): Promise<AgentExperience | null>;
  insert(experience: AgentExperience): Promise<number>;
  updateById(experience: AgentExperience): Promise<void>;
  deleteById(id: number): Promise<void>;
  deleteByAgentId(agentId: number): Promise<void>;
}

export interface McpServerRecord {
  id: number;
  name: string;
  userId: number;
  status: string;
}

export interface McpServerValidator {
  validateForAgent(ids: number[]): Promise<number[]>;
}
