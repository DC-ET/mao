import fs from 'node:fs';
import path from 'node:path';
import { assertNotSymlink, resolveSandboxPath } from '../sandbox';

const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_LENGTH = 50000;
const BINARY_SNIFF_BYTES = 8192;
const PRIVATE_DIFF_FIELD = 'file_change_diff';
const SNAPSHOT_LIMIT_BYTES = 512 * 1024;
const PATCH_LIMIT_CHARS = 256 * 1024;
const PATCH_CONTEXT_LINES = 3;
const LCS_CELL_LIMIT = 2_000_000;

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
    return {
      content: `错误：文件过大（${formatSize(sizeBytes)}），图片读取上限为 ${formatSize(MAX_IMAGE_BYTES)}：${filePath}。`
        + '终端版不做缩放，请先本地压缩或裁剪后再读取。',
      total_lines: 0,
    };
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

/** 与后端 read-file-tool.ts splitLines 一致：按 CRLF/CR/LF 切分，末尾换行不产生空行。 */
export function splitLines(raw: string): string[] {
  if (raw === '') return [];
  const lines = raw.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isBinaryText(text: string): boolean {
  const checkLen = Math.min(text.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < checkLen; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLen = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function lcsLength(oldLines: string[], oldStart: number, oldEnd: number, newLines: string[], newStart: number, newEnd: number): number {
  const newLen = newEnd - newStart + 1;
  let previous = new Array<number>(newLen + 1).fill(0);
  let current = new Array<number>(newLen + 1).fill(0);
  for (let i = oldStart; i <= oldEnd; i++) {
    for (let j = 1; j <= newLen; j++) {
      if (oldLines[i] === newLines[newStart + j - 1]) current[j] = previous[j - 1] + 1;
      else current[j] = Math.max(previous[j], current[j - 1]);
    }
    const temp = previous;
    previous = current;
    current = temp;
    current.fill(0);
  }
  return previous[newLen];
}

/** 与后端 FileChangeDiffUtil.computeLineDelta 同口径（LCS），保证 CLI/云端行数统计一致。 */
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
  if (oldChanged <= 0) return { linesAdded: Math.max(0, newChanged), linesDeleted: 0 };
  if (newChanged <= 0) return { linesAdded: 0, linesDeleted: Math.max(0, oldChanged) };
  if (oldChanged * newChanged > LCS_CELL_LIMIT) return { linesAdded: newChanged, linesDeleted: oldChanged };
  const lcs = lcsLength(oldLines, prefix, oldSuffix, newLines, prefix, newSuffix);
  return { linesAdded: newChanged - lcs, linesDeleted: oldChanged - lcs };
}

function buildUnifiedPatch(filePath: string, before: string, after: string): { content: string; truncated: boolean } {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix--;
    newSuffix--;
  }
  const contextStart = Math.max(0, prefix - PATCH_CONTEXT_LINES);
  const oldContextEnd = Math.min(oldLines.length - 1, oldSuffix + PATCH_CONTEXT_LINES);
  const newContextEnd = Math.min(newLines.length - 1, newSuffix + PATCH_CONTEXT_LINES);
  const oldCount = Math.max(0, oldContextEnd - contextStart + 1);
  const newCount = Math.max(0, newContextEnd - contextStart + 1);

  let patch = '';
  let truncated = false;
  const append = (text: string): void => {
    if (patch.length >= PATCH_LIMIT_CHARS) {
      truncated = true;
      return;
    }
    const remaining = PATCH_LIMIT_CHARS - patch.length;
    if (text.length <= remaining) patch += text;
    else {
      patch += text.slice(0, remaining);
      truncated = true;
    }
  };
  append(`--- a/${filePath}\n`);
  append(`+++ b/${filePath}\n`);
  append(`@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@\n`);
  for (let i = contextStart; i < prefix && i < oldLines.length; i++) append(` ${oldLines[i]}\n`);
  for (let i = prefix; i <= oldSuffix && i < oldLines.length; i++) append(`-${oldLines[i]}\n`);
  for (let i = prefix; i <= newSuffix && i < newLines.length; i++) append(`+${newLines[i]}\n`);
  const sharedTailStart = Math.max(prefix, oldSuffix + 1);
  const sharedTailEnd = Math.min(oldContextEnd, oldLines.length - 1);
  for (let i = sharedTailStart; i <= sharedTailEnd; i++) append(` ${oldLines[i]}\n`);
  if (truncated) {
    const marker = '\n...[diff truncated]\n';
    const maxPrefix = Math.max(0, PATCH_LIMIT_CHARS - marker.length);
    patch = patch.slice(0, Math.min(patch.length, maxPrefix)) + marker;
  }
  return { content: patch, truncated };
}

/** 与后端 FileChangeDiffUtil.buildDiff / desktop buildFileChangeDiff 结构一致，供前端渲染 diff 视图。 */
export function buildFileChangeDiff(filePath: string, beforeContent: string, afterContent: string): Record<string, unknown> {
  if (isBinaryText(beforeContent) || isBinaryText(afterContent)) {
    return { diff_mode: 'UNSUPPORTED', diff_unavailable_reason: '二进制文件无法生成文本 diff', patch_truncated: false };
  }
  if (
    Buffer.byteLength(beforeContent, 'utf8') <= SNAPSHOT_LIMIT_BYTES
    && Buffer.byteLength(afterContent, 'utf8') <= SNAPSHOT_LIMIT_BYTES
  ) {
    return {
      diff_mode: 'SNAPSHOT',
      before_content: beforeContent,
      after_content: afterContent,
      patch_truncated: false,
    };
  }
  const patch = buildUnifiedPatch(filePath, beforeContent, afterContent);
  return { diff_mode: 'PATCH', patch_content: patch.content, patch_truncated: patch.truncated };
}

interface Eol {
  bom: boolean;
  crlf: boolean;
}

function detectEol(raw: string): Eol {
  return { bom: raw.charCodeAt(0) === 0xfeff, crlf: raw.includes('\r\n') };
}

/** 写回时保留原文件的 BOM 与 CRLF：模型给的 content 一律是 LF 且无 BOM。 */
function applyEol(content: string, eol: Eol): string {
  let out = content;
  if (eol.crlf) out = out.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  if (eol.bom && out.charCodeAt(0) !== 0xfeff) out = `\uFEFF${out}`;
  return out;
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function sandboxError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function handleReadFile(args: Record<string, unknown>, workspace: string | undefined, sessionId: number): Record<string, unknown> {
  try {
    const filePath = extractFilePath(args);
    if (!filePath) return { content: '错误：缺少必填参数 path', total_lines: 0 };
    const resolvedPath = resolveSandboxPath(filePath, workspace, sessionId);
    assertNotSymlink(resolvedPath, filePath);
    if (!fs.existsSync(resolvedPath)) return { content: `错误：文件不存在：${filePath}`, total_lines: 0 };
    if (!fs.statSync(resolvedPath).isFile()) return { content: `错误：不是普通文件：${filePath}`, total_lines: 0 };
    if (mimeFromPath(filePath)) return readImage(resolvedPath, filePath);
    const sizeBytes = fs.statSync(resolvedPath).size;
    if (sizeBytes > MAX_TEXT_BYTES) {
      return {
        content: `错误：文件过大（${formatSize(sizeBytes)}），文本读取上限为 ${formatSize(MAX_TEXT_BYTES)}：${filePath}`,
        total_lines: 0,
      };
    }
    const buffer = fs.readFileSync(resolvedPath);
    if (isBinaryBuffer(buffer)) {
      return { content: `错误：二进制文件无法按文本读取：${filePath}`, total_lines: 0 };
    }
    const allLines = splitLines(stripBom(buffer.toString('utf8')));
    const totalLines = allLines.length;
    const offset = Math.max(0, Number(args.offset ?? 0) || 0);
    const limit = args.limit != null ? Math.max(0, Number(args.limit) || 0) : Number.MAX_SAFE_INTEGER;
    const from = Math.min(offset, totalLines);
    const to = Math.min(from + limit, totalLines);
    let content = allLines.slice(from, to).join('\n');
    if (content.length > MAX_OUTPUT_LENGTH) content = content.slice(0, MAX_OUTPUT_LENGTH) + '\n... [output truncated]';
    return { content, total_lines: totalLines };
  } catch (e) {
    return { content: `错误：${sandboxError(e)}`, total_lines: 0 };
  }
}

export function handleWriteFile(args: Record<string, unknown>, workspace: string | undefined, sessionId: number): Record<string, unknown> {
  try {
    const filePath = extractFilePath(args);
    if (!filePath) return { success: false, error: '缺少必填参数 path' };
    if (typeof args.content !== 'string') return { success: false, error: '缺少必填参数 content' };
    const content = args.content;
    const resolvedPath = resolveSandboxPath(filePath, workspace, sessionId);
    assertNotSymlink(resolvedPath, filePath);
    const fileExisted = fs.existsSync(resolvedPath);
    if (fileExisted && !fs.statSync(resolvedPath).isFile()) {
      return { success: false, error: `不是普通文件，拒绝写入：${filePath}` };
    }
    const rawBefore = fileExisted ? fs.readFileSync(resolvedPath, 'utf-8') : '';
    const beforeContent = stripBom(rawBefore);
    const toWrite = fileExisted ? applyEol(content, detectEol(rawBefore)) : content;
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, toWrite, 'utf-8');
    const newLineCount = splitLines(content).length;
    const lineDelta = fileExisted ? computeLineDelta(beforeContent, content) : { linesAdded: newLineCount, linesDeleted: 0 };
    return {
      success: true,
      bytes_written: Buffer.byteLength(toWrite, 'utf-8'),
      file_change: {
        path: filePath,
        type: fileExisted ? 'MODIFIED' : 'CREATED',
        total_lines: newLineCount,
        lines_added: lineDelta.linesAdded,
        lines_deleted: lineDelta.linesDeleted,
      },
      [PRIVATE_DIFF_FIELD]: buildFileChangeDiff(filePath, beforeContent, content),
    };
  } catch (e) {
    return { success: false, error: sandboxError(e) };
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
    if (!filePath) return { success: false, replacements: 0, error: '缺少必填参数 path' };
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
      return { success: false, replacements: 0, error: '缺少必填参数: old_string, new_string' };
    }
    const oldStr = args.old_string;
    const newStr = args.new_string;
    if (oldStr === newStr) {
      return {
        success: false,
        replacements: 0,
        error: 'old_string 与 new_string 完全相同，未执行编辑；请检查并提供实际需要修改的内容',
      };
    }
    const resolvedPath = resolveSandboxPath(filePath, workspace, sessionId);
    assertNotSymlink(resolvedPath, filePath);
    if (!fs.existsSync(resolvedPath)) return { success: false, replacements: 0, error: `文件不存在：${filePath}` };
    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    const eol = detectEol(raw);
    const content = stripBom(raw);
    const match = applyEditMatch(content, oldStr, newStr, asBool(args.replace_all));
    if (!match.ok) {
      return {
        success: false,
        replacements: 0,
        error: match.error,
        ...(match.occurrences != null ? { occurrences: match.occurrences, occurrence_lines: match.occurrence_lines } : {}),
      };
    }
    const updated = match.updated!;
    fs.writeFileSync(resolvedPath, applyEol(updated, eol), 'utf-8');
    const lineDelta = computeLineDelta(content, updated);
    return {
      success: true,
      replacements: match.replacements,
      file_change: {
        path: filePath,
        type: 'MODIFIED',
        lines_added: lineDelta.linesAdded,
        lines_deleted: lineDelta.linesDeleted,
      },
      [PRIVATE_DIFF_FIELD]: buildFileChangeDiff(filePath, content, updated),
    };
  } catch (e) {
    return { success: false, replacements: 0, error: sandboxError(e) };
  }
}
