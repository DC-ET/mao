import type { ChatRequest, ChatUsage, LlmModelConfig } from './llm/chat-request.js';
import type { Db } from '../db/db.js';
import type { ClientImpersonation } from '@mao/contracts';

export interface Session {
  id?: number;
  userId?: number | null;
  agentId?: number | null;
  modelId?: number | null;
  parentSessionId?: number | null;
  sessionType?: string | null;
  projectKey?: string | null;
  executionMode?: string | null;
  permissionLevel?: string | null;
  workspace?: string | null;
  isGit?: boolean | number | null;
  platform?: string | null;
  shellPath?: string | null;
  osVersion?: string | null;
  phase?: string | null;
  title?: string | null;
  lastActivityAt?: string | null;
  lastPromptTokens?: number | null;
  contextAnchorMsgId?: number | null;
}

export interface Message {
  id?: number;
  sessionId?: number;
  role?: string;
  content?: string | null;
  thinkingContent?: string | null;
  toolCallId?: string | null;
  toolCalls?: string | null;
  metadata?: string | null;
  tokenCount?: number | null;
  modelId?: number | null;
}

export interface Agent {
  id?: number;
  name?: string | null;
  systemPrompt?: string | null;
  tools?: string | null;
  skills?: string | null;
  skillNames?: string | null;
  configJson?: string | null;
  mcpServerIds?: string | null;
  compactionEnabled?: number | boolean | null;
  compactionContextWindowTokens?: number | null;
  compactionTriggerRatio?: number | null;
  compactionMaxSummaryTokens?: number | null;
}

export interface LlmModel {
  id?: number;
  name?: string | null;
  provider?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  modelId?: string | null;
  clientImpersonation?: string | null;
  contextWindowTokens?: number | null;
  supportsVision?: number | boolean | null;
  isDefault?: number | boolean | null;
  status?: number | null;
}

export interface FileChange {
  id?: number;
  messageId?: number;
  sessionId?: number;
  path?: string | null;
  type?: string | null;
  linesAdded?: number | null;
  linesDeleted?: number | null;
  totalLines?: number | null;
  diffMode?: string | null;
  beforeContent?: string | null;
  afterContent?: string | null;
  patchContent?: string | null;
  patchTruncated?: number | boolean | null;
  diffUnavailableReason?: string | null;
}

export interface SessionCompaction {
  id?: number;
  sessionId?: number;
  summaryText?: string | null;
  lastCompactedMsgId?: number | null;
  compactCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  compactModel?: string | null;
}

export interface SessionCompactionEvent {
  id?: number;
  sessionId?: number;
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
}

export interface UserCommand {
  id?: number;
  userId?: number;
  name?: string;
  content?: string;
}

export interface ContextAnchor {
  lastPromptTokens: number;
  contextAnchorMsgId: number;
}

export interface SessionMapper {
  selectById(id: number): Promise<Session | null>;
  lockActiveSessionById?(sessionId: number): Promise<Session | null>;
  selectByPhase?(phase: string): Promise<Session[]>;
  updateById?(session: Session): Promise<void>;
  /** CAS: SET phase=RUNNING WHERE id=? AND (phase <> 'RUNNING' OR phase IS NULL). Returns affected rows. */
  claimRunningIfIdle?(sessionId: number): Promise<number>;
  updatePhase?(sessionId: number, phase: string): Promise<void>;
}

export interface SessionService {
  getSession(sessionId: number): Promise<Session | null>;
  getMaxMessageId(sessionId: number): Promise<number>;
  loadContextAnchor(sessionId: number): Promise<ContextAnchor>;
  updateContextAnchor(sessionId: number, promptTokens: number, anchorMsgId: number): Promise<void>;
  clearContextAnchor(sessionId: number): Promise<void>;
  updateContextTokens(sessionId: number, tokens: number): Promise<void>;
  updatePhase(sessionId: number, phase: string): Promise<void>;
  saveMessage(
    sessionId: number,
    role: string,
    content: string | null,
    thinkingContent?: string | null,
    toolCallId?: string | null,
    toolCallsJson?: string | null,
    tokenCount?: number,
    modelId?: number | null,
    metadataJson?: string | null,
  ): Promise<Message>;
  getMessagesAfterId(sessionId: number, boundary: number): Promise<Message[]>;
  getMessages?(sessionId: number): Promise<Message[]>;
  cleanupIncompleteTail(sessionId: number): Promise<number>;
  cleanupIncompleteTailAfterId?(sessionId: number, afterMessageId: number): Promise<number>;
  enterWaitingApproval(sessionId: number): Promise<boolean>;
  restoreRunningAfterApproval(sessionId: number): Promise<boolean>;
  createSession?(
    userId: number | null | undefined,
    agentId: number | null | undefined,
    title: string,
    executionMode?: string | null,
    workspace?: string | null,
    permissionLevel?: string | null,
    isGit?: boolean | number | null,
    platform?: string | null,
    shellPath?: string | null,
    osVersion?: string | null,
    modelId?: number | null,
  ): Promise<Session>;
}

