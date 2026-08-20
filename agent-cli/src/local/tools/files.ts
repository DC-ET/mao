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

export function handleEditFile(args: Record<string, unknown>, workspace: string | undefined, sessionId: number): Record<string, unknown> {
  try {
    const filePath = extractFilePath(args);
    if (!filePath) return { success: false, error: '缺少必填参数 path' };
    const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
    const newStr = typeof args.new_string === 'string' ? args.new_string : '';
    if (!oldStr) return { success: false, error: '缺少 old_string' };
    const resolvedPath = resolveWorkspacePath(filePath, workspace, sessionId);
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const count = content.split(oldStr).length - 1;
    if (count === 0) return { success: false, error: 'old_string not found in file' };
    const updated = content.split(oldStr).join(newStr);
    fs.writeFileSync(resolvedPath, updated, 'utf-8');
    const oldLines = oldStr.split('\n').length;
    const newLines = newStr.split('\n').length;
    return {
      success: true,
      replacements: count,
      file_change: {
        path: filePath,
        type: 'MODIFIED',
        lines_added: newLines * count,
        lines_deleted: oldLines * count,
      },
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
