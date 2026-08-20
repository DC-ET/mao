export function shouldUseColor(opts: { colorFlag?: boolean; printMode: boolean; stdoutIsTty: boolean }): boolean {
  if (process.env.NO_COLOR) return false;
  if (opts.colorFlag === false) return false;
  if (opts.colorFlag === true) return true;
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
