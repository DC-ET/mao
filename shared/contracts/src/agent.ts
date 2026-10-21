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
  /** false 表示已停用。使用侧列表不返回停用项；管理端 includeDisabled 时才会看到 */
  enabled?: boolean;
  /** false = 客户端「新建会话」的智能体列表不展示；不影响已绑定会话与按 agentId 指定的入口 */
  clientVisible?: boolean;
  /** Agent 默认模型 ID：会话未显式选模型时的优先回退（null=未配置，再回退全局默认模型） */
  defaultModelId?: number | null;
  skillNames?: string[];
  mcpServerIds?: number[];
  /** 关联的自定义 HTTP 工具 ID 列表（管理员在 Agent 表单多选；该 Agent 的会话可调用） */
  httpToolIds?: number[];
  experiences?: ExperienceVO[];
  suggestedQuestions?: SuggestedQuestionVO[];
  createdAt?: string | null;
}
