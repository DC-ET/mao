import readline from 'node:readline';
import { parseKeys, type ParsedKey } from './keys';
import { PromptQueue } from './prompt-queue';
import type { Composer } from './composer';

export interface ModalCtl {
  onKey(handler: (key: ParsedKey) => void): void;
  write: (s: string) => void;
}

export interface InputControllerOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WritableStream;
  stderr?: { write: (s: string) => void };
  onLine: (line: string) => void | Promise<void>;
  onCancel: () => void;
  onExit: () => void;
  onDraftChange?: (draft: string) => void;
  completer?: (line: string) => [string[], string];
  composer?: Composer | null;
}

type Mode = 'line' | 'running' | 'modal';

export class InputController {
  readonly queue = new PromptQueue();
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: { write: (s: string) => void };
  private readonly composer: Composer | null;
  private rl: readline.Interface | null = null;
  private mode: Mode = 'line';
  private closing = false;
  private draft = '';
  private useComposer = false;
  private rawHandler: ((buf: Buffer) => void) | null = null;
  private modalHandler: ((key: ParsedKey) => void) | null = null;
  private wasRaw = false;
  private history: string[] = [];
  private historyIdx = -1;
  private historyDraft = '';

  constructor(private readonly opts: InputControllerOptions) {
    this.stdin = opts.stdin ?? (process.stdin as NodeJS.ReadStream);
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
    this.composer = opts.composer ?? null;
  }

  /** composer 接管输入时提交不会经过 readline 回显，需要 renderer.noteUser。 */
  get echoesSubmit(): boolean {
    return !this.useComposer;
  }

  start(): void {
    if (this.composer?.tryStart()) {
      this.useComposer = true;
      this.attachRaw();
      return;
    }
    this.rl = readline.createInterface({
      input: this.stdin,
      output: this.stdout,
      terminal: true,
      completer: this.opts.completer
        ? (line: string) => this.opts.completer!(line)
        : undefined,
    });
    this.rl.on('line', (line) => {
      if (this.mode !== 'line' || this.closing) return;
      void this.opts.onLine(line);
    });
    this.rl.on('SIGINT', () => {
      if (this.closing) return;
      if (this.mode === 'line') this.opts.onCancel();
    });
    this.rl.on('close', () => {
      if (!this.closing) this.opts.onExit();
    });
  }

  prompt(prefix = '❯ '): void {
    if (this.closing || this.mode !== 'line') return;
    if (this.useComposer) {
      this.composer?.setIdle(this.draft, { continuation: prefix.startsWith('…') });
      return;
    }
    if (!this.rl) return;
    this.rl.setPrompt(prefix);
    this.rl.prompt();
  }

  setContinuationPrompt(): void {
    this.prompt('… ');
  }

  setRunning(running: boolean, opts?: { prompt?: boolean }): void {
    if (this.closing) return;
    if (running) this.enterRunning();
    else this.enterLine(opts?.prompt === true);
  }

  async runModal<T>(fn: (ctl: ModalCtl) => Promise<T>): Promise<T> {
    const prev = this.mode === 'modal' ? 'running' : this.mode;
    this.enterModal();
    try {
      return await fn({
        onKey: (handler) => {
          this.modalHandler = handler;
        },
        write: (s) => this.stderr.write(s),
      });
    } finally {
      this.modalHandler = null;
      if (prev === 'running') this.enterRunning();
      else this.enterLine(false);
    }
  }

  getDraft(): string {
    return this.draft;
  }

  clearDraft(): void {
    this.draft = '';
    this.opts.onDraftChange?.('');
    if (this.useComposer && this.mode === 'line') this.composer?.setIdle('');
    else if (this.useComposer) this.composer?.setDraft('');
  }

