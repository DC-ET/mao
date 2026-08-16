const CODE_FENCE = /^\s*(```+|~~~+)\s*.*$/;
const HEADING = /^\s*#{1,6}\s+/;
const QUOTE = /^\s*>{1,}\s?/;
const UNORDERED_LIST = /^\s*[-*+]\s+/;
const ORDERED_LIST_KEEP = /^\s*(\d{1,3})[.)]\s+/;
const HORIZONTAL_RULE = /^\s*(?:[-*_]\s*){3,}$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const INLINE_CODE = /`+/g;
const IMAGE_LINK = /!\[([^\]]*)]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]+)]\([^)]*\)/g;
const STRONG = /\*\*|__|~~/g;
const EMPHASIS = /[*_]/g;
const HTML_TAG = /<[^>]+>/g;
const SENTENCE_END_PUNCT = '。！？；，、：…!?;,:.';

export class WeixinVoiceTextSanitizer {
  toSpeechText(text: string | null | undefined): string {
    if (text == null || text.trim() === '') {
      return '';
    }
    const lines: string[] = [];
    let inCodeBlock = false;
    for (const rawLine of text.split(/\r\n|\n|\r/)) {
      let line = rawLine;
      if (inCodeBlock) {
        if (CODE_FENCE.test(line)) {
          inCodeBlock = false;
        }
        continue;
      }
      if (CODE_FENCE.test(line)) {
        inCodeBlock = true;
        continue;
      }
      if (line.trim() === '') {
        lines.push('');
        continue;
      }
      const trimmed = line.trim();
      if (HORIZONTAL_RULE.test(trimmed)) {
        continue;
      }
      if (trimmed.startsWith('|')) {
        if (TABLE_SEPARATOR.test(trimmed)) {
          continue;
        }
        lines.push(tableRowToSpeech(trimmed));
        continue;
      }
      line = line.replace(HEADING, '');
      line = line.replace(QUOTE, '');
      line = line.replace(UNORDERED_LIST, '');
      line = line.replace(ORDERED_LIST_KEEP, '$1、');
      lines.push(line.trim());
    }

    let sb = '';
    for (const line of lines) {
      if (line.trim() === '') {
        sb += '\n';
        continue;
      }
      let cleaned = line.replace(INLINE_CODE, '');
      cleaned = cleaned.replace(IMAGE_LINK, '$1');
      cleaned = cleaned.replace(MARKDOWN_LINK, '$1');
      cleaned = cleaned.replace(STRONG, '');
      cleaned = cleaned.replace(EMPHASIS, '');
      cleaned = cleaned.replace(HTML_TAG, '');
      cleaned = cleaned.replace(/\s+/g, ' ').trim();
      if (cleaned !== '') {
        sb += `${ensureSentenceEnd(cleaned)}\n`;
      }
    }
    return sb.replace(/\n{3,}/g, '\n\n').trim();
  }
}

function ensureSentenceEnd(line: string): string {
  if (line.length === 0) return line;
  const last = line.charAt(line.length - 1);
  if (SENTENCE_END_PUNCT.includes(last)) return line;
  return `${line}。`;
}

function tableRowToSpeech(row: string): string {
  let body = row.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  const cells: string[] = [];
  for (const cell of body.split('|')) {
    const c = cell.trim();
    if (c !== '') cells.push(c);
  }
  if (cells.length === 0) return '';
  return `${cells.join('，')}。`;
}
