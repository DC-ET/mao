/**
 * 输入行编辑状态机：光标 + 文本，按 grapheme 操作，支持多行草稿。
 *
 * 与渲染解耦，便于单测；所有方法返回新状态而不改动入参。
 */

import { displayWidth } from '../ui/width';

export interface EditorState {
  text: string;
  /** 光标位置（UTF-16 code unit 下标，始终落在 grapheme 边界上）。 */
  cursor: number;
}

export const EMPTY: EditorState = { text: '', cursor: 0 };

let segmenter: Intl.Segmenter | undefined;
function graphemes(text: string): string[] {
  if (!segmenter) segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...segmenter.segment(text)].map((s) => s.segment);
}

/** 光标左侧最近的 grapheme 起点。emoji / 组合字符按整体删除。 */
function prevBoundary(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  let idx = 0;
  let last = 0;
  for (const g of graphemes(text)) {
    if (idx + g.length >= cursor) return idx === cursor ? last : idx;
    last = idx;
    idx += g.length;
  }
  return last;
}

function nextBoundary(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  let idx = 0;
  for (const g of graphemes(text)) {
    if (idx >= cursor) return Math.min(text.length, idx + g.length);
    idx += g.length;
  }
  return text.length;
}

const WORD_RE = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string): boolean {
  return WORD_RE.test(ch);
}

export function insert(state: EditorState, text: string): EditorState {
  if (!text) return state;
  return {
    text: state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor),
    cursor: state.cursor + text.length,
  };
}

export function backspace(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  const start = prevBoundary(state.text, state.cursor);
  return { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start };
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor >= state.text.length) return state;
  const end = nextBoundary(state.text, state.cursor);
  return { text: state.text.slice(0, state.cursor) + state.text.slice(end), cursor: state.cursor };
}

export function moveLeft(state: EditorState): EditorState {
  return { text: state.text, cursor: prevBoundary(state.text, state.cursor) };
}

export function moveRight(state: EditorState): EditorState {
  return { text: state.text, cursor: nextBoundary(state.text, state.cursor) };
}

export function wordStart(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWordChar(text[i - 1])) i -= 1;
  while (i > 0 && isWordChar(text[i - 1])) i -= 1;
  return i;
}

export function wordEnd(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && !isWordChar(text[i])) i += 1;
  while (i < text.length && isWordChar(text[i])) i += 1;
  return i;
}

export function moveWordLeft(state: EditorState): EditorState {
  return { text: state.text, cursor: wordStart(state.text, state.cursor) };
}

export function moveWordRight(state: EditorState): EditorState {
  return { text: state.text, cursor: wordEnd(state.text, state.cursor) };
}

/** 当前行的起点（多行草稿下 Home 只回到本行行首）。 */
export function lineStart(text: string, cursor: number): number {
  const idx = text.lastIndexOf('\n', Math.max(0, cursor - 1));
  return idx === -1 ? 0 : idx + 1;
}

export function lineEnd(text: string, cursor: number): number {
  const idx = text.indexOf('\n', cursor);
  return idx === -1 ? text.length : idx;
}

export function moveHome(state: EditorState): EditorState {
  return { text: state.text, cursor: lineStart(state.text, state.cursor) };
}

export function moveEnd(state: EditorState): EditorState {
  return { text: state.text, cursor: lineEnd(state.text, state.cursor) };
}

export function killToEnd(state: EditorState): EditorState {
  const end = lineEnd(state.text, state.cursor);
  if (end === state.cursor) return state;
  return { text: state.text.slice(0, state.cursor) + state.text.slice(end), cursor: state.cursor };
}

export function killToStart(state: EditorState): EditorState {
  const start = lineStart(state.text, state.cursor);
  if (start === state.cursor) return state;
  return { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start };
}

export function killWordBefore(state: EditorState): EditorState {
  const start = wordStart(state.text, state.cursor);
  if (start === state.cursor) return state;
  return { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start };
}

export function killWordAfter(state: EditorState): EditorState {
  const end = wordEnd(state.text, state.cursor);
  if (end === state.cursor) return state;
  return { text: state.text.slice(0, state.cursor) + state.text.slice(end), cursor: state.cursor };
}

export function setText(text: string): EditorState {
  return { text, cursor: text.length };
}

/** 光标所在的逻辑行下标（0 起）。 */
export function cursorRow(state: EditorState): number {
  let row = 0;
  for (let i = 0; i < state.cursor; i++) {
    if (state.text[i] === '\n') row += 1;
  }
  return row;
}

export function rowCount(state: EditorState): number {
  return state.text.split('\n').length;
}

/** 上下移动一逻辑行，保持列位置（按列宽而非码点，CJK 才不会跳）。 */
export function moveVertical(state: EditorState, delta: -1 | 1): EditorState {
  const lines = state.text.split('\n');
  const row = cursorRow(state);
  const target = row + delta;
  if (target < 0 || target >= lines.length) return state;
  const col = displayWidth(state.text.slice(lineStart(state.text, state.cursor), state.cursor));
  let offset = 0;
  for (let i = 0; i < target; i++) offset += lines[i].length + 1;
  const line = lines[target];
  // 找到列宽不超过 col 的最大前缀位置（按列宽对齐，CJK 才不会跳格）
  let w = 0;
  let within = 0;
  for (const g of graphemes(line)) {
    const gw = displayWidth(g);
    if (w + gw > col) break;
    w += gw;
    within += g.length;
  }
  return { text: state.text, cursor: offset + within };
}
