import { describe, expect, it } from 'vitest';
import { allocateLive, computeBudget, tailRows, wrapByWidth } from '../src/tui/layout';

describe('computeBudget', () => {
  it('derives caps from the terminal size', () => {
    const b = computeBudget(40, 100);
    expect(b.rows).toBe(40);
    expect(b.columns).toBe(100);
    expect(b.draftRows).toBe(10);
    expect(b.tailRows).toBe(12);
    expect(b.announceRows).toBe(6);
    expect(b.thinkingRows).toBe(4);
  });

  it('falls back to 24x80 when the size is unknown', () => {
    const b = computeBudget(undefined, undefined);
    expect(b.rows).toBe(24);
    expect(b.columns).toBe(80);
  });

  it('clamps tiny terminals to a usable floor', () => {
    const b = computeBudget(2, 5);
    expect(b.rows).toBe(8);
    expect(b.columns).toBe(20);
    for (const v of [b.draftRows, b.announceRows, b.toolRows, b.tailRows, b.thinkingRows]) {
      expect(v).toBeGreaterThanOrEqual(1);
    }
    expect(b.paletteRows).toBeGreaterThanOrEqual(2);
  });

  it('never lets every区 cap sum reach the terminal height on a small screen', () => {
    const b = computeBudget(10, 80);
    // 单区上限本身必须小于终端高度，否则单个区块就能顶破 live 预算
    for (const v of [b.draftRows, b.announceRows, b.toolRows, b.tailRows, b.thinkingRows, b.paletteRows]) {
      expect(v).toBeLessThan(b.rows);
    }
  });
});

describe('allocateLive', () => {
  const budget = computeBudget(24, 80);

  it('keeps the live总高度 below the terminal height', () => {
    const sizes = allocateLive({
      budget,
      reserved: 4,
      want: { status: true, announce: 20, tools: 20, tail: 40, thinking: 10 },
    });
    expect(sizes.total).toBe(budget.rows - 2 - 4);
    expect(sizes.total + 4).toBeLessThan(budget.rows);
  });

  it('gives status the highest priority and starves the rest', () => {
    const sizes = allocateLive({
      budget,
      reserved: budget.rows - 3,
      want: { status: true, announce: 5, tools: 5, tail: 5, thinking: 5 },
    });
    expect(sizes.status).toBe(1);
    expect(sizes.total).toBe(1);
  });

  it('allocates in priority order status > announce > tools > tail > thinking', () => {
    const sizes = allocateLive({
      budget,
      reserved: budget.rows - 5,
      want: { status: true, announce: 1, tools: 1, tail: 5, thinking: 5 },
    });
    expect(sizes).toMatchObject({ status: 1, announce: 1, tools: 1 });
    expect(sizes.tail).toBe(0);
    expect(sizes.thinking).toBe(0);
  });

  it('returns zeros when the input box already fills the screen', () => {
    const sizes = allocateLive({
      budget,
      reserved: budget.rows + 10,
      want: { status: true, announce: 3, tools: 3, tail: 3, thinking: 3 },
    });
    expect(sizes.total).toBe(0);
  });

  it('never exceeds the per-area caps even with plenty of room', () => {
    const big = computeBudget(120, 80);
    const sizes = allocateLive({
      budget: big,
      reserved: 3,
      want: { status: true, announce: 99, tools: 99, tail: 99, thinking: 99 },
    });
    expect(sizes.announce).toBe(big.announceRows);
    expect(sizes.tools).toBe(big.toolRows);
    expect(sizes.tail).toBe(big.tailRows);
    expect(sizes.thinking).toBe(big.thinkingRows);
  });
});

describe('wrapByWidth', () => {
  it('wraps by display width so CJK counts as two columns', () => {
    expect(wrapByWidth('中文中文', 4)).toEqual(['中文', '中文']);
    expect(wrapByWidth('abcdef', 4)).toEqual(['abcd', 'ef']);
  });

  it('returns an empty list for empty text and keeps short text intact', () => {
    expect(wrapByWidth('', 10)).toEqual([]);
    expect(wrapByWidth('short', 10)).toEqual(['short']);
  });

  it('enforces a minimum column count instead of looping forever', () => {
    expect(wrapByWidth('abcdefgh', 0)).toEqual(['abcd', 'efgh']);
  });
});

describe('tailRows', () => {
  it('returns only the last N visual rows', () => {
    expect(tailRows('abcdefghij', 4, 2)).toEqual(['efgh', 'ij']);
  });

  it('returns nothing when there is no room or no text', () => {
    expect(tailRows('abc', 10, 0)).toEqual([]);
    expect(tailRows('', 10, 3)).toEqual([]);
  });

  it('honours the row cap for wide characters too', () => {
    const rows = tailRows('中'.repeat(20), 10, 3);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(5);
  });
});
