import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspacePath } from '../paths';

const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function extractFilePath(args: Record<string, unknown>): string | undefined {
  const v = args.path ?? args.file ?? args.filePath ?? args.file_path ?? args.target_file;
  return typeof v === 'string' ? v : undefined;
}

function mimeFromPath(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  for (const [ext, mime] of Object.entries(IMAGE_EXT)) {
    if (lower.endsWith(ext)) return mime;
  }
  return null;
}

function detectMimeFromBytes(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return 'image/webp';
  return null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readImage(resolvedPath: string, filePath: string): Record<string, unknown> {
  const sizeBytes = fs.statSync(resolvedPath).size;
  if (sizeBytes > MAX_IMAGE_BYTES) {
    return { content: `错误：文件过大（${formatSize(sizeBytes)}），图片读取上限为 ${formatSize(MAX_IMAGE_BYTES)}：${filePath}`, total_lines: 0 };
  }
  const buffer = fs.readFileSync(resolvedPath);
  const mime = detectMimeFromBytes(buffer);
  if (!mime) return { content: `错误：不支持的图片格式或文件内容无效：${filePath}`, total_lines: 0 };
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;
  return {
    content: `图片读取成功：${filePath} (${mime}, ${formatSize(buffer.length)})`,
    total_lines: 0,
    media_type: 'image',
    mime,
    path: filePath,
    size_bytes: buffer.length,
    data_uri: dataUri,
  };
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n');
}

export function computeLineDelta(beforeContent: string, afterContent: string): { linesAdded: number; linesDeleted: number } {
  const oldLines = splitLines(beforeContent);
  const newLines = splitLines(afterContent);
  if (oldLines.length === 0) return { linesAdded: newLines.length, linesDeleted: 0 };
  if (newLines.length === 0) return { linesAdded: 0, linesDeleted: oldLines.length };
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix--;
    newSuffix--;
  }
  const oldChanged = oldSuffix - prefix + 1;
  const newChanged = newSuffix - prefix + 1;
  return {
    linesAdded: Math.max(0, newChanged),
    linesDeleted: Math.max(0, oldChanged),
  };
}

export function handleReadFile(args: Record<string, unknown>, workspace: string | undefined, sessionId: number): Record<string, unknown> {
  try {
    const filePath = extractFilePath(args);
    if (!filePath) return { content: '错误：缺少必填参数 path', total_lines: 0 };
    const resolvedPath = resolveWorkspacePath(filePath, workspace, sessionId);
    if (!fs.existsSync(resolvedPath)) return { content: `错误：文件不存在：${filePath}`, total_lines: 0 };
    if (!fs.statSync(resolvedPath).isFile()) return { content: `错误：不是普通文件：${filePath}`, total_lines: 0 };
    if (mimeFromPath(filePath)) return readImage(resolvedPath, filePath);
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const lines = content.split('\n');
    const start = Number(args.offset ?? 0) || 0;
    const end = args.limit != null ? Math.min(start + Number(args.limit), lines.length) : lines.length;
    return { content: lines.slice(start, end).join('\n'), total_lines: lines.length };
  } catch (e) {
    return { content: `错误：${e instanceof Error ? e.message : String(e)}`, total_lines: 0 };
  }
}

