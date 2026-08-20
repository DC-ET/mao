export function shouldUseColor(opts: { colorFlag?: boolean; printMode: boolean; stdoutIsTty: boolean }): boolean {
  if (opts.colorFlag === false) return false;
  if (opts.colorFlag === true) return true;
  if (process.env.NO_COLOR) return false;
  if (opts.printMode) return false;
  return opts.stdoutIsTty;
}

export function createAnsi(enabled: boolean) {
  const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    enabled,
    bold: wrap('1'),
    dim: wrap('2'),
    italic: wrap('3'),
    cyan: wrap('36'),
    green: wrap('32'),
    yellow: wrap('33'),
    red: wrap('31'),
    magenta: wrap('35'),
    gray: wrap('90'),
    /** 用户消息整行底：接近 Cursor Agent 的深灰块。 */
    bgBlock: (s: string) => (enabled ? `\x1b[48;5;236m\x1b[37m${s}\x1b[0m` : s),
    clearLine: enabled ? '\r\x1b[K' : '',
  };
}

export type Ansi = ReturnType<typeof createAnsi>;

/** 轻量 Markdown → ANSI：标题 / 粗体 / 行内代码 / 列表。不做语法高亮。 */
export function renderMarkdownLite(text: string, ansi: Ansi): string {
  if (!ansi.enabled) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      out.push(ansi.dim(line));
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let rendered = line.replace(/^#{1,6}\s+(.*)$/, (_m, t) => ansi.bold(String(t)));
    rendered = rendered.replace(/\*\*(.+?)\*\*/g, (_m, t) => ansi.bold(String(t)));
    rendered = rendered.replace(/`([^`]+)`/g, (_m, t) => ansi.cyan(String(t)));
    rendered = rendered.replace(/^(\s*[-*]\s+)/, (m) => ansi.dim(m));
    out.push(rendered);
  }
  return out.join('\n');
}

export function truncate(text: string, maxChars = 2000, maxLines = 20): string {
  const lines = text.split('\n');
  let sliced = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + '\n…' : text;
  if (sliced.length > maxChars) sliced = sliced.slice(0, maxChars) + '…';
  return sliced;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** 按列宽估算占用的可视行数（忽略颜色码）。 */
export function countVisualRows(text: string, columns: number): number {
  if (!text) return 0;
  const cols = Math.max(1, columns);
  const lines = stripAnsi(text).split('\n');
  let rows = 0;
  for (let i = 0; i < lines.length; i++) {
    const isTrailingEmpty = i === lines.length - 1 && lines[i] === '' && text.endsWith('\n');
    if (isTrailingEmpty) continue;
    const width = [...lines[i]].length;
    rows += Math.max(1, Math.ceil(width / cols) || 1);
  }
  return rows;
}

/** 从当前光标位置回到这段文本开头需要上移的行数。 */
export function countRewindRows(text: string, columns: number): number {
  const rows = countVisualRows(text, columns);
  if (!text) return 0;
  if (!text.endsWith('\n')) return Math.max(0, rows - 1);
  return rows;
}
