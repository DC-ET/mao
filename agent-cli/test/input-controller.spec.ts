import { describe, expect, it } from 'vitest';
import { InputController, fenceOpen, type InputHandlers } from '../src/tui/input-controller';
import type { KeyEvent } from '../src/tui/keydecode';

interface Harness {
  ctl: InputController;
  submitted: string[];
  events: string[];
  committed: string[];
  type: (text: string) => void;
  key: (...evs: KeyEvent[]) => void;
}

function harness(opts: { history?: string[]; models?: string[]; historyMax?: number } = {}): Harness {
  const submitted: string[] = [];
  const events: string[] = [];
  const committed: string[] = [];
  const handlers: InputHandlers = {
    onSubmit: (t) => submitted.push(t),
    onCancel: () => events.push('cancel'),
    onEscape: () => events.push('escape'),
    onExit: () => events.push('exit'),
    onClearScreen: () => events.push('clear'),
    onChange: () => events.push('change'),
  };
  const ctl = new InputController({
    handlers,
    history: opts.history,
    historyMax: opts.historyMax,
    onHistoryCommit: (t) => committed.push(t),
    modelNames: opts.models,
  });
  return {
    ctl,
    submitted,
    events,
    committed,
    type: (text: string) => ctl.handleKey({ kind: 'char', text }),
    key: (...evs: KeyEvent[]) => evs.forEach((e) => ctl.handleKey(e)),
  };
}

const ENTER: KeyEvent = { kind: 'enter' };
const ESC: KeyEvent = { kind: 'escape' };
const UP: KeyEvent = { kind: 'up' };
const DOWN: KeyEvent = { kind: 'down' };
const TAB: KeyEvent = { kind: 'tab', shift: false };
const ctrl = (letter: string): KeyEvent => ({ kind: 'ctrl', letter });
const alt = (letter: string): KeyEvent => ({ kind: 'alt', letter });

describe('fenceOpen', () => {
  it('detects an unbalanced code fence', () => {
    expect(fenceOpen('```ts')).toBe(true);
    expect(fenceOpen('```ts\ncode\n```')).toBe(false);
    expect(fenceOpen('no fence')).toBe(false);
  });
});

describe('InputController submit', () => {
  it('trims and submits, then clears the draft', () => {
    const h = harness();
    h.type('  hello  ');
    h.key(ENTER);
    expect(h.submitted).toEqual(['hello']);
    expect(h.ctl.text).toBe('');
  });

  it('ignores an empty submit', () => {
    const h = harness();
    h.key(ENTER);
    expect(h.submitted).toEqual([]);
  });

  it('turns a trailing backslash into a newline instead of submitting', () => {
    const h = harness();
    h.type('line one \\');
    h.key(ENTER);
    expect(h.submitted).toEqual([]);
    expect(h.ctl.text).toBe('line one \n');
    expect(h.ctl.continuation).toBe(true);
  });

  it('keeps an unbalanced fence open across enters', () => {
    const h = harness();
    h.type('```ts');
    h.key(ENTER);
    h.type('code');
    h.key(ENTER);
    expect(h.submitted).toEqual([]);
    h.type('```');
    h.key(ENTER);
    expect(h.submitted).toEqual(['```ts\ncode\n```']);
  });

  it('Ctrl+J inserts a newline and Enter then submits the whole draft', () => {
    const h = harness();
    h.type('a');
    h.key(ctrl('j'));
    h.type('b');
    expect(h.ctl.continuation).toBe(true);
    h.key(ENTER);
    expect(h.submitted).toEqual(['a\nb']);
  });

  it('Alt+Enter also inserts a newline', () => {
    const h = harness();
    h.type('a');
    h.key(alt('enter'));
    expect(h.ctl.text).toBe('a\n');
  });

  it('pastes multi-line content without submitting', () => {
    const h = harness();
    h.key({ kind: 'paste', text: 'l1\nl2\nl3' });
    expect(h.ctl.text).toBe('l1\nl2\nl3');
    expect(h.submitted).toEqual([]);
  });
});

