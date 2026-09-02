import { describe, expect, it, vi } from 'vitest';
import { ApprovalController, AskController, type ApprovalChoice } from '../src/tui/modal-controller';
import type { AskAnswer, AskQuestion } from '../src/ws/event-types';
import type { KeyEvent } from '../src/tui/keydecode';
import type { ApprovalRequest } from '../src/tui/types';

const ENTER: KeyEvent = { kind: 'enter' };
const ESC: KeyEvent = { kind: 'escape' };
const UP: KeyEvent = { kind: 'up' };
const DOWN: KeyEvent = { kind: 'down' };
const CTRL_C: KeyEvent = { kind: 'ctrl', letter: 'c' };
const chars = (text: string): KeyEvent => ({ kind: 'char', text });

function ask(questions: AskQuestion[]) {
  const done = vi.fn<(a: AskAnswer[] | 'fail') => void>();
  const ctl = new AskController('req-1', questions, done);
  return {
    ctl,
    done,
    key: (...evs: KeyEvent[]) => evs.forEach((e) => ctl.handleKey(e)),
  };
}

const single: AskQuestion = {
  question: '选一个方案？',
  header: '方案',
  options: [
    { label: 'A 方案', description: '稳妥' },
    { label: 'B 方案' },
    { label: 'C 方案' },
  ],
};

const multi: AskQuestion = {
  question: '勾选需要的模块',
  multiSelect: true,
  options: [{ label: '后端' }, { label: '前端' }, { label: '文档' }],
};

describe('AskController single select', () => {
  it('exposes the current question and marks the active option', () => {
    const h = ask([single]);
    const s = h.ctl.state;
    expect(s).toMatchObject({ kind: 'ask', requestId: 'req-1', total: 1, index: 0, multiSelect: false });
    expect(s.question).toBe('选一个方案？');
    expect(s.header).toBe('方案');
    expect(s.options[0].active).toBe(true);
  });

  it('moves the cursor with arrows and wraps around', () => {
    const h = ask([single]);
    h.key(UP);
    expect(h.ctl.state.options[2].active).toBe(true);
    h.key(DOWN);
    expect(h.ctl.state.options[0].active).toBe(true);
  });

  it('tab and shift-tab move forward and backward', () => {
    const h = ask([single]);
    h.key({ kind: 'tab', shift: false });
    expect(h.ctl.state.options[1].active).toBe(true);
    h.key({ kind: 'tab', shift: true });
    expect(h.ctl.state.options[0].active).toBe(true);
  });

  it('Enter answers with the highlighted label', () => {
    const h = ask([single]);
    h.key(DOWN, ENTER);
    expect(h.done).toHaveBeenCalledWith([{ question: single.question, selectedLabels: ['B 方案'] }]);
  });

  it('a digit answers immediately', () => {
    const h = ask([single]);
    h.key(chars('3'));
    expect(h.done).toHaveBeenCalledWith([{ question: single.question, selectedLabels: ['C 方案'] }]);
  });

  it('ignores out-of-range digits', () => {
    const h = ask([single]);
    h.key(chars('9'));
    expect(h.done).not.toHaveBeenCalled();
  });
});

describe('AskController multi select', () => {
  it('space toggles and Enter submits in option order', () => {
    const h = ask([multi]);
    h.key(DOWN, chars(' '), UP, chars(' '), ENTER);
    expect(h.done).toHaveBeenCalledWith([{ question: multi.question, selectedLabels: ['后端', '前端'] }]);
  });

  it('digits toggle instead of submitting', () => {
    const h = ask([multi]);
    h.key(chars('3'));
    expect(h.done).not.toHaveBeenCalled();
    expect(h.ctl.state.options[2].checked).toBe(true);
    h.key(chars('3'));
    expect(h.ctl.state.options[2].checked).toBe(false);
  });

  it('allows submitting nothing', () => {
    const h = ask([multi]);
    h.key(ENTER);
    expect(h.done).toHaveBeenCalledWith([{ question: multi.question, selectedLabels: [] }]);
  });
});

describe('AskController custom input', () => {
  it('c switches to custom mode and Enter submits it as customInput', () => {
    const h = ask([single]);
    h.key(chars('c'));
    expect(h.ctl.state.customMode).toBe(true);
    h.key(chars('自定义答案'), ENTER);
    expect(h.done).toHaveBeenCalledWith([
      { question: single.question, selectedLabels: [], customInput: '自定义答案' },
    ]);
  });

  it('editing keys work inside custom input', () => {
    const h = ask([single]);
    h.key(chars('c'), chars('abc'), { kind: 'backspace' }, chars('d'));
    expect(h.ctl.state.custom).toBe('abd');
    h.key({ kind: 'home' }, { kind: 'delete' });
    expect(h.ctl.state.custom).toBe('bd');
    h.key({ kind: 'end' }, { kind: 'ctrl', letter: 'u' });
    expect(h.ctl.state.custom).toBe('');
  });

  it('pasted newlines collapse to spaces so one answer stays one line', () => {
    const h = ask([single]);
    h.key(chars('c'), { kind: 'paste', text: 'a\nb' });
    expect(h.ctl.state.custom).toBe('a b');
  });

  it('questions without options start in custom mode', () => {
    const h = ask([{ question: '随便说点什么', options: [] }]);
    expect(h.ctl.state.customMode).toBe(true);
    h.key(ENTER);
    expect(h.done).toHaveBeenCalledWith([{ question: '随便说点什么', selectedLabels: [] }]);
  });

  it('Esc leaves custom mode back to the option list', () => {
    const h = ask([single]);
    h.key(chars('c'), chars('x'), ESC);
    expect(h.ctl.state.customMode).toBe(false);
    expect(h.ctl.state.custom).toBe('');
    expect(h.done).not.toHaveBeenCalled();
  });
});

