import readline from 'node:readline';
import { parseKey, type ParsedKey } from './keys';
import { PromptQueue } from './prompt-queue';

export interface ModalCtl {
  onKey(handler: (key: ParsedKey) => void): void;
  write(s: string): void;
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
}

type Mode = 'line' | 'running' | 'modal';

export class InputController {
  readonly queue = new PromptQueue();
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: { write: (s: string) => void };
  private rl: readline.Interface | null = null;
  private mode: Mode = 'line';
  private closing = false;
  private draft = '';
  private rawHandler: ((buf: Buffer) => void) | null = null;
  private modalHandler: ((key: ParsedKey) => void) | null = null;
  private wasRaw = false;

  constructor(private readonly opts: InputControllerOptions) {
    this.stdin = opts.stdin ?? (process.stdin as NodeJS.ReadStream);
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
  }

  start(): void {
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

  prompt(prefix = '› '): void {
    if (this.closing || this.mode !== 'line' || !this.rl) return;
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
  }

  async stop(): Promise<void> {
    this.closing = true;
    this.detachRaw();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private enterRunning(): void {
    this.mode = 'running';
    this.draft = '';
    this.rl?.pause();
    this.attachRaw();
  }

  private enterModal(): void {
    this.mode = 'modal';
    this.rl?.pause();
    this.attachRaw();
  }

  private enterLine(doPrompt: boolean): void {
    this.detachRaw();
    this.mode = 'line';
    this.draft = '';
    this.opts.onDraftChange?.('');
    this.rl?.resume();
    if (doPrompt) this.prompt();
  }

  private attachRaw(): void {
    if (this.rawHandler) return;
    try {
      this.wasRaw = Boolean(this.stdin.isRaw);
      if (this.stdin.isTTY) this.stdin.setRawMode(true);
    } catch {
      // 某些 SSH/tmux 会失败，退化为只处理 readline
      return;
    }
    this.stdin.resume();
    this.rawHandler = (buf) => this.onRaw(buf);
    this.stdin.on('data', this.rawHandler);
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
    const key = parseKey(buf);
    if (this.mode === 'modal') {
      this.modalHandler?.(key);
      return;
    }
    if (this.mode !== 'running') return;
    if (key.name === 'ctrl-c') {
      this.clearDraft();
      this.opts.onCancel();
      return;
    }
    if (key.name === 'ctrl-d') return;
    if (key.name === 'tab') {
      this.applyCompletion();
      return;
    }
    if (key.name === 'enter') {
      const line = this.draft;
      this.clearDraft();
      if (line.trim()) void this.opts.onLine(line);
      return;
    }
    if (key.name === 'backspace') {
      this.draft = this.draft.slice(0, -1);
      this.opts.onDraftChange?.(this.draft);
      return;
    }
    if (key.name === 'char' || key.name === 'digit' || key.name === 'space') {
      this.draft += key.raw;
      this.opts.onDraftChange?.(this.draft);
    }
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