export interface SessionCompactionService {
  loadValidated(sessionId: number): Promise<SessionCompaction | null>;
  persist(
    sessionId: number,
    expectedRecord: SessionCompaction | null,
    expectedOldBoundary: number,
    newBoundary: number,
    boundaryContentSnapshot: string,
    summaryText: string,
    inputTokens: number,
    outputTokens: number,
    compactModel: string | null,
  ): Promise<boolean>;
  boundaryOf(record: SessionCompaction | null): number;
  findBySessionId?(sessionId: number): Promise<SessionCompaction | null>;
  deleteBySessionId?(sessionId: number): Promise<number>;
}

export interface SessionCompactionEventService {
  record(
    sessionId: number,
    triggerMode: string,
    prevBoundaryMsgId: number,
    boundaryMsgId: number,
    compactedCount: number,
    promptTokens: number,
    cachedTokens: number | null | undefined,
    completionTokens: number,
    summaryTokens: number,
    savedTokens: number,
    durationMs: number,
    compactModel: string | null,
  ): Promise<SessionCompactionEvent>;
}

export interface AgentMapper {
  selectById(id: number): Promise<Agent | null>;
}

export interface AgentExperienceService {
  listEnabledContents(agentId: number): Promise<string[]>;
}

export interface LlmModelMapper {
  selectById(id: number): Promise<LlmModel | null>;
  selectDefault?(): Promise<LlmModel | null>;
}

export interface FileChangeMapper {
  insert(change: FileChange): Promise<number>;
  selectByMessageAndPath?(messageId: number, path: string): Promise<FileChange | null>;
  updateById?(id: number, data: Partial<FileChange>): Promise<void>;
}

export interface UserCommandService {
  getByUserIdAndName(userId: number, name: string): Promise<UserCommand | null>;
}

export interface WsEvent {
  type: string;
  sessionId: number | null;
  data: unknown;
}

export function wsEvent(type: string, sessionId: number | null, data: unknown): WsEvent {
  return { type, sessionId, data };
}

export interface StreamingWsRegistry {
  hasConnection(userId: number): boolean;
  hasLocalClientConnection(userId: number): boolean;
  send(userId: number, event: WsEvent): void;
  sendToLocalClients(userId: number, event: WsEvent): void;
  subscribe?(userId: number, sessionId: number): void;
}

export interface SessionActivityHeartbeat {
  touch(sessionId: number | null | undefined): void;
  clear(sessionId: number): void;
}

export interface ActivityService {
  record?(sessionId: number, type: string, payload?: unknown): void;
}

export interface TaskTerminalService {
  finishExecution(sessionId: number, userId: number | null | undefined, phase: string, executionId: string, error?: string): Promise<void>;
}

export interface MessageMapper {
  selectValidBoundaryMessage(sessionId: number, boundary: number): Promise<Message | null>;
  selectLast?(sessionId: number): Promise<Message | null>;
  deleteById?(id: number): Promise<void>;
  deleteFromId?(sessionId: number, fromId: number): Promise<void>;
}

export function llmModelToConfig(model: LlmModel): LlmModelConfig {
  return {
    id: model.id,
    name: model.name ?? undefined,
    provider: model.provider ?? undefined,
    baseUrl: model.baseUrl ?? undefined,
    apiKey: model.apiKey ?? undefined,
    modelId: model.modelId ?? undefined,
    contextWindowTokens: model.contextWindowTokens ?? undefined,
    supportsVision: model.supportsVision === 1 || model.supportsVision === true,
    clientImpersonation: toClientImpersonation(model.clientImpersonation),
  };
}

function toClientImpersonation(value: string | null | undefined): ClientImpersonation {
  if (value === 'codex' || value === 'claude_code') return value;
  return 'none';
}

export function boolish(value: boolean | number | null | undefined): boolean | undefined {
  if (value == null) return undefined;
  return value === true || value === 1;
}

export type { ChatRequest, ChatUsage, LlmModelConfig, ClientImpersonation, Db };