describe('AskController multiple questions and abort', () => {
  it('advances through questions and resets per-question state', () => {
    const h = ask([single, multi]);
    h.key(chars('1'));
    expect(h.done).not.toHaveBeenCalled();
    const s = h.ctl.state;
    expect(s.index).toBe(1);
    expect(s.multiSelect).toBe(true);
    expect(s.options.every((o) => !o.checked)).toBe(true);
    h.key(chars('1'), ENTER);
    expect(h.done).toHaveBeenCalledWith([
      { question: single.question, selectedLabels: ['A 方案'] },
      { question: multi.question, selectedLabels: ['后端'] },
    ]);
  });

  it('Esc on the option list fails the whole request', () => {
    const h = ask([single]);
    h.key(ESC);
    expect(h.done).toHaveBeenCalledWith('fail');
  });

  it('Ctrl+C fails the request', () => {
    const h = ask([single]);
    h.key(CTRL_C);
    expect(h.done).toHaveBeenCalledWith('fail');
  });
});

function approval(req: Partial<ApprovalRequest> = {}) {
  const done = vi.fn<(c: ApprovalChoice) => void>();
  const request: ApprovalRequest = {
    toolName: 'shell',
    description: 'rm -rf build',
    workspace: '/home/u/p',
    ...req,
  };
  const ctl = new ApprovalController(request, '需要写权限', done);
  return { ctl, done, key: (...evs: KeyEvent[]) => evs.forEach((e) => ctl.handleKey(e)) };
}

describe('ApprovalController safe requests', () => {
  it('y allows, n denies, a allows the whole session', () => {
    expect(approval().ctl.state).toMatchObject({ kind: 'approval', dangerous: false, confirming: null });
    const yes = approval();
    yes.key(chars('y'));
    expect(yes.done).toHaveBeenCalledWith('allow');
    const no = approval();
    no.key(chars('n'));
    expect(no.done).toHaveBeenCalledWith('deny');
    const always = approval();
    always.key(chars('a'));
    expect(always.done).toHaveBeenCalledWith('always');
  });

  it('Esc and Ctrl+C both deny', () => {
    const esc = approval();
    esc.key(ESC);
    expect(esc.done).toHaveBeenCalledWith('deny');
    const ctrlC = approval();
    ctrlC.key(CTRL_C);
    expect(ctrlC.done).toHaveBeenCalledWith('deny');
  });

  it('Enter alone does nothing when there is no pending choice', () => {
    const h = approval();
    h.key(ENTER);
    expect(h.done).not.toHaveBeenCalled();
  });

  it('ignores unrelated keys', () => {
    const h = approval();
    h.key(chars('q'), UP, { kind: 'tab', shift: false });
    expect(h.done).not.toHaveBeenCalled();
  });
});

describe('ApprovalController dangerous requests', () => {
  it('requires a second Enter before allowing', () => {
    const h = approval({ dangerReason: '递归删除' });
    expect(h.ctl.state.dangerous).toBe(true);
    h.key(chars('y'));
    expect(h.done).not.toHaveBeenCalled();
    expect(h.ctl.state.confirming).toBe('allow');
    h.key(ENTER);
    expect(h.done).toHaveBeenCalledWith('allow');
  });

  it('also gates the session-wide choice', () => {
    const h = approval({ dangerReason: '递归删除' });
    h.key(chars('a'));
    expect(h.ctl.state.confirming).toBe('always');
    expect(h.done).not.toHaveBeenCalled();
    h.key(ENTER);
    expect(h.done).toHaveBeenCalledWith('always');
  });

  it('Esc cancels the pending confirmation without denying', () => {
    const h = approval({ dangerReason: '递归删除' });
    h.key(chars('y'), ESC);
    expect(h.ctl.state.confirming).toBeNull();
    expect(h.done).not.toHaveBeenCalled();
    h.key(ESC);
    expect(h.done).toHaveBeenCalledWith('deny');
  });

  it('n still denies immediately', () => {
    const h = approval({ dangerReason: '递归删除' });
    h.key(chars('n'));
    expect(h.done).toHaveBeenCalledWith('deny');
  });
});
