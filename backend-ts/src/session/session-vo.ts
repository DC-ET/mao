import { javaLocalDateTimeString } from '../common/datetime.js';
import { isMultimodalContentParts } from '../common/multimodal-content.js';
import type { ContextManifest } from '../harness/core/context-manifest.js';
import type { InFlightToolCall } from '../harness/core/in-flight-tool-registry.js';
import { idMapGet } from '../common/request.js';
import { isActivePhase } from './util/session-group-key.js';
import type {
  ApprovalRegistry,
  AskUserQuestionsRegistry,
  FileChange,
  LlmModelRef,
  Message,
  PendingAskQuestion,
  Session,
  SessionActivity,
  SessionCompactionEvent,
  SessionTodo,
  SubagentExecution,
} from './types.js';
import type { MessageQueue } from './types.js';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 256000;

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
  source?: string | null;
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
  steps?: unknown;
  projectKey?: string | null;
  contextTokens?: number | null;
  /** 最近一次请求的构成快照；旧会话或超限丢弃时缺省。 */
  contextManifest?: ContextManifest | null;
  running?: boolean;
  unread?: boolean;
  permissionLevel?: string | null;
  memoryInjectionDisabled?: boolean;
  modelId?: number;
  modelName?: string;
  modelSupportsVision?: boolean;
  pendingApprovalCount?: number;
  pendingQuestionCount?: number;
  treePendingApprovalCount?: number;
  treePendingQuestionCount?: number;
  treeUnread?: boolean;
  treeRunning?: boolean;
  treeFailed?: boolean;
  runtimeStatus?: unknown;
}

export interface AdminSessionVO {
  id?: number;
  userId?: number;
  userName?: string;
  agentId?: number | null;
  agentName?: string;
  title?: string | null;
  status?: string | null;
  executionMode?: string | null;
  /** 会话类型：NORMAL=主会话、SIDE_TASK=边路任务、SUBAGENT=子代理。 */
  sessionType?: string | null;
  /** 边路 / 子代理会话的父会话 ID；主会话为 null。 */
  parentSessionId?: number | null;
  phase?: string;
  summary?: string | null;
  elapsedMs?: number;
  projectKey?: string | null;
  workspace?: string | null;
  contextTokens?: number | null;
  contextWindowTokens?: number;
  modelName?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastActivityAt?: string | null;
  /** 当前等待用户回答的 ask_user_questions 数量（内存态，phase 仍为 RUNNING）。 */
  pendingQuestionCount?: number;
  /** FAILED 会话的失败原因（runtime_status_json.executionError）；非失败态为 null。 */
  failureReason?: string | null;
  matchSnippet?: string | null;
}

export interface MessageVO {
  /** 落库消息为数字主键；等待回复中的伪消息用 `pending-ask-*` 字符串 ID。 */
  id?: number | string;
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
  fileChanges?: FileChangeVO[];
}

export interface FileChangeVO {
  path?: string | null;
  type?: string | null;
  linesAdded?: number;
  linesDeleted?: number;
  diffMode?: string | null;
  beforeContent?: string | null;
  afterContent?: string | null;
  patchContent?: string | null;
  patchTruncated: boolean;
  diffUnavailableReason?: string | null;
}

