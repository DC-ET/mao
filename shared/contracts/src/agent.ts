/**
 * Agent 管理契约。
 * 注意：Agent 实体（含 configJson、systemPrompt 等内部字段）保留在后端，这里仅共享视图对象。
 */
export interface ExperienceVO {
  id?: number;
  content?: string;
  sortOrder?: number | null;
  enabled?: boolean;
}

export interface AgentVO {
  id?: number;
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  creatorId?: number | null;
  creatorName?: string | null;
  isDefault?: boolean;
  skillNames?: string[];
  mcpServerIds?: number[];
  experiences?: ExperienceVO[];
  createdAt?: string | null;
}
