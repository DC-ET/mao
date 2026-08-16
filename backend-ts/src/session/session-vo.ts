import { javaLocalDateTimeString } from '../common/datetime.js';
import { idMapGet } from '../common/request.js';
import type {
  ApprovalRegistry,
  AskUserQuestionsRegistry,
  FileChange,
  LlmModelRef,
  Message,
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
  isGit?: boolean | null;
  platform?: string | null;
  shell?: string | null;
  osVersion?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  phase?: string;
  summary?: string | null;
  elapsedMs?: number;
  steps?: unknown;
  projectKey?: string | null;
  contextTokens?: number | null;
  running?: boolean;
  unread?: boolean;
  permissionLevel?: string | null;
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

export function toSessionVO(session: Session, agentMap: Map<number, { name: string }>, modelMap: Map<number, LlmModelRef>): SessionVO {
  const vo: SessionVO = {
    id: session.id,
    agentId: session.agentId,
    title: session.title,
    status: session.status,
    isPinned: session.isPinned != null && session.isPinned === 1,
    isFavorite: session.isFavorite != null && session.isFavorite === 1,
    executionMode: session.executionMode,
    workspace: session.workspace,
    platform: session.platform,
    shell: session.shellPath,
    osVersion: session.osVersion,
    createdAt: javaLocalDateTimeString(session.createdAt),
    updatedAt: javaLocalDateTimeString(session.updatedAt),
    phase: visiblePhase(session.phase),
    summary: session.summary,
    elapsedMs: session.elapsedMs != null ? session.elapsedMs : 0,
    projectKey: session.projectKey,
    contextTokens: session.contextTokens,
    permissionLevel: session.permissionLevel,
    running: session.phase === 'RUNNING' || session.phase === 'RESUMING' || session.phase === 'WAITING_APPROVAL',
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
  const agent = idMapGet(agentMap, session.agentId);
  if (agent) {
    vo.agentName = agent.name;
  }
  let model = idMapGet(modelMap, session.modelId);
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
  agentMap: Map<number, { name: string }>,
  modelMap: Map<number, LlmModelRef>,
): AdminSessionVO {
  const vo: AdminSessionVO = {
    id: session.id,
    userId: session.userId,
    agentId: session.agentId,
    title: session.title,
    status: session.status,
    executionMode: session.executionMode,
    phase: visiblePhase(session.phase),
    elapsedMs: session.elapsedMs != null ? session.elapsedMs : 0,
    projectKey: session.projectKey,
    workspace: session.workspace,
    contextTokens: session.contextTokens,
    createdAt: javaLocalDateTimeString(session.createdAt),
    updatedAt: javaLocalDateTimeString(session.updatedAt),
    lastActivityAt: javaLocalDateTimeString(session.lastActivityAt),
  };
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
  let model = idMapGet(modelMap, session.modelId);
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
    try {
      const parts = JSON.parse(raw) as unknown[];
      let text = '';
      const images: string[] = [];
      for (const part of parts) {
        if (part && typeof part === 'object' && !Array.isArray(part)) {
          const map = part as Record<string, unknown>;
          if (map.type === 'text' && map.text != null) {
            text += String(map.text);
          } else if (map.type === 'image_url') {
            const url = imageUrlFromPart(map);
            if (url) images.push(url);
          }
        }
      }
      vo.content = text;
      if (images.length > 0) {
        vo.images = images;
      }
    } catch {
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

export function isActivePhase(phase: string | null | undefined): boolean {
  return phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL' || phase === 'CANCELLING';
}

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