export function handleWriteFile(args: Record<string, unknown>, workspace: string | undefined, sessionId: number): Record<string, unknown> {
  try {
    const filePath = extractFilePath(args);
    if (!filePath) return { error: '缺少必填参数 path' };
    const content = typeof args.content === 'string' ? args.content : '';
    const resolvedPath = resolveWorkspacePath(filePath, workspace, sessionId);
    const fileExisted = fs.existsSync(resolvedPath);
    let beforeContent = '';
    if (fileExisted) beforeContent = fs.readFileSync(resolvedPath, 'utf-8');
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, content, 'utf-8');
    const newLineCount = content.length === 0 ? 0 : content.split('\n').length;
    const lineDelta = fileExisted ? computeLineDelta(beforeContent, content) : { linesAdded: newLineCount, linesDeleted: 0 };
    return {
      success: true,
      bytes_written: Buffer.byteLength(content, 'utf-8'),
      file_change: {
        path: filePath,
        type: fileExisted ? 'MODIFIED' : 'CREATED',
        lines_added: lineDelta.linesAdded,
        lines_deleted: lineDelta.linesDeleted,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  }
  return fallback;
}

function lineAtIndex(content: string, index: number): { lineNumber: number; lineText: string } {
  let lineNumber = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') {
      lineNumber++;
      lineStart = i + 1;
    }
  }
  let lineEnd = content.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = content.length;
  let lineText = content.slice(lineStart, lineEnd);
  if (lineText.endsWith('\r')) lineText = lineText.slice(0, -1);
  return { lineNumber, lineText };
}

function applyEditMatch(content: string, oldString: string, newString: string, replaceAll: boolean): {
  ok: boolean;
  updated?: string;
  replacements: number;
  error?: string;
  occurrences?: number;
  occurrence_lines?: number[];
} {
  if (oldString === '') {
    return { ok: false, replacements: 0, error: 'old_string 不能为空' };
  }
  const starts: number[] = [];
  let idx = 0;
  while (idx < content.length) {
    const found = content.indexOf(oldString, idx);
    if (found === -1) break;
    starts.push(found);
    idx = found + oldString.length;
  }
  const count = starts.length;
  if (count === 0) {
    return { ok: false, replacements: 0, error: '文件中未找到 old_string' };
  }
  if (count > 1 && !replaceAll) {
    const maxLines = 20;
    const maxPreviews = 8;
    const occurrenceLines = starts.slice(0, maxLines).map((start) => lineAtIndex(content, start).lineNumber);
    const previewCount = Math.min(maxPreviews, starts.length);
    const previews: string[] = [];
    for (let i = 0; i < previewCount; i++) {
      const { lineNumber, lineText } = lineAtIndex(content, starts[i]);
      const preview = lineText.length > 120 ? `${lineText.slice(0, 120)}…` : lineText;
      previews.push(`  第 ${lineNumber} 行: ${preview}`);
    }
    const listed = count > maxLines ? `（仅列出前 ${maxLines} 处）` : '';
    return {
      ok: false,
      replacements: 0,
      occurrences: count,
      occurrence_lines: occurrenceLines,
      error: `old_string 在文件中出现 ${count} 次，默认只替换唯一匹配，未执行编辑。`
        + '请在 old_string 中补充更多上下文使其只出现一次，或传入 replace_all=true 以替换全部出现。'
        + `出现位置（行号从 1 起）${listed}：\n`
        + previews.join('\n'),
    };
  }
  return {
    ok: true,
    updated: content.split(oldString).join(newString),
    replacements: count,
  };
}

export function handleEditFile(args: Record<string, unknown>, workspace: string | undefined, sessionId: number): Record<string, unknown> {
  try {
    const filePath = extractFilePath(args);
    if (!filePath) return { success: false, error: '缺少必填参数 path' };
    const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
    const newStr = typeof args.new_string === 'string' ? args.new_string : '';
    if (!oldStr) return { success: false, error: '缺少 old_string' };
    const resolvedPath = resolveWorkspacePath(filePath, workspace, sessionId);
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const match = applyEditMatch(content, oldStr, newStr, asBool(args.replace_all));
    if (!match.ok) {
      return {
        success: false,
        replacements: 0,
        error: match.error,
        ...(match.occurrences != null ? { occurrences: match.occurrences, occurrence_lines: match.occurrence_lines } : {}),
      };
    }
    fs.writeFileSync(resolvedPath, match.updated!, 'utf-8');
    const oldLines = oldStr.split('\n').length;
    const newLines = newStr.split('\n').length;
    return {
      success: true,
      replacements: match.replacements,
      file_change: {
        path: filePath,
        type: 'MODIFIED',
        lines_added: newLines * match.replacements,
        lines_deleted: oldLines * match.replacements,
      },
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