describe('InputController control keys', () => {
  it('Ctrl+C clears a non-empty draft before propagating cancel', () => {
    const h = harness();
    h.type('draft');
    h.key(ctrl('c'));
    expect(h.ctl.text).toBe('');
    expect(h.events).not.toContain('cancel');
    h.key(ctrl('c'));
    expect(h.events).toContain('cancel');
  });

  it('Ctrl+D exits only when the draft is empty', () => {
    const h = harness();
    h.type('ab');
    h.key({ kind: 'home' }, ctrl('d'));
    expect(h.ctl.text).toBe('b');
    expect(h.events).not.toContain('exit');
    h.key(ctrl('d'));
    expect(h.events).not.toContain('exit');
    h.key(ctrl('d'));
    expect(h.events).toContain('exit');
  });

  it('Ctrl+L asks for a screen clear without touching the draft', () => {
    const h = harness();
    h.type('keep');
    h.key(ctrl('l'));
    expect(h.events).toContain('clear');
    expect(h.ctl.text).toBe('keep');
  });

  it('emacs motions and kills work on the draft', () => {
    const h = harness();
    h.type('foo bar');
    h.key(ctrl('a'));
    expect(h.ctl.cursor).toBe(0);
    h.key(ctrl('e'));
    expect(h.ctl.cursor).toBe(7);
    h.key(ctrl('w'));
    expect(h.ctl.text).toBe('foo ');
    h.key(ctrl('u'));
    expect(h.ctl.text).toBe('');
  });

  it('Escape clears the draft first, then propagates', () => {
    const h = harness();
    h.type('draft');
    h.key(ESC);
    expect(h.ctl.text).toBe('');
    expect(h.events).not.toContain('escape');
    h.key(ESC);
    expect(h.events).toContain('escape');
  });
});

describe('InputController history', () => {
  it('walks history with up/down and restores the draft', () => {
    const h = harness({ history: ['first', 'second'] });
    h.type('draft');
    h.key(UP);
    expect(h.ctl.text).toBe('second');
    h.key(UP);
    expect(h.ctl.text).toBe('first');
    h.key(UP);
    expect(h.ctl.text).toBe('first');
    h.key(DOWN);
    expect(h.ctl.text).toBe('second');
    h.key(DOWN);
    expect(h.ctl.text).toBe('draft');
  });

  it('records submissions, dedupes the last entry and caps the size', () => {
    const h = harness({ historyMax: 2 });
    h.type('a');
    h.key(ENTER);
    h.type('a');
    h.key(ENTER);
    expect(h.committed).toEqual(['a']);
    h.type('b');
    h.key(ENTER);
    h.type('c');
    h.key(ENTER);
    h.key(UP, UP, UP);
    expect(h.ctl.text).toBe('b');
  });

  it('up moves within a multi-line draft before reaching history', () => {
    const h = harness({ history: ['old'] });
    h.type('l1');
    h.key(ctrl('j'));
    h.type('l2');
    h.key(UP);
    expect(h.ctl.text).toBe('l1\nl2');
    h.key(UP);
    expect(h.ctl.text).toBe('old');
  });
});

