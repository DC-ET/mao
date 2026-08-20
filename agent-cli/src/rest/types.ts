/**
 * CLI 内自建类型。
 * SessionVO / MessagePage 对齐 backend-ts/src/session/session-vo.ts（@mao/contracts 没有）。
 * LoginVO / UserInfoVO / AgentVO / Result 对齐 shared/contracts/src（tsc rootDir 限制下不直接 path 引用，避免把 contracts 编进 dist）。
 */

export interface Result<T> {
  code: number;
  message: string;
  data?: T;
  timestamp: number;
}

export interface UserInfoVO {
  id?: number;
  username?: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  authSource?: string;
  permissions?: string[];
  isAdmin?: boolean;
}

export interface LoginVO {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: UserInfoVO;
}

export interface AgentVO {
  id?: number;
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  isDefault?: boolean;
}

export interface SessionVO {
  id?: number;
  agentId?: number | null;
  agentName?: string;
  title?: string | null;
  status?: string | null;
  isPinned?: boolean;
  isFavorite?: boolean;
  executionMode?: string | null;
  workspace?: string | null;
  isGit?: boolean | null;
  platform?: string | null;
  shell?: string | null;
  osVersion?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  startedAt?: string | null;
  phase?: string;
  summary?: string | null;
  elapsedMs?: number;
  projectKey?: string | null;
  contextTokens?: number | null;
  contextWindowTokens?: number | null;
  running?: boolean;
  unread?: boolean;
  permissionLevel?: string | null;
  modelId?: number;
  modelName?: string;
  modelSupportsVision?: boolean;
  pendingApprovalCount?: number;
  pendingQuestionCount?: number;
}

export interface MessageVO {
  id?: number;
  role?: string;
  content?: string | null;
  thinkingContent?: string | null;
  images?: string[];
  toolCallId?: string | null;
  toolCalls?: unknown;
  metadata?: string | null;
  tokenCount?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface MessagePage {
  messages: MessageVO[];
  hasMore: boolean;
  nextBeforeMessageId: number | null;
  compactionEvents?: unknown[];
}

export interface CreateSessionRequest {
  agentId?: number | null;
  title?: string | null;
  executionMode?: string | null;
  workspace?: string | null;
  cloudProjectKey?: string | null;
  workspaceMode?: string | null;
  gitCloneUrl?: string | null;
  gitBranch?: string | null;
  permissionLevel?: string | null;
  modelId?: number | null;
  isGit?: boolean | null;
  platform?: string | null;
  shell?: string | null;
  osVersion?: string | null;
}

export interface CloudProject {
  name: string;
  path: string;
  isGit: boolean;
}

export interface SafeModelVO {
  id?: number;
  name?: string;
  provider?: string | null;
  baseUrl?: string;
  modelId?: string;
  modelType?: string | null;
  contextWindowTokens?: number | null;
  supportsVision?: boolean;
  isDefault?: boolean;
  status?: number | null;
}
