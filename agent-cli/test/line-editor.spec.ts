import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  backspace,
  cursorRow,
  deleteForward,
  insert,
  killToEnd,
  killToStart,
  killWordAfter,
  killWordBefore,
  lineEnd,
  lineStart,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveVertical,
  moveWordLeft,
  moveWordRight,
  rowCount,
  setText,
  wordEnd,
  wordStart,
  type EditorState,
} from '../src/tui/line-editor';

function at(text: string, cursor = text.length): EditorState {
  return { text, cursor };
}

describe('line-editor insert / delete', () => {
  it('inserts at the cursor and advances it', () => {
    expect(insert(at('ac', 1), 'b')).toEqual({ text: 'abc', cursor: 2 });
    expect(insert(EMPTY, '')).toBe(EMPTY);
  });

  it('deletes whole graphemes, not code units', () => {
    // 家庭 emoji 由多个码点 + ZWJ 组成，按码元删会留下残片
    const family = '👨‍👩‍👧';
    expect(backspace(at(`a${family}`)).text).toBe('a');
    expect(backspace(at('中文')).text).toBe('中');
    expect(deleteForward(at(family, 0)).text).toBe('');
  });

  it('is a no-op at the boundaries', () => {
    const s = at('abc', 0);
    expect(backspace(s)).toBe(s);
    const e = at('abc');
    expect(deleteForward(e)).toBe(e);
  });

  it('moves across grapheme boundaries', () => {
    const s = at('a👍b', 0);
    const one = moveRight(s);
    expect(one.cursor).toBe(1);
    const two = moveRight(one);
    expect(two.cursor).toBe(3);
    expect(moveLeft(two).cursor).toBe(1);
  });
});

describe('line-editor word motion', () => {
  it('finds word starts and ends across punctuation', () => {
    const text = 'foo bar_baz  qux';
    expect(wordStart(text, text.length)).toBe(13);
    expect(wordStart(text, 7)).toBe(4);
    expect(wordEnd(text, 0)).toBe(3);
    expect(wordEnd(text, 3)).toBe(11);
  });

  it('moves and kills by word', () => {
    expect(moveWordLeft(at('foo bar')).cursor).toBe(4);
    expect(moveWordRight(at('foo bar', 0)).cursor).toBe(3);
    expect(killWordBefore(at('foo bar'))).toEqual({ text: 'foo ', cursor: 4 });
    expect(killWordAfter(at('foo bar', 0))).toEqual({ text: ' bar', cursor: 0 });
  });

  it('treats CJK and digits as word characters', () => {
    expect(killWordBefore(at('删除中文词')).text).toBe('');
    expect(moveWordLeft(at('a 12_3')).cursor).toBe(2);
  });
});

describe('line-editor multi-line', () => {
  const draft = 'first\nsecond line\nthird';

  it('home/end stay inside the current logical line', () => {
    expect(lineStart(draft, 8)).toBe(6);
    expect(lineEnd(draft, 8)).toBe(17);
    expect(moveHome(at(draft, 8)).cursor).toBe(6);
    expect(moveEnd(at(draft, 8)).cursor).toBe(17);
  });

  it('kill to start/end only affect the current line', () => {
    expect(killToEnd(at(draft, 6)).text).toBe('first\n\nthird');
    expect(killToStart(at(draft, 8)).text).toBe('first\ncond line\nthird');
  });

  it('counts rows and the cursor row', () => {
    expect(rowCount(at(draft))).toBe(3);
    expect(cursorRow(at(draft, 0))).toBe(0);
    expect(cursorRow(at(draft, 8))).toBe(1);
    expect(cursorRow(at(draft))).toBe(2);
  });

  it('moveVertical keeps the display column', () => {
    const down = moveVertical(at(draft, 3), 1);
    expect(down.cursor).toBe(9);
    const up = moveVertical(down, -1);
    expect(up.cursor).toBe(3);
  });

  it('moveVertical clamps to the end of shorter lines', () => {
    const s = at('long line here\nab', 12);
    expect(moveVertical(s, 1).cursor).toBe(17);
  });

  it('moveVertical aligns CJK by column width, not code units', () => {
    // 「中文中文」宽 8 列；ASCII 行的第 8 列对应下标 8
    const s = at('中文中文\nabcdefghij', 4);
    const moved = moveVertical(s, 1);
    expect(moved.cursor).toBe(5 + 8);
  });

  it('moveVertical is a no-op past the first/last line', () => {
    const first = at(draft, 2);
    expect(moveVertical(first, -1)).toBe(first);
    const last = at(draft, draft.length);
    expect(moveVertical(last, 1)).toBe(last);
  });

  it('setText puts the cursor at the end', () => {
    expect(setText('abc')).toEqual({ text: 'abc', cursor: 3 });
  });
});
