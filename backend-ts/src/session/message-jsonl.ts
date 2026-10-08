import type { FileChange } from './types.js';

const IMAGE_DATA_URI_PREFIX = 'data:image/';
const IMAGE_DATA_URI_PATTERN = /data:(image\/[a-zA-Z0-9.+-]+);base64,[A-Za-z0-9+/=]+/g;

/**
 * 压缩归档（harness/deps.ts 的 Message）与导出（session/types.ts 的 Message）两个定义的字段可选性不同
 * （sessionId、role 等有差异），JSONL 行只用到下述字段，这里取宽松交集共用序列化。
 */
interface MessageLike {
  id?: number | null;
  role?: string | null;
  content?: string | null;
  toolCallId?: string | null;
  toolCalls?: string | null;
  metadata?: string | null;
  tokenCount?: number | null;
  modelId?: number | null;
  createdAt?: string | null;
}

export interface FileChangeSummary {
  path: string | null | undefined;
  type: string | null | undefined;
  linesAdded: number;
  linesDeleted: number;
}

/**
 * 消息 JSONL 行：会话压缩归档（runtime 目录 compaction-NNN.jsonl）与会话导出共用同一套结构，
 * 字段口径见 CompactionArchiveService.buildArchiveHint。content / metadata 里的内联图片 base64
 * 替换为占位符，原图路径保留在 metadata.attachments[].path；thinkingContent 体积大且回查价值低，不写入。
 */
export function toMessageJsonlLine(message: MessageLike, fileChanges?: FileChange[]): Record<string, unknown> {
  const line: Record<string, unknown> = {
    id: message.id ?? null,
    role: message.role ?? null,
    content: message.content == null ? null : replaceImageDataUris(message.content),
    toolCallId: message.toolCallId ?? null,
    toolCalls: message.toolCalls ?? null,
    metadata: sanitizeMetadata(message.metadata),
    tokenCount: message.tokenCount ?? null,
    modelId: message.modelId ?? null,
    createdAt: message.createdAt ?? null,
  };
  if (fileChanges != null && fileChanges.length > 0) {
    line.fileChanges = fileChanges.map(toFileChangeSummary);
  }
  return line;
}

/** 逐行 JSON.stringify；行尾带 \n，与归档文件一致，便于追加与流式读取。 */
export function renderMessageJsonl(messages: MessageLike[], changesByMessage?: Map<number, FileChange[]>): string {
  if (messages.length === 0) return '';
  return messages
    .map((message) => JSON.stringify(toMessageJsonlLine(message, changesFor(message, changesByMessage))))
    .join('\n') + '\n';
}

function changesFor(message: MessageLike, changesByMessage?: Map<number, FileChange[]>): FileChange[] | undefined {
  if (changesByMessage == null || message.id == null) return undefined;
  return changesByMessage.get(message.id);
}

function toFileChangeSummary(change: FileChange): FileChangeSummary {
  return {
    path: change.filePath,
    type: change.changeType,
    linesAdded: Number(change.linesAdded ?? 0),
    linesDeleted: Number(change.linesDeleted ?? 0),
  };
}

function isImageDataUri(text: string): boolean {
  return text.startsWith(IMAGE_DATA_URI_PREFIX) && text.includes(';base64,');
}

function sanitizeMetadata(metadata: string | null | undefined): string | null {
  if (metadata == null) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      if (Array.isArray(root.attachments)) {
        let replaced = false;
        root.attachments = root.attachments.map((att) => {
          if (att == null || typeof att !== 'object' || Array.isArray(att)) return att;
          const item = att as Record<string, unknown>;
          if (typeof item.data_uri === 'string' && isImageDataUri(item.data_uri)) {
            replaced = true;
            const mime = (item.mime as string | undefined)
              ?? item.data_uri.slice(5, item.data_uri.indexOf(';base64'));
            return { ...item, data_uri: `[image data URI omitted: ${mime}]` };
          }
          return att;
        });
        if (replaced) return JSON.stringify(root);
      }
    }
  } catch {
    /* 非 JSON metadata，退回正则替换 */
  }
  return replaceImageDataUris(metadata);
}

function replaceImageDataUris(text: string): string {
  return text.replace(IMAGE_DATA_URI_PATTERN, '[image data URI omitted: $1]');
}
