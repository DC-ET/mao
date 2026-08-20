const MAX_OCCURRENCE_LINES = 20;
const MAX_PREVIEW_LINES = 8;
const PREVIEW_MAX_CHARS = 120;

export interface EditMatchSuccess {
  ok: true;
  updated: string;
  replacements: number;
}

export interface EditMatchFailure {
  ok: false;
  replacements: 0;
  error: string;
  occurrences?: number;
  occurrence_lines?: number[];
}

export type EditMatchResult = EditMatchSuccess | EditMatchFailure;

/** 在 content 中按唯一匹配或全量替换策略应用编辑。 */
export function applyEditMatch(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditMatchResult {
  if (oldString === '') {
    return { ok: false, replacements: 0, error: 'old_string 不能为空' };
  }
  const starts = findOccurrenceStarts(content, oldString);
  const count = starts.length;
  if (count === 0) {
    return { ok: false, replacements: 0, error: '文件中未找到 old_string' };
  }
  if (count > 1 && !replaceAll) {
    const occurrenceLines = starts
      .slice(0, MAX_OCCURRENCE_LINES)
      .map((idx) => lineAt(content, idx).lineNumber);
    return {
      ok: false,
      replacements: 0,
      error: formatAmbiguousMatchError(content, starts),
      occurrences: count,
      occurrence_lines: occurrenceLines,
    };
  }
  return {
    ok: true,
    updated: content.split(oldString).join(newString),
    replacements: count,
  };
}

function findOccurrenceStarts(content: string, needle: string): number[] {
  const starts: number[] = [];
  let idx = 0;
  while (idx < content.length) {
    const found = content.indexOf(needle, idx);
    if (found === -1) break;
    starts.push(found);
    idx = found + needle.length;
  }
  return starts;
}

function lineAt(content: string, index: number): { lineNumber: number; lineText: string } {
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

function formatAmbiguousMatchError(content: string, starts: number[]): string {
  const count = starts.length;
  const previewCount = Math.min(MAX_PREVIEW_LINES, starts.length);
  const previews: string[] = [];
  for (let i = 0; i < previewCount; i++) {
    const { lineNumber, lineText } = lineAt(content, starts[i]);
    previews.push(`  第 ${lineNumber} 行: ${truncatePreview(lineText)}`);
  }
  const listed = count > MAX_OCCURRENCE_LINES ? `（仅列出前 ${MAX_OCCURRENCE_LINES} 处）` : '';
  return (
    `old_string 在文件中出现 ${count} 次，默认只替换唯一匹配，未执行编辑。`
    + '请在 old_string 中补充更多上下文使其只出现一次，或传入 replace_all=true 以替换全部出现。'
    + `出现位置（行号从 1 起）${listed}：\n`
    + previews.join('\n')
  );
}

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  return text.slice(0, PREVIEW_MAX_CHARS) + '…';
}
