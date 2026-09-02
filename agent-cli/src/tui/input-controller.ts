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
  type EditorState,
} from './line-editor';
import type { KeyEvent } from './keydecode';
import { paletteWindow, slashPalette, type SlashPick } from '../ui/slash-complete';

export interface InputRow {
  text: string;
  /** 光标在本行 text 中的 UTF-16 下标；不在本行时为 undefined。 */
  cursorAt?: number;
  /** 左/右侧是否因横向裁剪而截断。 */
  clipLeft?: boolean;
  clipRight?: boolean;
}

export interface PaletteView {
  items: SlashPick[];
  /** 相对 items 的选中下标。 */
  cursor: number;
  total: number;
}

export interface InputView {
  rows: InputRow[];
  placeholder: boolean;
  continuation: boolean;
  palette: PaletteView | null;
  /** 本视图实际渲染的终端行数（含边框、补全面板），用于 live 区高度精算。 */
  height: number;
}

export interface InputHandlers {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onEscape: () => void;
  onExit: () => void;
  onClearScreen: () => void;
  onChange?: () => void;
}

export interface InputControllerOptions {
  handlers: InputHandlers;
  history?: string[];
  historyMax?: number;
  onHistoryCommit?: (text: string) => void;
  modelNames?: string[];
}

const HISTORY_MAX = 50;