export interface CompactionEventVO {
  id?: number;
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

export function visiblePhase(phase: string | null | undefined): string {
  return phase === 'RESUMING' ? 'RUNNING' : phase ?? 'IDLE';
}

/**
 * 从 runtime_status_json 提取失败原因（executionError，由 TaskTerminalService.finishExecution
 * 在 FAILED 终态落库）。快照损坏、字段缺失或空串都返回 null，不让整份会话 VO 失败。
 * 仅在 phase 为 FAILED 时有值：执行中的会话 runtimeStatusJson 承载 compacting / llmRetry
 * 等瞬态，重试跑起来后旧 executionError 可能还没被覆盖，按相位取才能防止把上次失败原因
 * 误当成本次执行的现状。
 */
export function parseFailureReason(raw: string | null | undefined, phase: string | null | undefined): string | null {
  if (visiblePhase(phase) !== 'FAILED') return null;
  if (raw == null || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as { executionError?: unknown } | null;
    const reason = parsed?.executionError;
    return typeof reason === 'string' && reason.trim().length > 0 ? reason : null;
  } catch {
    return null;
  }
}

/** 落库快照损坏时当没有构成，不让整份会话 VO 失败。 */
export function parseContextManifest(raw: string | null | undefined): ContextManifest | null {
  if (raw == null || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as ContextManifest;
    if (parsed == null || !Array.isArray(parsed.sections)) return null;
    return {
      sections: parsed.sections,
      memoryIds: Array.isArray(parsed.memoryIds) ? parsed.memoryIds : [],
      estimatedWindowTokens: typeof parsed.estimatedWindowTokens === 'number' ? parsed.estimatedWindowTokens : null,
    };
  } catch {
    return null;
  }
}

export function toSessionVO(
  session: Session,
  agentMap: Map<number, { name: string; defaultModelId?: number | null }>,
  modelMap: Map<number, LlmModelRef>,
): SessionVO {
  const vo: SessionVO = {
    id: session.id,
    agentId: session.agentId,
    title: session.title,
    status: session.status,
    isPinned: session.isPinned != null && session.isPinned === 1,
    isFavorite: session.isFavorite != null && session.isFavorite === 1,
    executionMode: session.executionMode,
    workspace: session.workspace,
    source: session.source ?? 'web',
    platform: session.platform,
    shell: session.shellPath,
    osVersion: session.osVersion,
    createdAt: javaLocalDateTimeString(session.createdAt),
    updatedAt: javaLocalDateTimeString(session.updatedAt),
    startedAt: javaLocalDateTimeString(session.startedAt),
    phase: visiblePhase(session.phase),
    summary: session.summary,
    elapsedMs: session.elapsedMs != null ? session.elapsedMs : 0,
    projectKey: session.projectKey,
    contextTokens: session.contextTokens,
    contextManifest: parseContextManifest(session.contextManifestJson),
    permissionLevel: session.permissionLevel,
    memoryInjectionDisabled: session.memoryInjectionDisabled === 1,
    // 与 isActivePhase / treeRunning（fillTreeSignals）/ 删除提升守卫 / 桌面 ACTIVE_PHASES
    // 统一口径：CANCELLING 是取消流程进行中的活跃相位，漏列会让同一份会话列表响应里
    // running=false 与 treeRunning=true 自相矛盾，取消中的会话被当成空闲。
    running: isActivePhase(session.phase),
    unread: session.unread === 1,
  };
  if (session.isGit != null) {
    vo.isGit = session.isGit === true || session.isGit === 1;
  }
  if (session.stepsJson != null && session.stepsJson.trim().length > 0) {
    try {
      vo.steps = JSON.parse(session.stepsJson);
    } catch (e) {
      console.warn(`Failed to parse steps_json for session ${session.id}`, e);
    }
  }
  if (session.runtimeStatusJson != null && session.runtimeStatusJson.trim().length > 0) {
    try {
      vo.runtimeStatus = JSON.parse(session.runtimeStatusJson);
    } catch (e) {
      console.warn(`Failed to parse runtime_status_json for session ${session.id}`, e);
    }
  }
  const agent = idMapGet(agentMap, session.agentId);
  if (agent) {
    vo.agentName = agent.name;
  }
  let model: LlmModelRef | null | undefined = idMapGet(modelMap, session.modelId);
  if (model == null) {
    // 未显式选模型：优先展示 Agent 默认模型，再回退全局默认
    const agent = idMapGet(agentMap, session.agentId);
    model = agent?.defaultModelId != null ? idMapGet(modelMap, agent.defaultModelId) ?? null : null;
  }
  if (model == null) {
    model = modelMap.get(0);
  }
  if (model) {
    vo.modelId = model.id;
    vo.modelName = model.name;
    vo.modelSupportsVision = model.supportsVision != null && model.supportsVision === 1;
  }
  return vo;
}

export function toAdminSessionVO(
  session: Session,
  userMap: Map<number, { displayName?: string | null; username: string }>,
  agentMap: Map<number, { name: string; defaultModelId?: number | null }>,
  modelMap: Map<number, LlmModelRef>,
  matchSnippet?: string | null,
): AdminSessionVO {
  const vo: AdminSessionVO = {
    id: session.id,
    userId: session.userId,
    agentId: session.agentId,
    title: session.title,
    status: session.status,
    executionMode: session.executionMode,
    sessionType: session.sessionType ?? null,
    parentSessionId: session.parentSessionId ?? null,
    phase: visiblePhase(session.phase),
    failureReason: parseFailureReason(session.runtimeStatusJson, session.phase),
    elapsedMs: session.elapsedMs != null ? session.elapsedMs : 0,
    projectKey: session.projectKey,
    workspace: session.workspace,
    contextTokens: session.contextTokens,
    createdAt: javaLocalDateTimeString(session.createdAt),
    updatedAt: javaLocalDateTimeString(session.updatedAt),
    lastActivityAt: javaLocalDateTimeString(session.lastActivityAt),
  };
  if (matchSnippet != null) {
    vo.matchSnippet = matchSnippet;
  }
  if (session.userId != null) {
    const user = userMap.get(session.userId);
    if (user) {
      vo.userName = user.displayName != null ? user.displayName : user.username;
    }
  }
  if (session.agentId != null) {
    const agent = idMapGet(agentMap, session.agentId);
    if (agent) {
      vo.agentName = agent.name;
    }
  }
  let model: LlmModelRef | null | undefined = idMapGet(modelMap, session.modelId);
  if (model == null) {
    // 未显式选模型：优先展示 Agent 默认模型，再回退全局默认
    const agent = idMapGet(agentMap, session.agentId);
    model = agent?.defaultModelId != null ? idMapGet(modelMap, agent.defaultModelId) ?? null : null;
  }
  if (model == null) {
    model = modelMap.get(0);
  }
  if (model) {
    vo.modelName = model.name;
    vo.contextWindowTokens = resolveContextWindowTokens(model);
  } else {
    vo.contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
  return vo;
}

function resolveContextWindowTokens(model: LlmModelRef): number {
  if (model.contextWindowTokens != null && model.contextWindowTokens > 0) {
    return model.contextWindowTokens;
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function imageUrlFromPart(map: Record<string, unknown>): string | null {
  const nested = map.image_url ?? map.imageUrl;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const url = (nested as Record<string, unknown>).url;
    if (url != null && String(url).length > 0) return String(url);
  }
  if (typeof map.url === 'string' && map.url.length > 0) return map.url;
  return null;
}

/** Persist multimodal parts with Java/OpenAI `image_url` keys. */
export function toStoredContentJson(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(rewriteImageUrlKeys(content));
}

function rewriteImageUrlKeys(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
    const map = { ...(part as Record<string, unknown>) };
    if (map.type === 'image_url' && map.imageUrl != null && map.image_url == null) {
      map.image_url = map.imageUrl;
      delete map.imageUrl;
    }
    return map;
  });
}

export function toMessageVO(message: Message): MessageVO {
  const vo: MessageVO = {
    id: message.id,
    role: message.role,
    thinkingContent: message.thinkingContent,
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls,
    metadata: message.metadata,
    tokenCount: message.tokenCount,
    createdAt: javaLocalDateTimeString(message.createdAt),
    updatedAt: javaLocalDateTimeString(message.updatedAt),
  };
  const raw = message.content;
  if (raw != null && raw.trim().startsWith('[')) {
    let parts: unknown;
    try {
      parts = JSON.parse(raw);
    } catch {
      parts = undefined;
    }
    // 仅当整体确为多模态 content part 数组时才展开；纯文本 JSON 数组（[1,2,3]、["a","b"]、[]）
    // 在 DB 中与多模态数组无法区分，不校验结构会把 content 清空（与 session-history-loader 同口径）。
    if (parts !== undefined && isMultimodalContentParts(parts)) {
      let text = '';
      const images: string[] = [];
      for (const part of parts) {
        if (part.type === 'text' && part.text != null) {
          text += String(part.text);
        } else if (part.type === 'image_url') {
          const url = imageUrlFromPart(part);
          if (url) images.push(url);
        }
      }
      vo.content = text;
      if (images.length > 0) {
        vo.images = images;
      }
    } else {
      vo.content = raw;
    }
  } else {
    vo.content = raw;
  }
  return vo;
}

export function toMessageVOList(messages: Message[], changesByMsg: Map<number, FileChange[]>): MessageVO[] {
  return messages.map((msg) => {
    const vo = toMessageVO(msg);
    const changes = msg.id != null ? changesByMsg.get(msg.id) : undefined;
    if (changes != null && changes.length > 0) {
      vo.fileChanges = changes.map(toFileChangeVO);
    }
    return vo;
  });
}

/**
 * 把内存里等待作答的 ask_user_questions 补成一条进行中的助手消息。
 * 该轮 tool_calls 要等工具返回后才落库，管理端只读 DB 时会整段看不见。
 */
export function toPendingAskUserQuestionsMessageVOs(pending: PendingAskQuestion[]): MessageVO[] {
  if (pending.length === 0) return [];
  const toolCalls = pending.map((p) => ({
    id: p.requestId,
    name: 'ask_user_questions',
    input: p.metadata != null
      ? { questions: p.questions, metadata: p.metadata }
      : { questions: p.questions },
    summary: p.questions.length > 0
      ? `向用户提问（等待回复，${p.questions.length} 个问题）`
      : '向用户提问（等待回复）',
    status: 'running',
  }));
  return [{
    id: `pending-ask-${pending[0].requestId}`,
    role: 'ASSISTANT',
    content: null,
    toolCalls: JSON.stringify(toolCalls),
    tokenCount: 0,
    createdAt: javaLocalDateTimeString(new Date()),
  }];
}

/** 与 admin-message-compact 同口径：参数值超 8000 字符才截断，避免把大文件写入塞进轮询响应。 */
const IN_FLIGHT_ARG_FIELD_LIMIT = 8000;
const IN_FLIGHT_ARG_KEEP = 1500;

/**
 * 把内存里正在执行的工具调用补成一条进行中的助手消息。
 * 与 ask_user_questions 同因：该轮 tool_calls 要等工具全部返回后才落库，管理端只读 DB 时看不见。
 */
export function toInFlightToolCallsMessageVOs(pending: InFlightToolCall[]): MessageVO[] {
  if (pending.length === 0) return [];
  const toolCalls = pending.map((p) => ({
    id: p.id,
    name: p.name,
    input: parseToolArgumentsJson(p.arguments),
    status: 'running',
  }));
  return [{
    id: `pending-tool-${pending[0].id}`,
    role: 'ASSISTANT',
    content: null,
    toolCalls: JSON.stringify(toolCalls),
    tokenCount: 0,
    createdAt: javaLocalDateTimeString(new Date(pending[0].startedAt)),
  }];
}

/** 工具参数是模型下发的 JSON 字符串；解析失败时前端仍会按 name 渲染卡片。 */
function parseToolArgumentsJson(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' && value.length > IN_FLIGHT_ARG_FIELD_LIMIT) {
        record[key] = value.slice(0, IN_FLIGHT_ARG_KEEP)
          + `\n…（参数过长已省略，原文 ${value.length} 字符，完整内容见落库记录）`;
      }
    }
    return record;
  } catch {
    return undefined;
  }
}

