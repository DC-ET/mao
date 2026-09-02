export type MdKind = 'fence' | 'code' | 'heading' | 'list' | 'table' | 'empty' | 'text';

export interface MdLine {
  kind: MdKind;
  text: string;
  level?: number;
}

/**
 * 单行分类。fence 状态由调用方持有：流式渲染时逐行定稿，
 * 代码块的开闭必须跨调用保持，否则块内的 `#`、`-` 会被当成标题/列表。
 */
export function classifyMdLine(line: string, inFence: boolean): { line: MdLine; inFence: boolean } {
  if (line.trim().startsWith('```')) {
    return { line: { kind: 'fence', text: line }, inFence: !inFence };
  }
  if (inFence) {
    return { line: { kind: 'code', text: line }, inFence };
  }
  if (line.length === 0) {
    return { line: { kind: 'empty', text: '' }, inFence };
  }
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    return { line: { kind: 'heading', text: heading[2], level: heading[1].length }, inFence };
  }
  if (/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) {
    return { line: { kind: 'list', text: line }, inFence };
  }
  if (/^\s*\|/.test(line)) {
    return { line: { kind: 'table', text: line }, inFence };
  }
  return { line: { kind: 'text', text: line }, inFence };
}

export function consumeMarkdownLines(source: string): MdLine[] {
  let inFence = false;
  const out: MdLine[] = [];
  for (const raw of source.split('\n')) {
    const res = classifyMdLine(raw, inFence);
    inFence = res.inFence;
    out.push(res.line);
  }
  return out;
}

export interface InlinePart {
  style: 'plain' | 'bold' | 'code';
  text: string;
}

export function splitInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push({ style: 'plain', text: text.slice(last, match.index) });
    const tok = match[0];
    if (tok.startsWith('**')) parts.push({ style: 'bold', text: tok.slice(2, -2) });
    else parts.push({ style: 'code', text: tok.slice(1, -1) });
    last = match.index + tok.length;
  }
  if (last < text.length) parts.push({ style: 'plain', text: text.slice(last) });
  if (parts.length === 0) parts.push({ style: 'plain', text });
  return parts;
}
