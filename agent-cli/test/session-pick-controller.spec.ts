import { describe, expect, it, vi } from 'vitest';
import {
  SessionPickController,
  pickSessionWindow,
  type SessionPickItem,
} from '../src/tui/modal-controller';
import type { KeyEvent } from '../src/tui/keydecode';

const ENTER: KeyEvent = { kind: 'enter' };
const ESC: KeyEvent = { kind: 'escape' };
const UP: KeyEvent = { kind: 'up' };
const DOWN: KeyEvent = { kind: 'down' };
const CTRL_C: KeyEvent = { kind: 'ctrl', letter: 'c' };
const chars = (text: string): KeyEvent => ({ kind: 'char', text });

const items: SessionPickItem[] = Array.from({ length: 12 }, (_, i) => ({
  id: 100 + i,
  title: `会话 ${100 + i}`,
  agentName: 'A',
  updatedAt: '2026-11-06T10:00:00',
}));

function pick(list: SessionPickItem[] = items) {
  const done = vi.fn<(id: number | null) => void>();
  const ctl = new SessionPickController(list, done);
  return { ctl, done, key: (...evs: KeyEvent[]) => evs.forEach((e) => ctl.handleKey(e)) };
}

describe('SessionPickController', () => {
  it('starts at the first item and reports the total', () => {
    const h = pick();
    expect(h.ctl.state).toMatchObject({ kind: 'session-pick', cursor: 0, total: 12 });
  });

  it('moves with arrows and clamps at both ends', () => {
    const h = pick();
    h.key(UP);
    expect(h.ctl.state.cursor).toBe(0);
    h.key(DOWN, DOWN);
    expect(h.ctl.state.cursor).toBe(2);
    for (let i = 0; i < 20; i++) h.key(DOWN);
    expect(h.ctl.state.cursor).toBe(11);
  });

  it('supports j/k navigation', () => {
    const h = pick();
    h.key(chars('j'), chars('j'), chars('k'));
    expect(h.ctl.state.cursor).toBe(1);
  });

  it('Enter selects the highlighted session', () => {
    const h = pick();
    h.key(DOWN, DOWN, ENTER);
    expect(h.done).toHaveBeenCalledWith(102);
  });

  it('Esc cancels with null', () => {
    const h = pick();
    h.key(ESC);
    expect(h.done).toHaveBeenCalledWith(null);
  });

  it('Ctrl+C cancels with null', () => {
    const h = pick();
    h.key(CTRL_C);
    expect(h.done).toHaveBeenCalledWith(null);
  });

  it('Enter on an empty list yields null', () => {
    const h = pick([]);
    h.key(ENTER);
    expect(h.done).toHaveBeenCalledWith(null);
  });
});

describe('pickSessionWindow', () => {
  it('keeps the cursor inside the visible window for every combination', () => {
    for (const total of [0, 1, 3, 12]) {
      for (const visible of [0, 1, 3, 5, 8, 20]) {
        for (let cursor = 0; cursor < Math.max(1, total); cursor++) {
          const { offset, size } = pickSessionWindow(total, cursor, visible);
          if (size === 0) {
            expect(offset).toBe(0);
            continue;
          }
          expect(cursor).toBeGreaterThanOrEqual(offset);
          expect(cursor).toBeLessThan(offset + size);
          expect(offset + size).toBeLessThanOrEqual(total);
        }
      }
    }
  });

  it('centres the cursor when possible and caps at the total', () => {
    expect(pickSessionWindow(12, 0, 8)).toEqual({ offset: 0, size: 8 });
    expect(pickSessionWindow(12, 6, 8)).toEqual({ offset: 2, size: 8 });
    expect(pickSessionWindow(12, 11, 5)).toEqual({ offset: 7, size: 5 });
    expect(pickSessionWindow(3, 2, 8)).toEqual({ offset: 0, size: 3 });
    expect(pickSessionWindow(0, 0, 8)).toEqual({ offset: 0, size: 0 });
  });
});