export function toFileChangeVO(fc: FileChange): FileChangeVO {
  return {
    path: fc.filePath,
    type: fc.changeType,
    linesAdded: fc.linesAdded ?? undefined,
    linesDeleted: fc.linesDeleted ?? undefined,
    diffMode: fc.diffMode,
    beforeContent: fc.beforeContent,
    afterContent: fc.afterContent,
    patchContent: fc.patchContent,
    patchTruncated: fc.patchTruncated === true || fc.patchTruncated === 1,
    diffUnavailableReason: fc.diffUnavailableReason,
  };
}

export function toCompactionEventVO(event: SessionCompactionEvent): CompactionEventVO {
  return {
    id: event.id,
    triggerMode: event.triggerMode,
    prevBoundaryMsgId: event.prevBoundaryMsgId,
    boundaryMsgId: event.boundaryMsgId,
    compactedMessageCount: event.compactedMessageCount,
    promptTokens: event.promptTokens,
    cachedTokens: event.cachedTokens,
    completionTokens: event.completionTokens,
    summaryTokens: event.summaryTokens,
    savedTokens: event.savedTokens,
    durationMs: event.durationMs,
    compactModel: event.compactModel,
    createdAt: javaLocalDateTimeString(event.createdAt),
  };
}

export function toActivityVO(activity: SessionActivity) {
  return {
    id: activity.id,
    type: activity.type,
    target: activity.target,
    summary: activity.summary,
    status: activity.status,
    durationMs: activity.durationMs,
    createdAt: javaLocalDateTimeString(activity.createdAt),
  };
}

