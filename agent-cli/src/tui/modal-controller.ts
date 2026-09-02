import type { AskAnswer, AskQuestion } from '../ws/event-types';
import type { KeyEvent } from './keydecode';
import { EMPTY, backspace, deleteForward, insert, killToStart, moveEnd, moveHome, moveLeft, moveRight, type EditorState } from './line-editor';
import type { ApprovalRequest } from './types';

export interface AskViewState {
  kind: 'ask';
  requestId: string;
  total: number;
  index: number;
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string; checked: boolean; active: boolean }>;
  customMode: boolean;
  custom: string;
  customCursor: number;
}

/**
 * ask_user_questions 的键盘状态机。与渲染解耦，键盘入口统一由 KeyDecoder 提供，
 * 因此不会与输入框争抢 raw mode，也不依赖 Ink 的 useInput。
 */
export class AskController {
  private qIndex = 0;
  private cursor = 0;
  private selected = new Set<number>();
  private customMode = false;
  private custom: EditorState = EMPTY;
  private readonly answers: AskAnswer[] = [];

  constructor(
    readonly requestId: string,
    private readonly questions: AskQuestion[],
    private readonly onDone: (answers: AskAnswer[] | 'fail') => void,
  ) {}

  private get question(): AskQuestion | undefined {
    return this.questions[this.qIndex];
  }

  get state(): AskViewState {
    const q = this.question;
    const options = q?.options ?? [];
    return {
      kind: 'ask',
      requestId: this.requestId,
      total: this.questions.length,
      index: this.qIndex,
      question: q?.question ?? '',
      header: q?.header,
      multiSelect: Boolean(q?.multiSelect),
      options: options.map((o, i) => ({
        label: o.label,
        description: o.description,
        checked: this.selected.has(i),
        active: i === this.cursor,
      })),
      customMode: this.customMode || options.length === 0,
      custom: this.custom.text,
      customCursor: this.custom.cursor,
    };
  }

  handleKey(ev: KeyEvent): void {
    const q = this.question;
    if (!q) {
      this.onDone('fail');
      return;
    }
    const options = q.options ?? [];
    const inCustom = this.customMode || options.length === 0;

    if (ev.kind === 'ctrl' && ev.letter === 'c') {
      this.onDone('fail');
      return;
    }
    if (ev.kind === 'escape') {
      if (this.customMode && options.length > 0) {
        this.customMode = false;
        this.custom = EMPTY;
        return;
      }
      this.onDone('fail');
      return;
    }

    if (inCustom) {
      this.editCustom(ev, q);
      return;
    }

    switch (ev.kind) {
      case 'up':
        this.cursor = (this.cursor - 1 + options.length) % options.length;
        return;
      case 'down':
        this.cursor = (this.cursor + 1) % options.length;
        return;
      case 'tab':
        this.cursor = (this.cursor + (ev.shift ? options.length - 1 : 1)) % options.length;
        return;
      case 'enter':
        if (q.multiSelect) {
          const labels = [...this.selected].sort((a, b) => a - b).map((i) => options[i]?.label).filter(Boolean) as string[];
          this.commit({ question: q.question, selectedLabels: labels });
        } else {
          const opt = options[this.cursor];
          this.commit({ question: q.question, selectedLabels: opt ? [opt.label] : [] });
        }
        return;
      case 'char':
        this.handleCharInSelect(ev.text, q, options.length);
        return;
      default:
        return;
    }
  }

  private handleCharInSelect(text: string, q: AskQuestion, optionCount: number): void {
    for (const ch of text) {
      if (ch === ' ' && q.multiSelect) {
        if (this.selected.has(this.cursor)) this.selected.delete(this.cursor);
        else this.selected.add(this.cursor);
        continue;
      }
      if (ch === 'c' || ch === 'C') {
        this.customMode = true;
        continue;
      }
      const digit = Number(ch);
      if (Number.isInteger(digit) && digit >= 1 && digit <= optionCount) {
        const i = digit - 1;
        this.cursor = i;
        if (q.multiSelect) {
          if (this.selected.has(i)) this.selected.delete(i);
          else this.selected.add(i);
        } else {
          this.commit({ question: q.question, selectedLabels: [q.options?.[i]?.label ?? ''] });
          return;
        }
      }
    }
  }

