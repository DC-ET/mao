export type MdKind = 'fence' | 'code' | 'heading' | 'list' | 'table' | 'empty' | 'text';

export interface MdLine {
  kind: MdKind;
  text: string;
  level?: number;
}

export function consumeMarkdownLines(source: string): MdLine[] {
  const lines = source.split('\n');
  let inFence = false;
  const out: MdLine[] = [];
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      out.push({ kind: 'fence', text: line });
      continue;
    }
    if (inFence) {
      out.push({ kind: 'code', text: line });
      continue;
    }
    if (line.length === 0) {
      out.push({ kind: 'empty', text: '' });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push({ kind: 'heading', text: heading[2], level: heading[1].length });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      out.push({ kind: 'list', text: line });
      continue;
    }
    if (/^\s*\|/.test(line)) {
      out.push({ kind: 'table', text: line });
      continue;
    }
    out.push({ kind: 'text', text: line });
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
