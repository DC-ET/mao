/**
 * 工具调用富视图模型（对齐 desktop/src/components/chat/ToolCallCard.vue 的 computed 链）：
 * shell 终端块 / edit_file 行级 diff / read_file、write_file 带行号内容 / glob、grep 命中列表 /
 * web_search 结果列表 / open_web_page 正文 / 图片结果，解析不了的一律回退「输入/输出」原始 JSON。
 * 纯函数、无组件依赖，便于单测。
 */
import { buildEditDiff } from './toolDiff';

function parseResultNode(result?: string): Record<string, unknown> | null {
  if (!result) return null;
  try {
    const node = JSON.parse(result) as unknown;
    return node && typeof node === 'object' && !Array.isArray(node) ? node as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 富视图判别联合：kind 命名与各工具一一对应，null = 无可渲染内容（调用方回退原始展示）。 */
export type ToolBodyView =
  | { kind: 'diff'; blocks: ReturnType<typeof buildEditDiff>['blocks']; summary: string }
  | { kind: 'shell'; primary: string; primaryLabel: string; output: string; error: string; badge: { text: string; ok: boolean } | null; summary: string }
  | { kind: 'file'; content: string; path: string; startLine: number; summary: string }
  | { kind: 'write'; content: string; path: string; summary: string }
  | { kind: 'glob'; pattern: string; path: string; files: string[]; truncated: boolean; error: string; summary: string }
  | { kind: 'grep'; pattern: string; groups: { file: string; rows: { line: number; content: string; contextual: boolean }[] }[]; error: string; summary: string }
  | { kind: 'web-search'; query: string; items: { title: string; url: string; content: string }[]; error: string; summary: string }
  | { kind: 'web-page'; url: string; title: string; content: string; error: string; summary: string }
  | null;

export function buildToolBodyView(toolName: string, input: Record<string, unknown> | null, result?: string): ToolBodyView {
  switch (toolName) {
    case 'edit_file': return editDiffView(input, result);
    case 'shell': return shellView(input, result);
    case 'read_file': return fileView(input, result);
    case 'write_file': return writeView(input, result);
    case 'glob_search': return globView(input, result);
    case 'grep_search': return grepView(input, result);
    case 'web_search': return webSearchView(input, result);
    case 'open_web_page': return webPageView(input, result);
    default: return null;
  }
}

/** edit_file：入参自带完整 old/new_string，实时流式与历史回放同源。 */
function editDiffView(input: Record<string, unknown> | null, result?: string): ToolBodyView {
  if (!input) return null;
  const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
  const newStr = typeof input.new_string === 'string' ? input.new_string : '';
  if (oldStr === '' && newStr === '') return null;
  const diff = buildEditDiff(oldStr, newStr);
  if (diff.blocks.length === 0) return null;
  const node = parseResultNode(result);
  let summary = '';
  if (node && node.success === true) {
    const fc = (node.file_change ?? {}) as Record<string, unknown>;
    const added = Number(fc.lines_added ?? diff.added);
    const deleted = Number(fc.lines_deleted ?? diff.deleted);
    const parts: string[] = [];
    const replacements = Number(node.replacements);
    if (Number.isFinite(replacements) && replacements > 0) parts.push(`替换 ${replacements} 处`);
    parts.push(`+${added} -${deleted}`);
    summary = parts.join(' · ');
  } else if (node) {
    summary = textOf(node.error);
  }
  return { kind: 'diff', blocks: diff.blocks, summary };
}

/** shell：命令（exec）/ stdin（write_stdin）+ 终端输出原文，合成终端会话块。 */
function shellView(input: Record<string, unknown> | null, result?: string): ToolBodyView {
  if (!input) return null;
  const action = typeof input.action === 'string' ? input.action : 'exec';
  const node = parseResultNode(result);
  const primary = action === 'exec'
    ? textOf(input.command)
    : action === 'write_stdin' ? textOf(input.input) : '';
  const output = textOf(node?.output);
  const error = textOf(node?.error);
  if (!primary && !output && !error) return null;
  const exitRaw = node?.exit_code;
  const exitCode = typeof exitRaw === 'number' && Number.isFinite(exitRaw) ? exitRaw : null;
  const summaryParts: string[] = [];
  if (!error) {
    if (node?.truncated === true) summaryParts.push('输出已截断');
    const message = textOf(node?.message);
    if (message) summaryParts.push(message);
  }
  return {
    kind: 'shell',
    primary,
    primaryLabel: action === 'write_stdin' ? 'stdin' : '命令',
    output,
    error,
    badge: exitCode == null ? null : { text: `exit ${exitCode}`, ok: exitCode === 0 },
    summary: summaryParts.join(' · '),
  };
}

/** read_file：文件内容（图片读取 media_type=image 不进此分支，走 imagePreview）。 */
function fileView(input: Record<string, unknown> | null, result?: string): ToolBodyView {
  if (!input) return null;
  const node = parseResultNode(result);
  if (!node) return null;
  const error = textOf(node.error);
  const content = textOf(node.content);
  if (!error && !content) return null;
  const totalLines = typeof node.total_lines === 'number' && node.total_lines > 0 ? node.total_lines : null;
  const offset = typeof input.offset === 'number' && input.offset > 0 ? input.offset : 0;
  const contentLines = content === '' ? 0 : content.split('\n').length;
  const path = textOf(input.path) || textOf(input.file_path);
  const summaryParts: string[] = [];
  if (error) summaryParts.push(error);
  else {
    if (totalLines != null) summaryParts.push(`共 ${totalLines} 行`);
    if (contentLines > 0) summaryParts.push(`第 ${offset + 1}–${offset + contentLines} 行`);
  }
  return {
    kind: 'file',
    content: error ? '' : content,
    path,
    startLine: offset + 1,
    summary: summaryParts.join(' · '),
  };
}

/** write_file：写入的整篇内容来自入参 content（结果里只有行数/字节数）。 */
function writeView(input: Record<string, unknown> | null, result?: string): ToolBodyView {
  if (!input) return null;
  const content = typeof input.content === 'string' ? input.content : '';
  const path = textOf(input.path) || textOf(input.file_path);
  const node = parseResultNode(result);
  const error = textOf(node?.error);
  if (!error && !content) return null;
  const fc = (node?.file_change ?? {}) as Record<string, unknown>;
  const totalLines = typeof fc.total_lines === 'number' && fc.total_lines > 0 ? fc.total_lines : null;
  const added = Number(fc.lines_added);
  const deleted = Number(fc.lines_deleted);
  const parts: string[] = [];
  if (error) parts.push(error);
  else {
    if (totalLines != null) parts.push(`共 ${totalLines} 行`);
    if (Number.isFinite(added) && Number.isFinite(deleted) && (added > 0 || deleted > 0)) {
      parts.push(`+${added} -${deleted}`);
    }
  }
  return { kind: 'write', content: error ? '' : content, path, summary: parts.join(' · ') };
}

function globView(input: Record<string, unknown> | null, result?: string): ToolBodyView {
  if (!input) return null;
  const node = parseResultNode(result);
  if (!node) return null;
  const files = Array.isArray(node.files)
    ? node.files.filter((f): f is string => typeof f === 'string')
    : [];
  const error = textOf(node.error);
  const parts: string[] = [];
  if (error) parts.push(error);
  else {
    parts.push(`${files.length} 个文件`);
    if (node.truncated === true) parts.push('已截断');
  }
  return {
    kind: 'glob',
    pattern: textOf(input.pattern),
    path: textOf(input.path),
    files,
    truncated: node.truncated === true,
    error,
    summary: parts.join(' · '),
  };
}

function grepView(input: Record<string, unknown> | null, result?: string): ToolBodyView {
  if (!input) return null;
  const node = parseResultNode(result);
  if (!node) return null;
  type Row = { line: number; content: string; contextual: boolean };
  const groups: { file: string; rows: Row[] }[] = [];
  const byFile = new Map<string, { file: string; rows: Row[] }>();
  let hitCount = 0;
  for (const raw of Array.isArray(node.matches) ? node.matches : []) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const file = textOf(entry.file);
    const line = Number(entry.line);
    if (!file || !Number.isFinite(line)) continue;
    const contextual = entry.contextual === true;
    let group = byFile.get(file);
    if (!group) {
      group = { file, rows: [] };
      byFile.set(file, group);
      groups.push(group);
    }
    group.rows.push({ line, content: textOf(entry.content), contextual });
    if (!contextual) hitCount++;
  }
  const total = typeof node.total_matches === 'number' ? node.total_matches : hitCount;
  const error = textOf(node.error);
  const parts: string[] = [];
  if (error) parts.push(error);
  else if (total > 0) {
    parts.push(`${total} 处匹配 · ${groups.length} 个文件`);
    if (node.truncated === true) parts.push('已截断');
  }
  return {
    kind: 'grep',
    pattern: textOf(input.pattern),
    groups,
    error,
    summary: parts.join(' · '),
  };
}

function webSearchView(input: Record<string, unknown> | null, result?: string): ToolBodyView {
  if (!input) return null;
  const node = parseResultNode(result);
  if (!node) return null;
  const items = (Array.isArray(node.results) ? node.results : [])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
    .map(r => ({ title: textOf(r.title), url: textOf(r.url), content: textOf(r.content) }))
    .filter(item => item.url || item.title);
  const error = textOf(node.error);
  return {
    kind: 'web-search',
    query: textOf(input.query),
    items,
    error,
    summary: error || `${items.length} 条结果`,
  };
}

function webPageView(input: Record<string, unknown> | null, result?: string): ToolBodyView {
  if (!input) return null;
  const node = parseResultNode(result);
  if (!node) return null;
  const content = textOf(node.content);
  const length = typeof node.content_length === 'number' ? node.content_length : content.length;
  const error = textOf(node.error);
  return {
    kind: 'web-page',
    url: textOf(input.url) || textOf(node.url),
    title: textOf(node.title),
    content,
    error,
    summary: error || (length > 0 ? `正文 ${length.toLocaleString()} 字符` : ''),
  };
}

/** 原始 JSON 的紧凑格式化：JSON 串缩进两格重排，非 JSON 原样返回。 */
export function prettyJsonOrRaw(text: string): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
