import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { javaLocalDateTimeString } from '../common/datetime.js';
import { formatDateTime, shanghaiYmd } from '../common/json.js';
import type { AgentLookup, FileChange, Message, Session } from './types.js';
import type { SessionService } from './session.service.js';
import { renderMessageJsonl } from './message-jsonl.js';

export const EXPORT_MAX_BYTES = 5 * 1024 * 1024;

export interface SessionExportResult {
  filename: string;
  jsonl: string;
}

/**
 * 会话导出为 JSONL：首行是 export 元信息头，其后每行一条原始消息，
 * 行结构与压缩归档 `compaction-NNN.jsonl` 完全一致（见 message-jsonl.ts 与
 * `CompactionArchiveService.buildArchiveHint`），便于同一套脚本消费。
 * thinkingContent 不导出；内联图片 base64 替换为占位符（原图路径在 metadata.attachments）。
 */
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
    const jsonl = renderJsonl(session, agent?.name ?? null, messages, changes, now);
    if (Buffer.byteLength(jsonl, 'utf8') > this.maxBytes) {
      throw new BusinessException(ErrorCode.EXPORT_TOO_LARGE);
    }
    return { filename: sanitizeExportFileName(session.title, now), jsonl };
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

function renderJsonl(
  session: Session,
  agentName: string | null,
  messages: Message[],
  changes: FileChange[],
  now: Date,
): string {
  const header = {
    type: 'session_export',
    schemaVersion: 1,
    session: {
      id: session.id,
      title: session.title ?? null,
      sessionType: session.sessionType ?? null,
      parentSessionId: session.parentSessionId ?? null,
      agentName: agentName ?? null,
      executionMode: session.executionMode ?? null,
      workspace: session.workspace ?? null,
      createdAt: javaLocalDateTimeString(session.createdAt) ?? null,
    },
    exportedAt: formatDateTime(now),
    messageCount: messages.length,
    userRoundCount: messages.filter((message) => message.role === 'USER').length,
    fileChanges: aggregateChanges(changes),
  };
  const body = renderMessageJsonl(messages, groupChangesByMessage(changes));
  return `${JSON.stringify(header)}\n${body}`;
}

function groupChangesByMessage(changes: FileChange[]): Map<number, FileChange[]> {
  const map = new Map<number, FileChange[]>();
  for (const change of changes) {
    const messageId = Number(change.messageId);
    if (!Number.isFinite(messageId)) continue;
    const list = map.get(messageId);
    if (list) list.push(change);
    else map.set(messageId, [change]);
  }
  return map;
}

function aggregateChanges(changes: FileChange[]): Array<Record<string, unknown>> {
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
  return [...map.values()].map((item) => ({
    path: item.path,
    type: item.type,
    linesAdded: item.added,
    linesDeleted: item.deleted,
  }));
}

export function sanitizeExportFileName(title: string | null | undefined, now = new Date()): string {
  const raw = (title ?? '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const base = clipCodePoints(raw.length > 0 ? raw : '会话', TITLE_MAX_CODE_POINTS);
  const day = shanghaiYmd(now).replace(/-/g, '');
  return `${base}-${day}.jsonl`;
}

/** astral 字符（emoji 等）占两个 UTF-16 码元，按码元 slice 会留下孤立代理项。 */
const TITLE_MAX_CODE_POINTS = 80;

function clipCodePoints(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
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
