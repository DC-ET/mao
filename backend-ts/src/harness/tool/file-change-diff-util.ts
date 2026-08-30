export const PRIVATE_DIFF_FIELD = 'file_change_diff';
export const SNAPSHOT_LIMIT_BYTES = 512 * 1024;
export const PATCH_LIMIT_CHARS = 256 * 1024;
const PATCH_CONTEXT_LINES = 3;
const LCS_CELL_LIMIT = 2_000_000;

export interface LineDelta {
  linesAdded: number;
  linesDeleted: number;
}

export const FileChangeDiffUtil = {
  PRIVATE_DIFF_FIELD,
  SNAPSHOT_LIMIT_BYTES,
  PATCH_LIMIT_CHARS,
  buildDiff(filePath: string, beforeContent: string | null | undefined, afterContent: string | null | undefined): Record<string, unknown> {
    const before = beforeContent ?? '';
    const after = afterContent ?? '';
    const diff: Record<string, unknown> = {};

    if (isBinary(before) || isBinary(after)) {
      diff.diff_mode = 'UNSUPPORTED';
      diff.diff_unavailable_reason = '二进制文件无法生成文本 diff';
      diff.patch_truncated = false;
      return diff;
    }

    if (utf8Bytes(before) <= SNAPSHOT_LIMIT_BYTES && utf8Bytes(after) <= SNAPSHOT_LIMIT_BYTES) {
      diff.diff_mode = 'SNAPSHOT';
      diff.before_content = before;
      diff.after_content = after;
      diff.patch_truncated = false;
      return diff;
    }

    const patch = buildUnifiedPatch(filePath, before, after);
    diff.diff_mode = 'PATCH';
    diff.patch_content = patch.content;
    diff.patch_truncated = patch.truncated;
    return diff;
  },

  stripPrivateDiff(result: string | null | undefined): string | null | undefined {
    if (result == null || result.trim() === '') return result;
    try {
      const node = JSON.parse(result) as Record<string, unknown>;
      if (node && typeof node === 'object' && !Array.isArray(node) && PRIVATE_DIFF_FIELD in node) {
        delete node[PRIVATE_DIFF_FIELD];
        return JSON.stringify(node);
      }
    } catch {
      // ignore
    }
    return result;
  },

  computeLineDelta(beforeContent: string | null | undefined, afterContent: string | null | undefined): LineDelta {
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

    const cells = oldChanged * newChanged;
    if (cells > LCS_CELL_LIMIT) return { linesAdded: newChanged, linesDeleted: oldChanged };

    const lcs = lcsLength(oldLines, prefix, oldSuffix, newLines, prefix, newSuffix);
    return { linesAdded: newChanged - lcs, linesDeleted: oldChanged - lcs };
  },
};

function isBinary(text: string): boolean {
  const checkLen = Math.min(text.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
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

  const oldStartLine = contextStart + 1;
  const newStartLine = contextStart + 1;
  const oldCount = Math.max(0, oldContextEnd - contextStart + 1);
  const newCount = Math.max(0, newContextEnd - contextStart + 1);

  let patch = '';
  let truncated = false;
  const append = (text: string) => {
    if (patch.length >= PATCH_LIMIT_CHARS) {
      truncated = true;
      return;
    }
    const remaining = PATCH_LIMIT_CHARS - patch.length;
    if (text.length <= remaining) {
      patch += text;
    } else {
      patch += text.slice(0, remaining);
      truncated = true;
    }
  };

  append(`--- a/${filePath}\n`);
  append(`+++ b/${filePath}\n`);
  append(`@@ -${oldStartLine},${oldCount} +${newStartLine},${newCount} @@\n`);

  for (let i = contextStart; i < prefix && i < oldLines.length; i++) append(` ${oldLines[i]}\n`);
  for (let i = prefix; i <= oldSuffix && i < oldLines.length; i++) append(`-${oldLines[i]}\n`);
  for (let i = prefix; i <= newSuffix && i < newLines.length; i++) append(`+${newLines[i]}\n`);

  // 尾部上下文：统一按旧序号从 oldSuffix+1 起输出。共享尾段在新旧文件中内容相同、仅索引错位
  // （纯插入时 newSuffix 大于 oldSuffix），若取 max(oldSuffix+1, newSuffix+1) 会按旧序号跳过共享行。
  const sharedTailStart = Math.max(prefix, oldSuffix + 1);
  const sharedTailEnd = Math.min(oldContextEnd, oldLines.length - 1);
  for (let i = sharedTailStart; i <= sharedTailEnd; i++) append(` ${oldLines[i]}\n`);

  if (truncated && !patch.endsWith('\n...[diff truncated]\n')) {
    const marker = '\n...[diff truncated]\n';
    const maxPrefix = Math.max(0, PATCH_LIMIT_CHARS - marker.length);
    patch = patch.slice(0, Math.min(patch.length, maxPrefix)) + marker;
  }
  return { content: patch, truncated };
}

function splitLines(text: string | null | undefined): string[] {
  if (text == null || text === '') return [];
  return text.split(/\r\n|\n|\r/);
}

function lcsLength(oldLines: string[], oldStart: number, oldEnd: number, newLines: string[], newStart: number, newEnd: number): number {
  const newLen = newEnd - newStart + 1;
  let previous = new Array<number>(newLen + 1).fill(0);
  let current = new Array<number>(newLen + 1).fill(0);

  for (let i = oldStart; i <= oldEnd; i++) {
    for (let j = 1; j <= newLen; j++) {
      if (oldLines[i] === newLines[newStart + j - 1]) {
        current[j] = previous[j - 1] + 1;
      } else {
        current[j] = Math.max(previous[j], current[j - 1]);
      }
    }
    const temp = previous;
    previous = current;
    current = temp;
    current.fill(0);
  }
  return previous[newLen];
}
