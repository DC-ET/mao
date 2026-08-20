export type KeyName =
  | 'up'
  | 'down'
  | 'enter'
  | 'esc'
  | 'space'
  | 'backspace'
  | 'tab'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'digit'
  | 'char'
  | 'other';

export interface ParsedKey {
  name: KeyName;
  digit?: number;
  char?: string;
  raw: string;
}

export function parseKey(data: string | Buffer): ParsedKey {
  const s = typeof data === 'string' ? data : data.toString('utf8');
  if (s === '\u0003') return { name: 'ctrl-c', raw: s };
  if (s === '\u0004') return { name: 'ctrl-d', raw: s };
  if (s === '\r' || s === '\n') return { name: 'enter', raw: s };
  if (s === '\u001b' || s === '\u001b\u001b') return { name: 'esc', raw: s };
  if (s === '\u001b[A' || s === '\u001bOA') return { name: 'up', raw: s };
  if (s === '\u001b[B' || s === '\u001bOB') return { name: 'down', raw: s };
  if (s === ' ') return { name: 'space', raw: s };
  if (s === '\t') return { name: 'tab', raw: s };
  if (s === '\u007f' || s === '\b') return { name: 'backspace', raw: s };
  if (/^[1-9]$/.test(s)) return { name: 'digit', digit: Number(s), raw: s };
  if (s.length === 1 && s >= ' ') return { name: 'char', char: s, raw: s };
  return { name: 'other', raw: s };
}