describe('InputController slash palette', () => {
  it('opens on / and filters by prefix', () => {
    const h = harness();
    h.type('/he');
    const view = h.ctl.view({ columns: 80, maxRows: 5, paletteRows: 8 });
    expect(view.palette?.items.map((i) => i.label)).toEqual(['/help']);
  });

  it('Enter runs the highlighted command instead of submitting raw text', () => {
    const h = harness();
    h.type('/help');
    h.key(ENTER);
    expect(h.submitted).toEqual(['/help']);
  });

  it('Tab fills in a command that needs an argument without submitting', () => {
    const h = harness({ models: ['gpt-4o'] });
    h.type('/mod');
    h.key(TAB);
    expect(h.ctl.text).toBe('/model ');
    expect(h.submitted).toEqual([]);
    const view = h.ctl.view({ columns: 80, maxRows: 5, paletteRows: 8 });
    expect(view.palette?.items.some((i) => i.label === 'gpt-4o')).toBe(true);
  });

  it('up/down move the palette cursor rather than history', () => {
    const h = harness({ history: ['old'] });
    h.type('/');
    h.key(DOWN);
    const view = h.ctl.view({ columns: 80, maxRows: 5, paletteRows: 8 });
    expect(view.palette?.cursor).toBe(1);
    expect(h.ctl.text).toBe('/');
  });

  it('Escape closes the palette but keeps the draft', () => {
    const h = harness();
    h.type('/he');
    h.key(ESC);
    expect(h.ctl.text).toBe('/he');
    expect(h.ctl.view({ columns: 80, maxRows: 5, paletteRows: 8 }).palette).toBeNull();
    // 继续编辑后重新打开
    h.type('l');
    expect(h.ctl.view({ columns: 80, maxRows: 5, paletteRows: 8 }).palette).not.toBeNull();
  });

  it('stays closed for multi-line drafts', () => {
    const h = harness();
    h.type('/help');
    h.key(ctrl('j'));
    expect(h.ctl.view({ columns: 80, maxRows: 5, paletteRows: 8 }).palette).toBeNull();
  });
});

describe('InputController view', () => {
  it('reports placeholder and a two-row height when empty', () => {
    const h = harness();
    const view = h.ctl.view({ columns: 80, maxRows: 5, paletteRows: 8 });
    expect(view.placeholder).toBe(true);
    expect(view.rows).toHaveLength(1);
    expect(view.height).toBe(3);
  });

  it('windows vertically around the cursor', () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      h.type(`l${i}`);
      h.key(ctrl('j'));
    }
    h.type('l10');
    const view = h.ctl.view({ columns: 80, maxRows: 4, paletteRows: 8 });
    expect(view.rows).toHaveLength(4);
    expect(view.rows[view.rows.length - 1].text).toBe('l10');
    expect(view.rows.some((r) => r.cursorAt !== undefined)).toBe(true);
    expect(view.height).toBe(6);
  });

  it('clips horizontally around the cursor and flags both sides', () => {
    const h = harness();
    h.type('x'.repeat(200));
    const wide = h.ctl.view({ columns: 40, maxRows: 3, paletteRows: 8 });
    expect(wide.rows[0].text.length).toBe(34);
    expect(wide.rows[0].clipLeft).toBe(true);
    expect(wide.rows[0].cursorAt).toBeLessThanOrEqual(34);
    h.key(ctrl('a'));
    const atStart = h.ctl.view({ columns: 40, maxRows: 3, paletteRows: 8 });
    expect(atStart.rows[0].clipLeft).toBeUndefined();
    expect(atStart.rows[0].clipRight).toBe(true);
    expect(atStart.rows[0].cursorAt).toBe(0);
  });

  it('counts the palette in the reported height', () => {
    const h = harness();
    h.type('/he');
    const view = h.ctl.view({ columns: 80, maxRows: 5, paletteRows: 8 });
    expect(view.height).toBe(view.rows.length + 2 + 4);
  });

  it('caps palette rows and marks the overflow', () => {
    const h = harness();
    h.type('/');
    const view = h.ctl.view({ columns: 80, maxRows: 5, paletteRows: 3 });
    expect(view.palette?.items).toHaveLength(3);
    expect(view.palette?.total).toBeGreaterThan(3);
    expect(view.height).toBe(view.rows.length + 2 + 3 + 3 + 1);
  });

  it('reset clears text, history position and palette state', () => {
    const h = harness({ history: ['x'] });
    h.type('/he');
    h.ctl.reset();
    expect(h.ctl.text).toBe('');
    expect(h.ctl.cursor).toBe(0);
  });
});