/* ------------------------------------------------------------------ *
 * run 轨迹读模型 VO（技术方案 2026-10-09-run-trace §5.2）
 * 只呈现事实：轮级 / 旁路调用 / 工具 / 标记均为已落库数据的聚合，不做质量判断。
 * ------------------------------------------------------------------ */

export interface RunTracePageVO {
  /** 本页 run，新到旧 */
  runs: RunTraceVO[];
  hasMore: boolean;
  /** 仅第一页返回；没有则 null。会话级「未归属」不塞进 run 列表 */
  unattributed: UnattributedGroupVO | null;
}

export interface UnattributedGroupVO {
  count: number;
  startedAt: string | null;
  endedAt: string | null;
  /** 这里的「轮」只是未归属的 llm_call，seq 在组内从 1 */
  rounds: TraceRoundVO[];
  tools: TraceToolVO[];
}

export interface RunTraceVO {
  /** 锚点用户消息 id */
  runId: number;
  userMessagePreview: string;
  startedAt: string | null;
  /** 未编辑过时只有一个 current */
  segments: TraceSegmentVO[];
  sideCalls: TraceSideCallVO[];
  subagentLinks: Array<{ sessionId: number; title: string | null }>;
  /** kind: 'compaction'；'interrupted' 已在轮上，标记列表只放 compaction */
  markers: TraceMarkerVO[];
  totals: {
    wallClockMs: number;
    costMicros: number | null;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    toolSuccess: number;
    toolError: number;
  };
}

