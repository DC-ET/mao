export interface StatusLineOptions {
  enabled: boolean;
  stderr: { write: (s: string) => void };
  clearLine: string;
  dim: (s: string) => string;
  frames: string[];
  getMeta: () => string;
  /** 终端行数；>0 时半行流式把状态钉在底行（方案 B），避免 stderr 换行拆开正文。 */
  rows?: () => number;
}

/**
 * stderr 粘性状态行。正文走 stdout；每次 stdout 写入前清掉本行，
 * 行首时立刻重画。若正文停在半行（流式中途等待），在 stderr 另起一行画状态，避免 \r 擦掉正文。
 */
export class StatusLine {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private visible = false;
  private status = '';
  private draft = '';
  private startedAt = Date.now();
  /** 已在 stderr 另起一行承载状态（正文尚未换行） */
  private parked = false;
  /** 状态钉在屏幕最后一行（方案 B） */
  private pinned = false;

  constructor(private readonly opts: StatusLineOptions) {}

  startRound(): void {
    this.startedAt = Date.now();
    this.parked = false;
    this.pinned = false;
    this.draft = '';
  }

  setStatus(text: string, atLineStart: boolean): void {
    this.status = text;
    if (!this.opts.enabled) return;
    this.ensureTimer();
    this.draw(atLineStart);
  }

  setDraft(draft: string, atLineStart: boolean): void {
    this.draft = draft;
    if (!this.opts.enabled || !this.status) return;
    this.draw(atLineStart);
  }

  /** 不改文案，只重画（例如 context 百分比变了）。 */
  nudge(atLineStart: boolean): void {
    if (!this.opts.enabled || !this.status) return;
    this.draw(atLineStart);
  }

  beforeWrite(): void {
    this.hide();
  }

  afterWrite(atLineStart: boolean): void {
    if (atLineStart) this.parked = false;
    if (!this.opts.enabled || !this.status) return;
    if (atLineStart) this.draw(true);
  }

  hide(): void {
    if (this.pinned) {
      const rows = this.opts.rows?.() ?? 0;
      if (rows > 1) {
        this.opts.stderr.write(`\x1b[s\x1b[${rows};1H${this.opts.clearLine || '\x1b[2K'}\x1b[u`);
      }
      this.pinned = false;
      this.visible = false;
      return;
    }
    if (this.visible) {
      this.opts.stderr.write(this.opts.clearLine || '\r\x1b[K');
    }
    this.visible = false;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.hide();
    this.status = '';
    this.draft = '';
    this.parked = false;
    this.pinned = false;
  }

  private ensureTimer(): void {
    if (this.timer || !this.opts.enabled) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % this.opts.frames.length;
      if (this.visible) this.redrawCurrent();
    }, 80);
  }

  private draw(atLineStart: boolean): void {
    if (!this.opts.enabled) return;
    if (!atLineStart && this.canPin()) {
      this.drawPinned();
      return;
    }
    if (this.pinned) this.hide();
    if (!atLineStart && !this.parked) {
      this.opts.stderr.write('\n');
      this.parked = true;
    }
    this.redrawCurrent();
  }

  private canPin(): boolean {
    return (this.opts.rows?.() ?? 0) > 1;
  }

  private drawPinned(): void {
    const rows = this.opts.rows?.() ?? 0;
    if (rows < 2) return;
    const line = this.formatLine();
    this.opts.stderr.write(`\x1b[s\x1b[${rows};1H${this.opts.clearLine || '\x1b[2K'}${this.opts.dim(line)}\x1b[u`);
    this.pinned = true;
    this.visible = true;
  }

  private redrawCurrent(): void {
    if (this.pinned) {
      this.drawPinned();
      return;
    }
    const line = this.formatLine();
    this.opts.stderr.write((this.opts.clearLine || '\r\x1b[K') + this.opts.dim(line));
    this.visible = true;
  }

  private formatLine(): string {
    const sec = Math.round((Date.now() - this.startedAt) / 1000);
    const spin = `${this.opts.frames[this.frame]} `;
    const draft = this.draft ? `  | 草稿: ${truncateOneLine(this.draft, 40)}` : '';
    return `${spin}${this.opts.getMeta()}  ${sec}s  ${this.status}${draft}`;
  }
}

function truncateOneLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