  private editCustom(ev: KeyEvent, q: AskQuestion): void {
    switch (ev.kind) {
      case 'enter': {
        const text = this.custom.text.trim();
        const ans: AskAnswer = { question: q.question, selectedLabels: [] };
        if (text) ans.customInput = text;
        this.commit(ans);
        return;
      }
      case 'char':
      case 'paste':
        this.custom = insert(this.custom, ev.text.replace(/\n/g, ' '));
        return;
      case 'backspace':
        this.custom = backspace(this.custom);
        return;
      case 'delete':
        this.custom = deleteForward(this.custom);
        return;
      case 'left':
        this.custom = moveLeft(this.custom);
        return;
      case 'right':
        this.custom = moveRight(this.custom);
        return;
      case 'home':
        this.custom = moveHome(this.custom);
        return;
      case 'end':
        this.custom = moveEnd(this.custom);
        return;
      case 'ctrl':
        if (ev.letter === 'u') this.custom = killToStart(this.custom);
        else if (ev.letter === 'a') this.custom = moveHome(this.custom);
        else if (ev.letter === 'e') this.custom = moveEnd(this.custom);
        else if (ev.letter === 'h') this.custom = backspace(this.custom);
        return;
      default:
        return;
    }
  }

  private commit(ans: AskAnswer): void {
    this.answers.push(ans);
    if (this.qIndex + 1 < this.questions.length) {
      this.qIndex += 1;
      this.cursor = 0;
      this.selected = new Set();
      this.customMode = false;
      this.custom = EMPTY;
      return;
    }
    this.onDone(this.answers);
  }
}

export type ApprovalChoice = 'allow' | 'deny' | 'always';

export interface ApprovalViewState {
  kind: 'approval';
  request: ApprovalRequest;
  reason: string;
  /** 危险操作需要二次确认；此时展示待确认的选择。 */
  confirming: ApprovalChoice | null;
  dangerous: boolean;
}

/**
 * LOCAL 审批弹窗的键盘状态机。
 * dangerReason 非空时 y/a 只是「预选」，必须再按 Enter 才生效，避免误按一次就放行危险命令。
 */
export class ApprovalController {
  private confirming: ApprovalChoice | null = null;

  constructor(
    readonly request: ApprovalRequest,
    readonly reason: string,
    private readonly onDone: (choice: ApprovalChoice) => void,
  ) {}

  private get dangerous(): boolean {
    return Boolean(this.request.dangerReason);
  }

  get state(): ApprovalViewState {
    return {
      kind: 'approval',
      request: this.request,
      reason: this.reason,
      confirming: this.confirming,
      dangerous: this.dangerous,
    };
  }

  handleKey(ev: KeyEvent): void {
    if (ev.kind === 'ctrl' && ev.letter === 'c') {
      this.onDone('deny');
      return;
    }
    if (ev.kind === 'escape') {
      if (this.confirming) {
        this.confirming = null;
        return;
      }
      this.onDone('deny');
      return;
    }
    if (ev.kind === 'enter') {
      if (this.confirming) this.onDone(this.confirming);
      return;
    }
    if (ev.kind !== 'char') return;
    for (const ch of ev.text.toLowerCase()) {
      if (ch === 'n') {
        this.onDone('deny');
        return;
      }
      if (ch === 'y' || ch === 'a') {
        const choice: ApprovalChoice = ch === 'y' ? 'allow' : 'always';
        if (!this.dangerous) {
          this.onDone(choice);
          return;
        }
        this.confirming = choice;
        return;
      }
    }
  }
}