export interface TraceSegmentVO {
  kind: 'before_edit' | 'current';
  rounds: TraceRoundVO[];
  unplacedTools: TraceToolVO[];
}

export interface TraceRoundVO {
  seq: number;
  modelName: string | null;
  /** run 内恒为 'agent'；未归属组不做轮 / 旁路之分，携带 llm_call 原始 scene */
  scene: string;
  /** llm_call.created_at：调用结束时刻，导出 CSV 的「时间」列 */
  createdAt: string | null;
  /** llm_call 主键：轮次行下钻的定位 key；历史行理论上恒有值（llm_call 才有这一行） */
  llmCallId: number | null;
  /**
   * 估算开始时刻（epoch ms）= Date.parse(created_at) − duration_ms；
   * 两侧任一缺失为 null（时间条带不画色条、tooltip 不显示，显示「—」）。
   * 不补 0、不用 createdAt 冒充起点：秒级 created_at 下是估算值，必须与事实区分。
   */
  startedAtMs: number | null;
  /** llm_call.provider 冗余快照列，轮次行展示用；null 时前端不渲染徽标 */
  provider: string | null;
  durationMs: number;
  firstTokenMs: number | null;
  retryCount: number;
  success: boolean;
  /** error_message 含 Cancelled by user */
  interrupted: boolean;
  errorMessage: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costMicros: number | null;
  slow: boolean;
  /** 「贵」为单轮成本口径（costMicros >= 阈值）；该轮模型未配价（costMicros 为 null）时为 false。 */
  expensive: boolean;
  tools: TraceToolVO[];
}

