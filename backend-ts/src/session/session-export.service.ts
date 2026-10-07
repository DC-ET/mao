import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { javaLocalDateTimeString } from '../common/datetime.js';
import { formatDateTime, shanghaiYmd } from '../common/json.js';
import type { AgentLookup, FileChange, Message, Session } from './types.js';
import type { SessionService } from './session.service.js';
import { toMessageVO } from './session-vo.js';

export const EXPORT_MAX_BYTES = 5 * 1024 * 1024;
const STEP_LIMIT = 500;

export interface SessionExportResult {
  filename: string;
  markdown: string;
}

/**
 * summary 为空时的极简预览：对齐前端 getToolInputPreview 的 command / path / query 首参，≤ 60 字符。
 */
export function fallbackToolInputPreview(input: Record<string, unknown> | null | undefined): string {
  if (!input) return '';
  const command = input.command;
  if (typeof command === 'string' && command.length > 0) return clip60(command);
  const path = input.path ?? input.file_path;
  if (typeof path === 'string' && path.length > 0) return clip60(path);
  const query = input.query;
  if (typeof query === 'string' && query.length > 0) return clip60(query);
  return '';
}

export function sanitizeExportFileName(title: string | null | undefined, now = new Date()): string {
  const raw = (title ?? '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const base = clipCodePoints(raw.length > 0 ? raw : '会话', TITLE_MAX_CODE_POINTS);
  const day = shanghaiYmd(now).replace(/-/g, '');
  return `${base}-${day}.md`;
}

/** astral 字符（emoji 等）占两个 UTF-16 码元，按码元 slice 会留下孤立代理项。 */
const TITLE_MAX_CODE_POINTS = 80;

function clipCodePoints(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}

export class SessionExportService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly agents: AgentLookup,
    private readonly maxBytes = EXPORT_MAX_BYTES,
  ) {}

  async render(session: Session, now = new Date()): Promise<SessionExportResult> {
    const parentId = sideTaskParentId(session);
    const messages = withoutParentCopies(await this.loadAllMessages(session.id!, parentId), parentId);
    const changes = changesForMessages(
      await this.sessionService.listFileChangeSummaries(session.id!, parentId),
      messages,
    );
    const agent = session.agentId != null ? await this.agents.findById(session.agentId) : null;
    const markdown = renderMarkdown(session, agent?.name ?? null, messages, changes, now);
    if (Buffer.byteLength(markdown, 'utf8') > this.maxBytes) {
      throw new BusinessException(ErrorCode.EXPORT_TOO_LARGE);
    }
    return { filename: sanitizeExportFileName(session.title, now), markdown };
  }

  private async loadAllMessages(sessionId: number, excludeSourceSessionId: number | null): Promise<Message[]> {
    const all: Message[] = [];
    let before: number | null = null;
    for (let pageNo = 0; pageNo < 200; pageNo++) {
      const page = await this.sessionService.getMessagesByRounds(sessionId, 50, before, {
        excludeSourceSessionId,
      });
      all.unshift(...page.messages);
      if (!page.hasMore || page.nextBeforeMessageId == null || page.nextBeforeMessageId === before) break;
      before = page.nextBeforeMessageId;
    }
    return all;
  }
}

