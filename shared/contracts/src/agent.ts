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

export interface AgentAvatarUploadVO {
  avatarUrl: string;
}

export interface SuggestedQuestionVO {
  id?: number;
  content?: string;
  sortOrder?: number | null;
}

export interface AgentVO {
  id?: number;
  name?: string;
  description?: string | null;
  /** Same-origin PNG upload URL; null means no custom avatar. */
  avatarUrl?: string | null;
  systemPrompt?: string;
  creatorId?: number | null;
  creatorName?: string | null;
  isDefault?: boolean;
  /** Agent 默认模型 ID：会话未显式选模型时的优先回退（null=未配置，再回退全局默认模型） */
  defaultModelId?: number | null;
  skillNames?: string[];
  mcpServerIds?: number[];
  experiences?: ExperienceVO[];
  suggestedQuestions?: SuggestedQuestionVO[];
  createdAt?: string | null;
}