export interface TraceSideCallVO {
  scene: string;
  modelName: string | null;
  /** llm_call.created_at：调用结束时刻，导出 CSV 的「时间」列 */
  createdAt: string | null;
  /** 估算开始时刻（epoch ms）；口径与 TraceRoundVO.startedAtMs 一致 */
  startedAtMs: number | null;
  /** llm_call.provider 冗余快照列；null 时前端不渲染徽标 */
  provider: string | null;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costMicros: number | null;
  success: boolean;
}

export interface TraceToolVO {
  toolCallId: string | null;
  name: string;
  target: string | null;
  status: string;
  /** 历史行与未回填行为 null，UI 显示「—」 */
  durationMs: number | null;
  /**
   * 估算开始时刻（epoch ms）= session_activity.created_at − duration_ms；
   * 两侧任一缺失为 null（时间条带不画色条）。口径与 TraceRoundVO.startedAtMs 一致。
   */
  startedAtMs: number | null;
  approvalMark: string | null;
  /** 用户手动文件操作才是 user；工具活动与历史行是 null */
  actor: 'user' | 'agent' | null;
}

export interface TraceMarkerVO {
  kind: 'compaction';
  atMessageId: number;
  detail: string;
}

export function toTodoVO(todo: SessionTodo) {
  return {
    id: todo.id,
    content: todo.content,
    status: todo.status,
  };
}

export function toQueueMessageVO(item: MessageQueue) {
  const vo: {
    id?: number;
    sessionId?: number;
    content?: string | null;
    images?: string[];
    sortOrder?: number | null;
    createdAt?: string | null;
  } = {
    id: item.id,
    sessionId: item.sessionId,
    content: item.content,
    sortOrder: item.sortOrder,
    createdAt: javaLocalDateTimeString(item.createdAt),
  };
  if (item.images != null && item.images.trim().length > 0) {
    try {
      vo.images = JSON.parse(item.images) as string[];
    } catch (e) {
      console.warn(`Failed to parse images JSON for queue item ${item.id}`, e);
    }
  }
  return vo;
}

// 活跃相位唯一口径在 util/session-group-key.ts（ACTIVE_PHASES），此处转出以保持既有导入方不变
export { isActivePhase };

export function applySessionListSignals(
  sessions: Session[],
  vos: SessionVO[],
  sidesByParent: Map<number, Session[]>,
  approvalRegistry: ApprovalRegistry,
  questionRegistry: AskUserQuestionsRegistry,
): void {
  if (sessions.length === 0) {
    return;
  }
  const allIds = new Set(sessions.map((s) => s.id!).filter((id) => id != null));
  for (const sides of sidesByParent.values()) {
    for (const s of sides) {
      if (s.id != null) allIds.add(s.id);
    }
  }
  const approvalCounts = approvalRegistry.countForSessionIds([...allIds]);
  const questionCounts = questionRegistry.countPendingBySessionIds([...allIds]);
  for (let i = 0; i < sessions.length; i++) {
    fillTreeSignals(vos[i], sessions[i], sidesByParent.get(sessions[i].id!) ?? [], approvalCounts, questionCounts);
  }
}

