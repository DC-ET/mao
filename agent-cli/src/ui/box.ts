import { displayWidth, padToWidth, truncateToWidth } from './width';

export interface BoxGlyphs {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

export const UNICODE_BOX: BoxGlyphs = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
export const ASCII_BOX: BoxGlyphs = { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

export function pickBox(ascii: boolean): BoxGlyphs {
  return ascii ? ASCII_BOX : UNICODE_BOX;
}

export function hLine(left: string, right: string, bar: string, cols: number): string {
  const inner = Math.max(0, cols - displayWidth(left) - displayWidth(right));
  return left + bar.repeat(inner) + right;
}

export function boxRow(inner: string, cols: number, v: string): string {
  const innerW = Math.max(0, cols - 2 * displayWidth(v));
  return v + padToWidth(truncateToWidth(inner, innerW), innerW) + v;
}

const ARG_KEYS = ['command', 'path', 'file_path', 'glob', 'pattern', 'query', 'url', 'old_string', 'content'];

/** 把工具 JSON 参数收成 Claude/Codex 那种一眼能扫的短句。 */
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

export function formatUserTurn(text: string, opts: { ascii?: boolean; paint?: (s: string) => string }): string {
  const mark = opts.ascii ? '>' : '❯';
  const paint = opts.paint ?? ((s: string) => s);
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.map((line, i) => paint(i === 0 ? `${mark} ${line}` : `  ${line}`)).join('\n');
}

/** Cursor Agent 式用户气泡：整行深灰底。 */
export function formatUserBlock(text: string, opts: { cols: number; paint?: (s: string) => string }): string {
  const cols = Math.max(20, opts.cols || 80);
  const paint = opts.paint ?? ((s: string) => s);
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.map((line) => {
    const inner = ` ${line} `;
    return paint(padToWidth(truncateToWidth(inner, cols), cols));
  }).join('\n');
}

export function formatToolStart(name: string, args: string, opts: { ascii?: boolean; paint?: (s: string) => string }): string {
  const dot = opts.ascii ? '*' : '⏺';
  const paint = opts.paint ?? ((s: string) => s);
  const detail = args ? `  ${args}` : '';
  return paint(`${dot} ${name}${detail}`);
}

export function formatToolResult(summary: string, opts: { ascii?: boolean; paint?: (s: string) => string }): string {
  const tail = opts.ascii ? '  |' : '  ⎿';
  const paint = opts.paint ?? ((s: string) => s);
  const body = summary.replace(/\s+/g, ' ').trim() || 'ok';
  return paint(`${tail}  ${body}`);
}
