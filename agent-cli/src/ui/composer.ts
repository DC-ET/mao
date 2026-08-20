import { boxRow, hLine, pickBox, type BoxGlyphs } from './box';
import { truncateToWidth } from './width';

export interface ComposerOptions {
  write: (s: string) => void;
  rows: () => number;
  columns: () => number;
  dim: (s: string) => string;
  cyan: (s: string) => string;
  frames: string[];
  ascii?: boolean;
  getMeta: () => string;
  placeholder?: string;
}

const MIN_ROWS = 12;
export const COMPOSER_HEIGHT = 4;

/**
 * 备用屏 + 顶栏固定 + 底栏输入框。对话在中间滚动区，不再和 bash 提示符叠在一起。
 */
export class Composer {
  private glyphs: BoxGlyphs;
  private mode: 'idle' | 'running' = 'idle';
  private draft = '';
  private status = '';
  private continuation = false;
  private frame = 0;
  private startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private headerRows = 0;
  private onExit: (() => void) | null = null;
  private onResize: (() => void) | null = null;

  constructor(private readonly opts: ComposerOptions) {
    this.glyphs = pickBox(Boolean(opts.ascii));
  }

  isActive(): boolean {
    return this.active;
  }

  tryStart(): boolean {
    if ((this.opts.rows() || 0) < MIN_ROWS) return false;
    this.opts.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
    this.active = true;
    this.mode = 'idle';
    this.draft = '';
    this.status = '';
    this.headerRows = 0;
    this.hookLifecycle();
    this.ensureTimer();
    return true;
  }

  /** 顶栏写完后调用：把滚动区限制在 header 与输入框之间。 */
  sealHeader(rows: number): void {
    this.headerRows = Math.max(0, rows);
    if (!this.active) return;
    this.applyScrollRegion();
    const top = this.headerRows + 1;
    this.opts.write(`\x1b[${top};1H`);
  }

  wipe(): void {
    if (!this.active) return;
    this.headerRows = 0;
    this.opts.write('\x1b[2J\x1b[H');
  }

  stop(): void {
    if (!this.active) return;
    this.unhookLifecycle();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.opts.write('\x1b[r\x1b[?25h\x1b[?1049l');
    this.active = false;
  }

  setIdle(draft: string, opts?: { continuation?: boolean }): void {
    this.mode = 'idle';
    this.draft = draft;
    this.continuation = Boolean(opts?.continuation);
    this.status = '';
    if (this.active) this.draw();
  }

  setRunning(status: string, draft?: string): void {
    if (this.mode !== 'running') this.startedAt = Date.now();
    this.mode = 'running';
    this.status = status;
    if (draft !== undefined) this.draft = draft;
    if (this.active) this.draw();
  }

  setDraft(draft: string): void {
    this.draft = draft;
    if (this.active) this.draw();
  }

  refresh(): void {
    if (this.active) this.draw();
  }

  relayout(): void {
    if (!this.active) return;
    this.applyScrollRegion();
    this.draw();
  }

  /** 测试 / 调试：当前 4 行画面（不含 CSI）。 */
  renderLines(): string[] {
    const cols = Math.max(20, this.opts.columns() || 80);
    const g = this.glyphs;
    const top = hLine(g.tl, g.tr, g.h, cols);
    const bot = hLine(g.bl, g.br, g.h, cols);
    const inner = this.mode === 'idle' ? this.idleInner() : this.runningInner();
    const hint = this.opts.dim(` ${truncateToWidth(this.hintText(), cols - 1)}`);
    return [this.opts.dim(top), boxRow(inner, cols, g.v), this.opts.dim(bot), hint];
  }

  private idleInner(): string {
    const mark = this.continuation ? '…' : '→';
    if (this.draft) return `${this.opts.cyan(`${mark} `)}${this.draft}`;
    const ph = this.opts.placeholder ?? '继续对话，或输入 /help';
    return `${this.opts.cyan(`${mark} `)}${this.opts.dim(ph)}`;
  }

  private runningInner(): string {
    const spin = this.opts.frames[this.frame] ?? '';
    const sec = Math.round((Date.now() - this.startedAt) / 1000);
    const status = this.status || '思考中…';
    const draft = this.draft ? `    ${this.opts.dim(`→ ${this.draft}`)}` : '';
    return `${spin}  ${status}  ${this.opts.dim(`${sec}s`)}${draft}`;
  }

  private hintText(): string {
    const meta = this.opts.getMeta().trim();
    if (this.mode === 'running') {
      const extra = this.draft ? '回车排队 · Ctrl+C 取消' : 'Ctrl+C 取消';
      return meta ? `${meta}  ·  ${extra}` : extra;
    }
    return meta || 'Enter 发送  ·  Ctrl+C 退出';
  }

  private applyScrollRegion(): void {
    const rows = this.opts.rows() || 0;
    if (rows < MIN_ROWS) return;
    const top = Math.max(1, this.headerRows + 1);
    const bottom = rows - COMPOSER_HEIGHT;
    if (bottom <= top) return;
    this.opts.write(`\x1b[${top};${bottom}r`);
  }

  private draw(): void {
    const rows = this.opts.rows() || 0;
    if (!this.active || rows < MIN_ROWS) return;
    const lines = this.renderLines();
    const start = rows - COMPOSER_HEIGHT + 1;
    let payload = '\x1b7';
    for (let i = 0; i < lines.length; i++) {
      payload += `\x1b[${start + i};1H\x1b[2K${lines[i]}`;
    }
    payload += '\x1b8';
    this.opts.write(payload);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % Math.max(1, this.opts.frames.length);
      if (this.active && this.mode === 'running') this.draw();
    }, 80);
  }

  private hookLifecycle(): void {
    if (this.onExit) return;
    this.onExit = () => this.stop();
    process.on('exit', this.onExit);
    const stdout = process.stdout as NodeJS.WriteStream;
    if (typeof stdout.on === 'function') {
      this.onResize = () => this.relayout();
      stdout.on('resize', this.onResize);
    }
  }

  private unhookLifecycle(): void {
    if (this.onExit) {
      process.off('exit', this.onExit);
      this.onExit = null;
    }
    if (this.onResize) {
      process.stdout.off('resize', this.onResize);
      this.onResize = null;
    }
  }
}