function fillTreeSignals(
  vo: SessionVO,
  main: Session,
  sides: Session[],
  approvalCounts: Map<number, number>,
  questionCounts: Map<number, number>,
): void {
  let approval = approvalCounts.get(main.id!) ?? 0;
  let question = questionCounts.get(main.id!) ?? 0;
  let unread = main.unread === 1;
  let running = isActivePhase(main.phase);
  let failed = main.phase === 'FAILED';
  for (const st of sides) {
    approval += approvalCounts.get(st.id!) ?? 0;
    question += questionCounts.get(st.id!) ?? 0;
    unread = unread || st.unread === 1;
    running = running || isActivePhase(st.phase);
    failed = failed || st.phase === 'FAILED';
  }
  vo.pendingApprovalCount = approvalCounts.get(main.id!) ?? 0;
  vo.pendingQuestionCount = questionCounts.get(main.id!) ?? 0;
  vo.treePendingApprovalCount = approval;
  vo.treePendingQuestionCount = question;
  vo.treeUnread = unread;
  vo.treeRunning = running;
  vo.treeFailed = failed;
}

export function indexSubagentExecutions(executions: SubagentExecution[]): Map<number, SubagentExecution> {
  const map = new Map<number, SubagentExecution>();
  for (const exec of executions) {
    if (exec.childSessionId != null && !map.has(exec.childSessionId)) {
      map.set(exec.childSessionId, exec);
    }
  }
  return map;
}

/* ------------------------------------------------------------------ *
 * 记录详情读模型 VO（技术方案 2026-10-22-run-trace-deep-dive §5.3）
 * 轨迹主 VO 不带正文，按需拉取；配不上的字段一律 null，不猜、不抛错。
 * ------------------------------------------------------------------ */

/** 配对 llm_call 的完整元信息（配不上为 null）。 */
export interface TraceCallMetaVO {
  llmCallId: number | null;
  provider: string | null;
  protocol: string | null;
  stream: boolean | null;
  effort: string | null;
  scene: string | null;
  modelName: string | null;
  retryCount: number;
  firstTokenMs: number | null;
  durationMs: number;
  errorMessage: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costMicros: number | null;
  createdAt: string | null;
  /** 请求构成采集（V171）：系统提示词原文（截断带标记）；NULL = 未记录（历史行 / 无 system 消息） */
  systemPrompt: string | null;
  /** 请求的工具名清单（JSON 字符串数组）；NULL = 未记录（历史行 / 无工具） */
  toolsJson: string | null;
}

/** 工具记录详情：参数 / 结果原文 + 配对的调用元信息。 */
export interface TraceToolRecordVO {
  toolCallId: string;
  /** 助手消息 tool_calls 数组里该次调用的元素：name + argumentsJson 原文 */
  toolName: string | null;
  argumentsJson: string | null;
  /** TOOL 消息 content 原文（含 metadata 的审批标记由调用方从 resultMetadata 读） */
  resultContent: string | null;
  resultMetadata: string | null;
  /** 配对 llm_call 的完整元信息；配不上为 null */
  call: TraceCallMetaVO | null;
}

/** 轮次记录详情：调用元信息 + 该轮已声明且现存于会话内的工具（供抽屉内跳转）。 */
export interface TraceCallRecordVO {
  call: TraceCallMetaVO | null;
  /** toolCallId + 名称 + 目标摘要；近似归属仅用于跳转链接，内容以按 tool_call_id 的精确查询为准 */
  tools: Array<{ toolCallId: string; name: string; target: string | null }>;
  /**
   * 本轮窗口内的助手消息（含正文与思考），按 id 升序。窗口推导与 tools 同一语义
   * （本轮调用结束时刻含同刻 → 下一轮 agent 调用结束时刻排他；最后一轮上界开放）。
   * 通常一条；崩溃恢复 / 时钟缺失可能为零条，前端区分空态提示，不出假数据。
   */
  messages: Array<{
    messageId: number;
    content: string | null;
    thinkingContent: string | null;
    tokenCount: number | null;
    createdAt: string | null;
  }>;
}

/** 单条消息详情（用户消息抽屉等）：主键直查，无窗口推导。 */
export interface TraceMessageRecordVO {
  messageId: number;
  role: string | null;
  /** 原文；多模态数组时为 JSON 分片数组原样，前端合并文本分片 + 附件计数 */
  content: string | null;
  thinkingContent: string | null;
  tokenCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** 编辑重发的更新时刻；与 createdAt 相同视为未编辑 */
  edited: boolean;
}