  async stop(): Promise<void> {
    this.closing = true;
    this.detachRaw();
    this.composer?.stop();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private enterRunning(): void {
    this.mode = 'running';
    this.draft = '';
    this.historyIdx = -1;
    if (this.useComposer) {
      this.composer?.setRunning('思考中…', '');
      return;
    }
    this.rl?.pause();
    this.attachRaw();
  }

  private enterModal(): void {
    this.mode = 'modal';
    if (!this.useComposer) {
      this.rl?.pause();
      this.attachRaw();
    }
  }

  private enterLine(doPrompt: boolean): void {
    this.mode = 'line';
    this.draft = '';
    this.historyIdx = -1;
    this.opts.onDraftChange?.('');
    if (this.useComposer) {
      if (doPrompt) this.prompt();
      else this.composer?.setIdle('');
      return;
    }
    this.detachRaw();
    this.rl?.resume();
    if (doPrompt) this.prompt();
  }

  private attachRaw(): void {
    if (this.rawHandler) return;
    try {
      this.wasRaw = Boolean(this.stdin.isRaw);
    } catch {
      this.wasRaw = false;
    }
    this.enableRawMode();
    this.stdin.resume();
    this.rawHandler = (buf) => this.onRaw(buf);
    this.stdin.on('data', this.rawHandler);
    process.nextTick(() => {
      if (this.useComposer || this.mode === 'running' || this.mode === 'modal') this.enableRawMode();
    });
  }

  private enableRawMode(): void {
    try {
      if (this.stdin.isTTY) this.stdin.setRawMode(true);
    } catch {
      // 某些 SSH/tmux 会失败，退化为只处理 readline
    }
  }

  private detachRaw(): void {
    if (!this.rawHandler) return;
    this.stdin.off('data', this.rawHandler);
    this.rawHandler = null;
    try {
      if (this.stdin.isTTY) this.stdin.setRawMode(this.wasRaw);
    } catch {
      // ignore
    }
  }

  private onRaw(buf: Buffer): void {
    for (const key of parseKeys(buf)) {
      if (this.mode === 'modal') {
        this.modalHandler?.(key);
        continue;
      }
      if (this.mode === 'line' && this.useComposer) {
        this.onComposerKey(key);
        continue;
      }
      if (this.mode !== 'running') return;
      if (key.name === 'ctrl-c') {
        this.clearDraft();
        this.opts.onCancel();
        return;
      }
      if (key.name === 'ctrl-d') continue;
      if (key.name === 'tab') {
        this.applyCompletion();
        continue;
      }
      if (key.name === 'enter') {
        const line = this.draft;
        this.clearDraft();
        if (line.trim()) void this.opts.onLine(line);
        continue;
      }
      if (key.name === 'backspace') {
        this.draft = this.draft.slice(0, -1);
        this.opts.onDraftChange?.(this.draft);
        continue;
      }
      if (key.name === 'char' || key.name === 'digit' || key.name === 'space') {
        this.draft += key.raw;
        this.opts.onDraftChange?.(this.draft);
      }
    }
  }

  private onComposerKey(key: ParsedKey): void {
    if (key.name === 'ctrl-c') {
      this.clearDraft();
      this.opts.onCancel();
      this.prompt();
      return;
    }
    if (key.name === 'ctrl-d') {
      if (!this.draft) this.opts.onExit();
      return;
    }
    if (key.name === 'up') {
      this.historyMove(1);
      return;
    }
    if (key.name === 'down') {
      this.historyMove(-1);
      return;
    }
    if (key.name === 'tab') {
      this.applyCompletion();
      this.composer?.setIdle(this.draft);
      return;
    }
    if (key.name === 'enter') {
      const line = this.draft;
      this.clearDraft();
      if (line.trim()) {
        this.history.push(line);
        if (this.history.length > 50) this.history.shift();
      }
      this.historyIdx = -1;
      this.composer?.setIdle('');
      if (line.trim()) void this.opts.onLine(line);
      else this.prompt();
      return;
    }
    if (key.name === 'backspace') {
      this.draft = this.draft.slice(0, -1);
      this.historyIdx = -1;
      this.composer?.setIdle(this.draft);
      return;
    }
    if (key.name === 'char' || key.name === 'digit' || key.name === 'space') {
      this.draft += key.raw;
      this.historyIdx = -1;
      this.composer?.setIdle(this.draft);
    }
  }

  private historyMove(dir: number): void {
    if (this.history.length === 0) return;
    if (this.historyIdx === -1) this.historyDraft = this.draft;
    const next = this.historyIdx + dir;
    if (next < -1) return;
    if (next >= this.history.length) return;
    this.historyIdx = next;
    this.draft = next === -1 ? this.historyDraft : this.history[this.history.length - 1 - next] ?? '';
    this.composer?.setIdle(this.draft);
  }

  private applyCompletion(): void {
    if (!this.opts.completer || !this.draft.startsWith('/')) return;
    const [hits] = this.opts.completer(this.draft);
    if (hits.length === 1) {
      const inner = this.draft.slice(1);
      const space = inner.indexOf(' ');
      this.draft = space === -1 ? hits[0] : `/${inner.slice(0, space + 1)}${hits[0]}`;
      this.opts.onDraftChange?.(this.draft);
      return;
    }
    if (hits.length > 1) {
      this.stderr.write(`\n${hits.join('  ')}\n`);
    }
  }
}
