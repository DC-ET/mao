const ANSI_RE = /\x1b\[[0-9;]*m/g;

function charWidth(code: number): number {
  if (code <= 0x1f || code === 0x7f) return 0;
  if (code <= 0x7e) return 1;
  if (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2329 && code <= 0x232a)
    || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3040 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

/** 终端列宽：CJK / 全角按 2；盒线、Braille spinner、符号按 1；忽略颜色码。 */
export function displayWidth(text: string): number {
  const plain = text.replace(ANSI_RE, '');
  let w = 0;
  for (const ch of plain) {
    w += charWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

export function truncateToWidth(text: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const ellipsis = '…';
  const budget = Math.max(1, max - displayWidth(ellipsis));
  let w = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\x1b') {
      const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 32);
    const cw = displayWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
    if (ch.length > 1) i += ch.length - 1;
  }
  return out + ellipsis;
}