/** 未闭合的 ``` 代码块：回车应换行而不是提交。 */
export function fenceOpen(text: string): boolean {
  const matches = text.match(/```/g);
  return Boolean(matches && matches.length % 2 === 1);
}

/**
 * 输入区状态机：编辑器 + 历史 + 斜杠补全 + 续行判定。
 *
 * 与 React 解耦（renderer 直接驱动），因此续行、fence、历史只有这一份实现，
 * 也可以脱离终端做单元测试。
 */
export class InputController {
  private state: EditorState = EMPTY;
  private history: string[];
  private historyIdx = -1;
  private historyDraft = '';
  private pickCursor = 0;
  private paletteOff = false;
  private readonly handlers: InputHandlers;
  private readonly historyMax: number;
  private readonly onHistoryCommit?: (text: string) => void;
  private modelNames: string[];

  constructor(opts: InputControllerOptions) {
    this.handlers = opts.handlers;
    this.history = [...(opts.history ?? [])];
    this.historyMax = opts.historyMax ?? HISTORY_MAX;
    this.onHistoryCommit = opts.onHistoryCommit;
    this.modelNames = opts.modelNames ?? [];
  }

  setModelNames(names: string[]): void {
    this.modelNames = names;
  }

  get text(): string {
    return this.state.text;
  }

  get cursor(): number {
    return this.state.cursor;
  }

  reset(): void {
    this.state = EMPTY;
    this.historyIdx = -1;
    this.pickCursor = 0;
    this.paletteOff = false;
  }

  /** 当前是否处于「回车换行而非提交」的状态。 */
  get continuation(): boolean {
    return this.state.text.includes('\n') || fenceOpen(this.state.text);
  }

  private picks(): SlashPick[] {
    if (this.paletteOff) return [];
    if (this.state.text.includes('\n')) return [];
    return slashPalette(this.state.text, { models: this.modelNames });
  }

  handleKey(ev: KeyEvent): void {
    const picks = this.picks();
    const paletteOpen = picks.length > 0;

    switch (ev.kind) {
      case 'ctrl':
        this.handleCtrl(ev.letter);
        return;
      case 'alt':
        this.handleAlt(ev.letter);
        return;
      case 'escape':
        if (paletteOpen) {
          this.paletteOff = true;
          this.changed();
          return;
        }
        if (this.state.text) {
          this.state = EMPTY;
          this.historyIdx = -1;
          this.changed();
          return;
        }
        this.handlers.onEscape();
        return;
      case 'enter':
        if (paletteOpen) {
          this.applyPick(picks[Math.min(this.pickCursor, picks.length - 1)], true);
          return;
        }
        this.submit();
        return;
      case 'tab':
        if (paletteOpen) {
          this.applyPick(picks[Math.min(this.pickCursor, picks.length - 1)], false);
          return;
        }
        return;
      case 'up':
        if (paletteOpen) {
          this.pickCursor = (this.pickCursor - 1 + picks.length) % picks.length;
          this.changed();
          return;
        }
        if (cursorRow(this.state) > 0) {
          this.state = moveVertical(this.state, -1);
          this.changed();
          return;
        }
        this.historyPrev();
        return;
      case 'down':
        if (paletteOpen) {
          this.pickCursor = (this.pickCursor + 1) % picks.length;
          this.changed();
          return;
        }
        if (cursorRow(this.state) < rowCount(this.state) - 1) {
          this.state = moveVertical(this.state, 1);
          this.changed();
          return;
        }
        this.historyNext();
        return;
      case 'left':
        this.state = ev.word ? moveWordLeft(this.state) : moveLeft(this.state);
        this.changed();
        return;
      case 'right':
        this.state = ev.word ? moveWordRight(this.state) : moveRight(this.state);
        this.changed();
        return;
      case 'home':
        this.state = moveHome(this.state);
        this.changed();
        return;
      case 'end':
        this.state = moveEnd(this.state);
        this.changed();
        return;
      case 'backspace':
        this.state = backspace(this.state);
        this.afterEdit();
        return;
      case 'delete':
        this.state = deleteForward(this.state);
        this.afterEdit();
        return;
      case 'paste':
        this.state = insert(this.state, ev.text);
        this.afterEdit();
        return;
      case 'char':
        this.state = insert(this.state, ev.text);
        this.afterEdit();
        return;
      default:
        return;
    }
  }

  private handleCtrl(letter: string): void {
    switch (letter) {
      case 'c':
        // 有草稿时 Ctrl+C 先清空当前输入（与主流 CLI 一致），空输入才向上传递取消/退出
        if (this.state.text) {
          this.state = EMPTY;
          this.historyIdx = -1;
          this.paletteOff = false;
          this.changed();
          return;
        }
        this.handlers.onCancel();
        return;
      case 'd':
        if (!this.state.text) {
          this.handlers.onExit();
          return;
        }
        this.state = deleteForward(this.state);
        this.afterEdit();
        return;
      case 'a':
        this.state = moveHome(this.state);
        this.changed();
        return;
      case 'e':
        this.state = moveEnd(this.state);
        this.changed();
        return;
      case 'b':
        this.state = moveLeft(this.state);
        this.changed();
        return;
      case 'f':
        this.state = moveRight(this.state);
        this.changed();
        return;
      case 'k':
        this.state = killToEnd(this.state);
        this.afterEdit();
        return;
      case 'u':
        this.state = killToStart(this.state);
        this.afterEdit();
        return;
      case 'w':
        this.state = killWordBefore(this.state);
        this.afterEdit();
        return;
      case 'l':
        this.handlers.onClearScreen();
        return;
      case 'j':
        // Ctrl+J / Shift+Enter：插入换行，多行输入的主路径
        this.state = insert(this.state, '\n');
        this.afterEdit();
        return;
      case 'h':
        this.state = backspace(this.state);
        this.afterEdit();
        return;
      default:
        return;
    }
  }

  private handleAlt(letter: string): void {
    switch (letter) {
      case 'b':
        this.state = moveWordLeft(this.state);
        this.changed();
        return;
      case 'f':
        this.state = moveWordRight(this.state);
        this.changed();
        return;
      case 'backspace':
        this.state = killWordBefore(this.state);
        this.afterEdit();
        return;
      case 'd':
        this.state = killWordAfter(this.state);
        this.afterEdit();
        return;
      case '\r':
      case 'enter':
        this.state = insert(this.state, '\n');
        this.afterEdit();
        return;
      default:
        return;
    }
  }

  private submit(): void {
    const raw = this.state.text;
    const trimmedTail = raw.replace(/[ \t]+$/, '');
    // 行尾反斜杠 / 未闭合围栏：插入换行继续输入
    if (trimmedTail.endsWith('\\')) {
      this.state = setText(trimmedTail.slice(0, -1) + '\n');
      this.changed();
      return;
    }
    if (fenceOpen(raw)) {
      this.state = insert(this.state, '\n');
      this.changed();
      return;
    }
    const text = raw.trim();
    this.reset();
    if (!text) {
      this.changed();
      return;
    }
    this.pushHistory(text);
    this.changed();
    this.handlers.onSubmit(text);
  }

  private applyPick(pick: SlashPick | undefined, submit: boolean): void {
    if (!pick) return;
    if (submit && pick.submit) {
      this.state = setText(pick.value);
      this.submit();
      return;
    }
    this.state = setText(pick.value);
    this.pickCursor = 0;
    this.changed();
  }

  private pushHistory(text: string): void {
    if (this.history[this.history.length - 1] !== text) {
      this.history.push(text);
      while (this.history.length > this.historyMax) this.history.shift();
      this.onHistoryCommit?.(text);
    }
    this.historyIdx = -1;
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.historyIdx === -1) this.historyDraft = this.state.text;
    const next = Math.min(this.historyIdx + 1, this.history.length - 1);
    this.historyIdx = next;
    this.state = setText(this.history[this.history.length - 1 - next] ?? '');
    this.changed();
  }

  private historyNext(): void {
    if (this.historyIdx === -1) return;
    const next = this.historyIdx - 1;
    this.historyIdx = next;
    this.state = setText(next < 0 ? this.historyDraft : this.history[this.history.length - 1 - next] ?? '');
    this.changed();
  }

  private afterEdit(): void {
    this.historyIdx = -1;
    this.pickCursor = 0;
    this.paletteOff = false;
    this.changed();
  }

  private changed(): void {
    this.handlers.onChange?.();
  }

  /**
   * 生成受高度/宽度约束的视图：
   * - 纵向按 maxRows 以光标为中心开窗
   * - 横向对每行裁剪出包含光标的可见片段
   * 保证渲染行数可精确预测，Ink 的 live 区高度才不会越界触发全屏重绘。
   */
  view(opts: { columns: number; maxRows: number; paletteRows: number }): InputView {
    const picks = this.picks();
    const paletteOpen = picks.length > 0;
    const pickCursor = paletteOpen ? Math.min(this.pickCursor, picks.length - 1) : 0;
    const { slice, offset } = paletteWindow(picks, pickCursor, Math.max(1, opts.paletteRows));

    const lines = this.state.text.split('\n');
    const curRow = cursorRow(this.state);
    const curCol = this.state.cursor - lineStart(this.state.text, this.state.cursor);

    const maxRows = Math.max(1, opts.maxRows);
    let start = 0;
    if (lines.length > maxRows) {
      start = Math.min(Math.max(0, curRow - Math.floor(maxRows / 2)), lines.length - maxRows);
    }
    const visible = lines.slice(start, start + maxRows);

    // 内宽：左右边框 2 + 左右 padding 2 + 提示符 2
    const inner = Math.max(8, opts.columns - 6);
    const rows: InputRow[] = visible.map((text, i) => {
      const isCursorRow = start + i === curRow;
      if (text.length <= inner) {
        return isCursorRow ? { text, cursorAt: curCol } : { text };
      }
      let from = 0;
      if (isCursorRow && curCol > inner) from = curCol - Math.floor(inner / 2);
      from = Math.min(from, Math.max(0, text.length - inner));
      const sliceText = text.slice(from, from + inner);
      const row: InputRow = { text: sliceText };
      if (from > 0) row.clipLeft = true;
      if (from + inner < text.length) row.clipRight = true;
      if (isCursorRow) row.cursorAt = Math.max(0, curCol - from);
      return row;
    });

    const paletteHeight = paletteOpen ? slice.length + 3 + (picks.length > slice.length ? 1 : 0) : 0;
    return {
      rows,
      placeholder: this.state.text.length === 0,
      continuation: this.continuation,
      palette: paletteOpen ? { items: slice, cursor: pickCursor - offset, total: picks.length } : null,
      height: rows.length + 2 + paletteHeight,
    };
  }
}
