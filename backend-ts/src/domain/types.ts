export interface Session {
  id?: number;
  userId?: number | null;
  agentId?: number | null;
  modelId?: number | null;
  title?: string | null;
  executionMode?: string | null;
  workspace?: string | null;
  permissionLevel?: string | null;
  phase?: string | null;
  status?: string | null;
  sessionType?: string | null;
  parentSessionId?: number | null;
  projectKey?: string | null;
  isGit?: number | null;
  platform?: string | null;
  shellPath?: string | null;
  osVersion?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Message {
  id?: number;
  sessionId?: number;
  role?: string | null;
  content?: string | null;
  toolCalls?: string | null;
  tokenCount?: number | null;
  modelId?: number | null;
  createdAt?: string | null;
}

export interface MessageQueueItem {
  id?: number;
  sessionId?: number;
  userId?: number;
  content?: string | null;
  images?: string | null;
  sortOrder?: number | null;
  status?: string | null;
  scheduledTaskId?: number | null;
  /** 入队来源（SCHEDULED/WEBHOOK/API，NULL=普通手工入队），消费侧据此透传收件箱徽标 */
  sourceType?: string | null;
  /** WEBHOOK 来源时的触发器绑定，消费终态后回写连续失败计数 */
  openTriggerId?: number | null;
  createdAt?: string | Date | null;
}

export interface Agent {
  id?: number;
  name?: string | null;
}

export interface LlmModel {
  id?: number;
  name?: string | null;
  provider?: string | null;
  status?: number | null;
  isDefault?: number | null;
  supportsVision?: number | null;
  contextWindowTokens?: number | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
  clientImpersonation?: string | null;
}

export interface UserRow {
  id?: number;
  username?: string;
  displayName?: string | null;
  lastLoginAt?: string | Date | null;
  passwordHash?: string | null;
  status?: number | null;
}

export interface SessionTodo {
  id?: number;
  sessionId?: number;
  content?: string | null;
  status?: string | null;
}

export interface ContentPart {
  type: string;
  text?: string;
  imageUrl?: { url: string };
}

export interface ToolCall {
  id: string;
  function: { name: string; arguments?: string | null };
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LocalSkillRef {
  name: string;
  folderName: string;
  description?: string;
}

export interface McpToolRef {
  serverId?: number | null;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schema?: Record<string, unknown>;
}

export interface McpServerRow {
  name: string;
  [key: string]: unknown;
}

export const WEIXIN_PROJECT_KEY = 'weixin-bot';
