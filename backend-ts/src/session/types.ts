import type { MessageSearchItem } from '@mao/contracts';
export type { MessageSearchItem };

export interface Session {
  id?: number;
  userId: number;
  agentId?: number | null;
  title?: string | null;
  status?: string | null;
  isPinned?: number | null;
  isFavorite?: number | null;
  executionMode?: string | null;
  workspace?: string | null;
  permissionLevel?: string | null;
  modelId?: number | null;
  isGit?: boolean | number | null;
  platform?: string | null;
  shellPath?: string | null;
  osVersion?: string | null;
  phase?: string | null;
  summary?: string | null;
  startedAt?: string | null;
  elapsedMs?: number | null;
  stepsJson?: string | null;
  projectKey?: string | null;
  lastActivityAt?: string | null;
  contextTokens?: number | null;
  lastPromptTokens?: number | null;
  contextAnchorMsgId?: number | null;
  unread?: number | null;
  parentSessionId?: number | null;
  sessionType?: string | null;
  runtimeStatusJson?: string | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Message {
  id?: number;
  sessionId: number;
  role: string;
  content?: string | null;
  thinkingContent?: string | null;
  toolCallId?: string | null;
  toolCalls?: string | null;
  tokenCount?: number | null;
  modelId?: number | null;
  metadata?: string | null;
  sourceSessionId?: number | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface FileChange {
  id?: number;
  messageId: number;
  sessionId: number;
  filePath?: string | null;
  changeType?: string | null;
  linesAdded?: number | null;
  linesDeleted?: number | null;
  diffMode?: string | null;
  beforeContent?: string | null;
  afterContent?: string | null;
  patchContent?: string | null;
  patchTruncated?: boolean | number | null;
  diffUnavailableReason?: string | null;
  createdAt?: string | null;
}

export interface MessageQueue {
  id?: number;
  sessionId: number;
  userId?: number | null;
  content?: string | null;
  images?: string | null;
  sortOrder?: number | null;
  status?: string | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface SessionCompaction {
  id?: number;
  sessionId: number;
  summaryText?: string | null;
  lastCompactedMsgId?: number | null;
  compactCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  compactModel?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface SessionCompactionEvent {
  id?: number;
  sessionId: number;
  triggerMode?: string | null;
  prevBoundaryMsgId?: number | null;
  boundaryMsgId?: number | null;
  compactedMessageCount?: number | null;
  promptTokens?: number | null;
  cachedTokens?: number | null;
  completionTokens?: number | null;
  summaryTokens?: number | null;
  savedTokens?: number | null;
  durationMs?: number | null;
  compactModel?: string | null;
  createdAt?: string | null;
}

export interface SessionActivity {
  id?: number;
  sessionId: number;
  type?: string | null;
  target?: string | null;
  summary?: string | null;
  detailJson?: string | null;
  status?: string | null;
  durationMs?: number | null;
  createdAt?: string | null;
}

export interface SessionTodo {
  id?: number;
  sessionId: number;
  content?: string | null;
  description?: string | null;
  activeForm?: string | null;
  status?: string | null;
  sortOrder?: number | null;
  owner?: string | null;
  claimedAt?: string | null;
  blockedBy?: string | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface SubagentExecution {
  id?: number;
  parentSessionId?: number | null;
  childSessionId?: number | null;
  agentType?: string | null;
  invocationType?: 'DELEGATE' | 'FOLLOWUP' | 'BACKGROUND' | null;
  parentToolCallId?: string | null;
  deliveryStatus?: 'PENDING' | 'DELIVERED' | 'SUPPRESSED' | 'LEGACY' | null;
  parentResultDeliveredAt?: string | null;
  parentAssistantMessageId?: number | null;
  parentToolMessageId?: number | null;
  executionStartMessageId?: number | null;
  finalMessageId?: number | null;
  taskDescription?: string | null;
  result?: string | null;
  status?: string | null;
  totalRounds?: number | null;
  totalPromptTokens?: number | null;
  totalCompletionTokens?: number | null;
  totalToolCalls?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AgentRef {
  id: number;
  name: string;
  skillNames?: string | null;
}

export interface LlmModelRef {
  id: number;
  name: string;
  provider?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  modelId?: string | null;
  clientImpersonation?: string | null;
  contextWindowTokens?: number | null;
  supportsVision?: number | null;
  isDefault?: number | null;
  status?: number | null;
}

export interface UserRef {
  id: number;
  username: string;
  displayName?: string | null;
}

export interface UserCommandRef {
  name: string;
  content: string;
}

export interface AgentLookup {
  findById(id: number): Promise<AgentRef | null>;
  findByIds(ids: number[]): Promise<AgentRef[]>;
  requireDefaultAgent(): Promise<AgentRef>;
  listOptions(): Promise<Array<{ id: number; name: string }>>;
}

export interface LlmModelLookup {
  findById(id: number): Promise<LlmModelRef | null>;
  findByIds(ids: number[]): Promise<LlmModelRef[]>;
  findDefault(): Promise<LlmModelRef | null>;
}

export interface UserLookup {
  findByIds(ids: number[]): Promise<UserRef[]>;
  listOptions(): Promise<UserRef[]>;
}

export interface UserCommandLookup {
  listAvailableForUser(userId: number): Promise<UserCommandRef[]>;
}

export interface GitCredentialLookup {
  getTokenMapByUser(userId: number): Promise<Record<string, string>>;
}

export interface ApprovalRegistry {
  countForSessionIds(ids: number[]): Map<number, number>;
}

export interface AskUserQuestionsRegistry {
  countPendingBySessionIds(ids: number[]): Map<number, number>;
}

export interface SessionTreeSignalPublisher {
  publish(sessionId: number): void;
}

export interface SessionGroupBucket {
  key: string;
  label: string;
  total: number;
  hasMore: boolean;
  sessions: Session[];
}

export interface SessionGroupPage {
  items: Session[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
  nextBeforeMessageId: number | null;
}

export interface ContextAnchor {
  lastPromptTokens: number;
  contextAnchorMsgId: number;
}

export function emptyApprovalRegistry(): ApprovalRegistry {
  return { countForSessionIds: () => new Map() };
}

export function emptyQuestionRegistry(): AskUserQuestionsRegistry {
  return { countPendingBySessionIds: () => new Map() };
}

export function noopTreePublisher(): SessionTreeSignalPublisher {
  return { publish: () => undefined };
}
