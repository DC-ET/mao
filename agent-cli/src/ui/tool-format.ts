const ARG_KEYS = ['command', 'path', 'file_path', 'glob', 'pattern', 'query', 'url', 'old_string', 'content'];

/** 把工具 JSON 参数收成一眼能扫的短句。 */
export function summarizeToolArgs(raw?: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ARG_KEYS) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) {
        return v.replace(/\s+/g, ' ').trim();
      }
    }
    const first = Object.values(o).find((v) => typeof v === 'string' && String(v).length > 0 && String(v).length < 120);
    if (typeof first === 'string') return first.replace(/\s+/g, ' ').trim();
  } catch {
    // not json
  }
  return trimmed.replace(/\s+/g, ' ');
}

/** 折叠工具输出：先限行数，再限字符数。 */
export function truncate(text: string, maxChars = 2000, maxLines = 20): string {
  const lines = text.split('\n');
  let sliced = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + '\n…' : text;
  if (sliced.length > maxChars) sliced = sliced.slice(0, maxChars) + '…';
  return sliced;
}
