/**
 * 终端输入字节流 → 按键事件解码。
 *
 * 独立于 Ink 的 useInput：后者把一次 data 突发整体当成单个按键，
 * 粘贴、连击、CSI 序列与普通字符粘在同一 chunk 时会被整段丢弃或误判。
 * 这里按 CSI / SS3 / bracketed paste / 控制字符 / 可打印串逐段切分。
 */

export type KeyEvent =
  | { kind: 'char'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'enter' }
  | { kind: 'tab'; shift: boolean }
  | { kind: 'escape' }
  | { kind: 'backspace' }
  | { kind: 'delete' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'left'; word: boolean }
  | { kind: 'right'; word: boolean }
  | { kind: 'home' }
  | { kind: 'end' }
  | { kind: 'ctrl'; letter: string }
  | { kind: 'alt'; letter: string }
  | { kind: 'unknown'; raw: string };

/** 开启/关闭 bracketed paste：终端把粘贴内容包在 ESC[200~ … ESC[201~ 里。 */
export const BRACKETED_PASTE_ON = '\x1b[?2004h';
export const BRACKETED_PASTE_OFF = '\x1b[?2004l';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** 粘贴内容里的 CR / CRLF 统一成 LF，避免裸 CR 进入消息体。 */
export function normalizePasted(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 增量解码器：跨 chunk 保留未完成的 paste 块与半个 escape 序列。
 * 终端会把一次粘贴拆成多个 data 事件，无状态解码无法拼回。
 */
export class KeyDecoder {
  private pending = '';
  private pasteBuf: string | null = null;

  push(chunk: string): KeyEvent[] {
    const events: KeyEvent[] = [];
    let buf = this.pending + chunk;
    this.pending = '';

    while (buf.length > 0) {
      if (this.pasteBuf !== null) {
        const end = buf.indexOf(PASTE_END);
        if (end === -1) {
          // 整块都还在 paste 中；尾部可能截断了 PASTE_END，留待下一 chunk
          const keep = Math.max(0, buf.length - (PASTE_END.length - 1));
          this.pasteBuf += buf.slice(0, keep);
          this.pending = buf.slice(keep);
          return events;
        }
        this.pasteBuf += buf.slice(0, end);
        events.push({ kind: 'paste', text: normalizePasted(this.pasteBuf) });
        this.pasteBuf = null;
        buf = buf.slice(end + PASTE_END.length);
        continue;
      }

      if (buf.startsWith(PASTE_START)) {
        this.pasteBuf = '';
        buf = buf.slice(PASTE_START.length);
        continue;
      }

      const ch = buf[0];

      if (ch === '\x1b') {
        const taken = this.takeEscape(buf);
        if (taken === null) {
          // 序列不完整：等下一 chunk 再解析（单独的 ESC 键在 flush 时才落地）
          this.pending = buf;
          return events;
        }
        if (taken.event) events.push(taken.event);
        buf = buf.slice(taken.length);
        continue;
      }

      // 原始模式下 Enter 固定发 CR；LF 只可能来自 Ctrl+J 或无 bracketed paste 的多行粘贴，
      // 两者都应插入换行而不是提交，故映射成 ctrl+j。
      if (ch === '\r') {
        events.push({ kind: 'enter' });
        buf = buf.slice(1);
        continue;
      }
      if (ch === '\n') {
        events.push({ kind: 'ctrl', letter: 'j' });
        buf = buf.slice(1);
        continue;
      }
      if (ch === '\t') {
        events.push({ kind: 'tab', shift: false });
        buf = buf.slice(1);
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        events.push({ kind: 'backspace' });
        buf = buf.slice(1);
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        events.push({ kind: 'ctrl', letter: String.fromCharCode(code + 96) });
        buf = buf.slice(1);
        continue;
      }

      // 可打印串：一次吃到下一个控制字符 / ESC 为止
      let end = 1;
      while (end < buf.length) {
        const c = buf.charCodeAt(end);
        if (c < 0x20 || c === 0x7f) break;
        end += 1;
      }
      events.push({ kind: 'char', text: buf.slice(0, end) });
      buf = buf.slice(end);
    }

    return events;
  }

  /** 是否还有滞留的不完整序列（单独的 ESC 或未闭合 paste）。调用方据此安排超时 flush。 */
  get hasPending(): boolean {
    return this.pending.length > 0 || this.pasteBuf !== null;
  }

  /** 把滞留的不完整序列按字面意义收尾（ESC 单键、未闭合 paste）。 */
  flush(): KeyEvent[] {
    const events: KeyEvent[] = [];
    if (this.pasteBuf !== null) {
      // pending 里可能是「疑似 PASTE_END 前缀」的正文尾巴，属于粘贴内容而不是独立按键
      events.push({ kind: 'paste', text: normalizePasted(this.pasteBuf + this.pending) });
      this.pasteBuf = null;
      this.pending = '';
      return events;
    }
    if (this.pending === '\x1b') events.push({ kind: 'escape' });
    else if (this.pending) events.push({ kind: 'unknown', raw: this.pending });
    this.pending = '';
    return events;
  }

  private takeEscape(buf: string): { event: KeyEvent | null; length: number } | null {
    if (buf.length === 1) return null;
    const second = buf[1];

    if (second === '[') {
      const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(buf);
      if (!m) return buf.length > 12 ? { event: { kind: 'unknown', raw: buf.slice(0, 2) }, length: 2 } : null;
      const params = m[1];
      const final = m[2];
      const length = m[0].length;
      // xterm modifier: 参数第二位 2=Shift 3=Alt 5=Ctrl（Ctrl/Alt+方向键 = 按词移动）
      const mod = Number(params.split(';')[1] ?? '0');
      const word = mod === 5 || mod === 3;
      switch (final) {
        case 'A': return { event: { kind: 'up' }, length };
        case 'B': return { event: { kind: 'down' }, length };
        case 'C': return { event: { kind: 'right', word }, length };
        case 'D': return { event: { kind: 'left', word }, length };
        case 'H': return { event: { kind: 'home' }, length };
        case 'F': return { event: { kind: 'end' }, length };
        case 'Z': return { event: { kind: 'tab', shift: true }, length };
        case '~':
          if (params.startsWith('1') || params.startsWith('7')) return { event: { kind: 'home' }, length };
          if (params.startsWith('4') || params.startsWith('8')) return { event: { kind: 'end' }, length };
          if (params.startsWith('3')) return { event: { kind: 'delete' }, length };
          return { event: null, length };
        default:
          return { event: null, length };
      }
    }

    if (second === 'O') {
      if (buf.length < 3) return null;
      const final = buf[2];
      const map: Record<string, KeyEvent> = {
        A: { kind: 'up' },
        B: { kind: 'down' },
        C: { kind: 'right', word: false },
        D: { kind: 'left', word: false },
        H: { kind: 'home' },
        F: { kind: 'end' },
      };
      return { event: map[final] ?? null, length: 3 };
    }

    if (second === '\x1b') {
      // xterm 的 metaSendsEscape：Alt+方向键发 ESC ESC [ D，需要还原成「按词移动」
      if (buf.length >= 3 && (buf[2] === '[' || buf[2] === 'O')) {
        const inner = this.takeEscape(buf.slice(1));
        if (inner === null) return null;
        const ev = inner.event;
        if (ev && (ev.kind === 'left' || ev.kind === 'right')) {
          return { event: { kind: ev.kind, word: true }, length: inner.length + 1 };
        }
        return { event: ev, length: inner.length + 1 };
      }
      return { event: { kind: 'escape' }, length: 2 };
    }

    // ESC + 字符 = Alt 组合（Alt+B/F 按词移动，Alt+Backspace 删词）
    if (second === '\x7f' || second === '\b') return { event: { kind: 'alt', letter: 'backspace' }, length: 2 };
    return { event: { kind: 'alt', letter: second.toLowerCase() }, length: 2 };
  }
}