function renderMarkdown(
  session: Session,
  agentName: string | null,
  messages: Message[],
  changes: FileChange[],
  now: Date,
): string {
  const visible = messages.map((message) => ({ message, text: visibleText(message) }));
  const rounds = visible.filter((item) => item.message.role === 'USER').length;
  const goal = visible.find((item) => item.message.role === 'USER')?.text ?? '';
  let conclusion = '';
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i].message.role === 'ASSISTANT' && visible[i].text.trim().length > 0) {
      conclusion = visible[i].text;
      break;
    }
  }
  const steps = collectSteps(messages);
  const files = aggregateChanges(changes);
  const lines = [
    `# ${session.title?.trim() || '未命名会话'}`,
    '',
    `元信息：Agent ${agentName ?? '—'} / 创建时间 ${javaLocalDateTimeString(session.createdAt) ?? '—'} / 导出时间 ${formatDateTime(now)} / 消息轮数 ${rounds}`,
    '',
    '## 任务目标',
    '',
    goal.trim().length > 0 ? goal : '（无）',
    '',
    '## 最终结论',
    '',
    conclusion.trim().length > 0 ? conclusion : '（无）',
    '',
    '## 关键步骤',
    '',
    ...renderSteps(steps),
    '',
    '## 文件变更',
    '',
    ...renderFiles(files),
    '',
  ];
  return lines.join('\n');
}

function visibleText(message: Message): string {
  return toMessageVO(message).content ?? '';
}

function collectSteps(messages: Message[]): string[] {
  const steps: string[] = [];
  for (const message of messages) {
    for (const call of parseToolCalls(message.toolCalls)) {
      const summary = typeof call.summary === 'string' ? call.summary.trim() : '';
      const preview = summary.length > 0 ? summary : fallbackToolInputPreview(callInput(call));
      if (preview.length === 0) continue;
      steps.push(preview);
    }
  }
  return steps;
}

function renderSteps(steps: string[]): string[] {
  if (steps.length === 0) return ['（无）'];
  const shown = steps.slice(0, STEP_LIMIT).map((step) => `- ${step}`);
  if (steps.length > STEP_LIMIT) {
    shown.push(`- （已截断，仅展示前 ${STEP_LIMIT} 条，共 ${steps.length} 条）`);
  }
  return shown;
}

function aggregateChanges(changes: FileChange[]): Array<{ path: string; type: string; added: number; deleted: number }> {
  const map = new Map<string, { path: string; type: string; added: number; deleted: number }>();
  for (const change of changes) {
    const path = change.filePath ?? '';
    if (path.length === 0) continue;
    const current = map.get(path) ?? { path, type: change.changeType ?? 'MODIFIED', added: 0, deleted: 0 };
    current.type = change.changeType ?? current.type;
    current.added += Number(change.linesAdded ?? 0);
    current.deleted += Number(change.linesDeleted ?? 0);
    map.set(path, current);
  }
  return [...map.values()];
}

function renderFiles(files: Array<{ path: string; type: string; added: number; deleted: number }>): string[] {
  if (files.length === 0) return ['（无）'];
  return files.map((file) => `- ${file.path} ${file.type} +${file.added} -${file.deleted}`);
}

function parseToolCalls(raw: unknown): Array<Record<string, unknown>> {
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) return [];
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
}

function callInput(call: Record<string, unknown>): Record<string, unknown> | null {
  const direct = asRecord(call.input) ?? asRecord(call.arguments);
  if (direct) return direct;
  const fn = asRecord(call.function);
  if (!fn) return null;
  const parsed = asRecord(fn.arguments);
  if (parsed) return parsed;
  if (typeof fn.arguments !== 'string' || fn.arguments.trim().length === 0) return null;
  try {
    return asRecord(JSON.parse(fn.arguments) as unknown);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function clip60(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

function sideTaskParentId(session: Session): number | null {
  if (session.sessionType !== 'SIDE_TASK' || session.parentSessionId == null) return null;
  const id = Number(session.parentSessionId);
  return Number.isFinite(id) ? id : null;
}

function withoutParentCopies(messages: Message[], parentId: number | null): Message[] {
  if (parentId == null) return messages;
  return messages.filter((message) => message.sourceSessionId == null || Number(message.sourceSessionId) !== parentId);
}

function changesForMessages(changes: FileChange[], messages: Message[]): FileChange[] {
  const ids = new Set(messages.map((message) => message.id).filter((id) => id != null).map((id) => Number(id)));
  return changes.filter((change) => change.messageId == null || ids.has(Number(change.messageId)));
}
