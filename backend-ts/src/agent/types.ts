import type { ExperienceVO, SuggestedQuestionVO, AgentVO } from '@mao/contracts';
export type { ExperienceVO, SuggestedQuestionVO, AgentVO };

export interface Agent {
  id?: number;
  name: string;
  description?: string | null;
  avatarUrl?: string | null;
  systemPrompt: string;
  creatorId?: number | null;
  configJson?: string | null;
  skillNames?: string | null;
  mcpServerIds?: string | null;
  /** 关联的自定义 HTTP 工具 ID 列表（JSON 数组字符串），为空表示不启用 */
  httpToolIds?: string | null;
  /**
   * Git 凭据域白名单（JSON 数组字符串，技术方案 2026-11-06）：
   * null=未配置（跟随全局策略 gitToken.scopePolicy）；'[]'=显式禁止注入；非空=白名单。
   */
  gitAllowedDomains?: string | null;
  defaultModelId?: number | null;
  isDefault?: number | null;
  /** 1-启用 0-停用；缺省视为启用 */
  enabled?: number | null;
  /** 1-客户端新建会话可选 0-仅管理端可见；缺省视为可见 */
  clientVisible?: number | null;
  /** 1-启用团队经验库（挂载 团队经验/ 并注入路标节）0-停用；缺省视为启用（V169） */
  experienceLibraryEnabled?: number | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AgentPromptVersion {
  id?: number;
  agentId: number;
  version: number;
  systemPrompt: string;
  operatorId?: number | null;
  sourceVersion?: number | null;
  createdAt?: string | null;
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

export interface AgentSuggestedQuestion {
  id?: number;
  agentId: number;
  content: string;
  sortOrder?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface SuggestedQuestionInput {
  id?: number | null;
  content?: string | null;
  sortOrder?: number | null;
}

export interface AgentRepository {
  selectList(
    keyword?: string | null,
    includeDisabled?: boolean,
    clientVisibleOnly?: boolean,
    /** true=仅返回 git_allowed_domains IS NULL 的 Agent（管理后台「未配置」筛选）。 */
    missingGitAllowedDomains?: boolean,
  ): Promise<Agent[]>;
  findById(id: number): Promise<Agent | null>;
  findDefault(): Promise<Agent | null>;
  insert(agent: Agent): Promise<number>;
  updateById(agent: Agent, operatorId: number, writePrompt: boolean): Promise<void>;
  deleteById(id: number): Promise<void>;
  updateEnabled(id: number, enabled: number): Promise<void>;
  updateExperienceLibraryEnabled(id: number, experienceLibraryEnabled: number): Promise<void>;
  clearDefaultFlag(): Promise<void>;
  removeSkillName(skillName: string): Promise<number>;
  listPromptVersions(agentId: number): Promise<AgentPromptVersion[]>;
  rollbackPrompt(agentId: number, version: number, operatorId: number): Promise<Agent>;
  /**
   * 不过滤软删的轻量查询（技术方案 2026-11-06 D1）：只取 git_allowed_domains 一列。
   * 返回 null=agent id 不存在（故障）；{ domains: null }=行存在但未配置——两者必须可区分，
   * 所以不能用带 notDeleted() 的 findById（软删会退化成「查不到」）。
   */
  selectGitAllowedDomainsById(id: number): Promise<{ domains: string | null } | null>;
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

export interface AgentSuggestedQuestionRepository {
  listByAgentId(agentId: number): Promise<AgentSuggestedQuestion[]>;
  findById(id: number): Promise<AgentSuggestedQuestion | null>;
  insert(question: AgentSuggestedQuestion): Promise<number>;
  updateById(question: AgentSuggestedQuestion): Promise<void>;
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
