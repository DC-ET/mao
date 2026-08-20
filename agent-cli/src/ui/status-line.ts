import { displayWidth, truncateOneLine, truncateToWidth } from './width';

export interface StatusLineOptions {
  enabled: boolean;
  stderr: { write: (s: string) => void };
  clearLine: string;
  dim: (s: string) => string;
  frames: string[];
  getMeta: () => string;
  /** 终端行数；>0 时半行流式把状态钉在底行，避免 \r 擦掉正文。 */
  rows?: () => number;
  /** 终端列宽；状态行必须单行，否则 \r 清不掉换行残留。 */
  columns?: () => number;
}

type Mode = 'off' | 'inline' | 'pinned';

/**
 * 状态行只能出现在「空行行首」（inline）或「屏幕底行」（pinned）。
 * 禁止：在正文行上 \r、以及用 \n 把旧状态推进 scrollback。
 */
export class StatusLine {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private status = '';
  private draft = '';
  private startedAt = Date.now();
  private mode: Mode = 'off';

  constructor(private readonly opts: StatusLineOptions) {}

  startRound(): void {
    this.hide();
    this.startedAt = Date.now();
    this.draft = '';
    this.status = '';
  }

  hasText(): boolean {
    return Boolean(this.status);
  }

  setStatus(text: string, atLineStart: boolean): void {
    this.status = text;
    if (!this.opts.enabled) return;
    this.ensureTimer();
    this.render(atLineStart);
  }

  setDraft(draft: string, atLineStart: boolean): void {
    this.draft = draft;
    if (!this.opts.enabled || !this.status) return;
    this.render(atLineStart);
  }

  nudge(atLineStart: boolean): void {
    if (!this.opts.enabled || !this.status) return;
    this.render(atLineStart);
  }

  beforeWrite(): void {
    this.hide();
  }

  afterWrite(atLineStart: boolean): void {
    if (!this.opts.enabled || !this.status) return;
    this.render(atLineStart);
  }

  /** 清掉画面上的状态，保留文案（announce 之后还能画回来）。 */
  hide(): void {
    if (this.mode === 'pinned') {
      const rows = this.opts.rows?.() ?? 0;
      if (rows > 1) {
        this.opts.stderr.write(`\x1b[s\x1b[${rows};1H${this.opts.clearLine || '\x1b[2K'}\x1b[u`);
      }
    } else if (this.mode === 'inline') {
      this.opts.stderr.write(this.opts.clearLine || '\r\x1b[K');
    }
    this.mode = 'off';
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.hide();
    this.status = '';
    this.draft = '';
  }

  render(atLineStart: boolean): void {
    if (!this.opts.enabled || !this.status) {
      this.hide();
      return;
    }
    if (!atLineStart) {
      if (this.canPin()) {
        this.showPinned();
        return;
      }
      this.hide();
      return;
    }
    this.showInline();
  }

  private canPin(): boolean {
    return (this.opts.rows?.() ?? 0) > 1;
  }

  private showPinned(): void {
    const rows = this.opts.rows?.() ?? 0;
    if (rows < 2) return;
    if (this.mode === 'inline') {
      this.opts.stderr.write(this.opts.clearLine || '\r\x1b[K');
    }
    this.opts.stderr.write(`\x1b[s\x1b[${rows};1H${this.opts.clearLine || '\x1b[2K'}${this.opts.dim(this.formatLine())}\x1b[u`);
    this.mode = 'pinned';
  }

  private showInline(): void {
    if (this.mode === 'pinned') {
      const rows = this.opts.rows?.() ?? 0;
      if (rows > 1) {
        this.opts.stderr.write(`\x1b[s\x1b[${rows};1H${this.opts.clearLine || '\x1b[2K'}\x1b[u`);
      }
    }
    this.opts.stderr.write((this.opts.clearLine || '\r\x1b[K') + this.opts.dim(this.formatLine()));
    this.mode = 'inline';
  }

  private ensureTimer(): void {
    if (this.timer || !this.opts.enabled) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % this.opts.frames.length;
      if (this.mode === 'off' || !this.status) return;
      if (this.mode === 'pinned') this.showPinned();
      else this.showInline();
    }, 80);
  }

  private formatLine(): string {
    const sec = Math.round((Date.now() - this.startedAt) / 1000);
    const spin = `${this.opts.frames[this.frame]} `;
    const cols = this.opts.columns?.() ?? 0;
    const budget = cols > 8 ? cols - 1 : 0;
    const head = `${spin}${this.opts.getMeta()}  ${sec}s  ${this.status}`;
    if (!this.draft) return budget ? truncateToWidth(head, budget) : head;
    const draft = `  | 草稿: ${truncateOneLine(this.draft, 24)}`;
    if (!budget) return head + draft;
    const room = budget - displayWidth(head);
    if (room < 8) return truncateToWidth(head, budget);
    return head + truncateToWidth(draft, room);
  }
}
