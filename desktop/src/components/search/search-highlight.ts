/** 搜索结果片段的多词高亮。词项按空白切开，去掉包裹的引号和前缀 + / -。 */

export function searchHighlightTerms(keyword: string): string[] {
  const terms: string[] = [];
  let i = 0;
  const raw = keyword.trim();
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
    if (i >= raw.length) break;
    if (raw[i] === '+' || raw[i] === '-') {
      const next = raw[i + 1];
      if (next != null && !/\s/.test(next)) i++;
    }
    if (raw[i] === '"') {
      const end = raw.indexOf('"', i + 1);
      if (end < 0) {
        const rest = raw.slice(i + 1).trim();
        if (rest) terms.push(rest);
        break;
      }
      const text = raw.slice(i + 1, end).trim();
      if (text) terms.push(text);
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < raw.length && !/\s/.test(raw[j]!)) j++;
    const text = raw.slice(i, j).trim();
    if (text) terms.push(text);
    i = j;
  }
  return terms;
}

export function highlightParts(text: string, keyword: string): Array<{ text: string; hit: boolean }> {
  const terms = searchHighlightTerms(keyword).filter((term) => term.length > 0);
  if (!text || terms.length === 0) return [{ text: text || '', hit: false }];
  const lowerText = text.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    let pos = 0;
    while (pos < lowerText.length) {
      const idx = lowerText.indexOf(lowerTerm, pos);
      if (idx < 0) break;
      ranges.push({ start: idx, end: idx + term.length });
      pos = idx + Math.max(term.length, 1);
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last != null && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), hit: false });
    parts.push({ text: text.slice(range.start, range.end), hit: true });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

export function scrollElementToMessage(
  root: { querySelector: (selector: string) => { scrollIntoView: (options: { block: 'center' }) => void } | null } | null | undefined,
  messageId: string,
): boolean {
  if (root == null || messageId === '') return false;
  const node = root.querySelector(`[id="msg-${messageId.replace(/"/g, '')}"]`);
  if (node == null || typeof node.scrollIntoView !== 'function') return false;
  node.scrollIntoView({ block: 'center' });
  return true;
}
