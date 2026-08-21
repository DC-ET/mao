export interface SlashItem {
  cmd: string;
  hint: string;
  needsArg?: boolean;
}

export const SLASH_ITEMS: SlashItem[] = [
  { cmd: 'help', hint: '查看斜杠命令' },
  { cmd: 'session', hint: '当前会话信息' },
  { cmd: 'model', hint: '切换模型', needsArg: true },
  { cmd: 'todo', hint: '查看 Todo' },
  { cmd: 'context', hint: '上下文占用' },
  { cmd: 'verbose', hint: '展开/折叠工具输出' },
  { cmd: 'queue', hint: '查看或清空队列', needsArg: true },
  { cmd: 'cancel', hint: '取消当前任务' },
  { cmd: 'clear', hint: '清屏' },
  { cmd: 'copy', hint: '复制上一回合回复' },
  { cmd: 'agent', hint: '如何换 Agent' },
  { cmd: 'exit', hint: '退出' },
  { cmd: 'quit', hint: '退出' },
];

export const SLASH_COMMANDS = SLASH_ITEMS.map((i) => i.cmd);

const NEEDS_ARG = new Set(SLASH_ITEMS.filter((i) => i.needsArg).map((i) => i.cmd));

export interface SlashCompleteOptions {
  models?: string[];
}

export interface SlashPick {
  /** 填入输入框的完整文本 */
  value: string;
  label: string;
  hint: string;
  /** true：Enter 后立即执行；false：只填入（还要继续选参数） */
  submit: boolean;
}

/** readline completer：返回 [候选, 被补全的前缀]。 */
export function completeSlash(line: string, opts: SlashCompleteOptions = {}): [string[], string] {
  const picks = slashPalette(line, opts);
  if (!line.startsWith('/')) return [[], line];
  const inner = line.slice(1);
  const space = inner.indexOf(' ');
  if (space === -1) {
    return [picks.map((p) => p.value), line];
  }
  const rest = inner.slice(space + 1);
  const cmd = inner.slice(0, space);
  if (cmd === 'model') return [picks.filter((p) => p.submit).map((p) => p.label), rest];
  if (cmd === 'queue') return [picks.map((p) => p.label.replace(/^\/queue\s+/, '')), rest];
  return [picks.map((p) => p.value), line];
}

/** 输入 `/` 后的快捷选择列表，随前缀过滤。 */
export function slashPalette(line: string, opts: SlashCompleteOptions = {}): SlashPick[] {
  if (!line.startsWith('/')) return [];
  const inner = line.slice(1);
  const space = inner.indexOf(' ');
  if (space === -1) {
    return SLASH_ITEMS.filter((c) => c.cmd.startsWith(inner)).map((c) => ({
      value: `/${c.cmd}${c.needsArg ? ' ' : ''}`,
      label: `/${c.cmd}`,
      hint: c.hint,
      submit: !c.needsArg,
    }));
  }
  const cmd = inner.slice(0, space);
  const rest = inner.slice(space + 1);
  if (cmd === 'model') {
    const names = opts.models ?? [];
    const picks: SlashPick[] = [{
      value: '/model',
      label: '/model',
      hint: '查看当前模型',
      submit: true,
    }];
    for (const n of names) {
      if (!n.startsWith(rest)) continue;
      picks.push({
        value: `/model ${n}`,
        label: n,
        hint: '切换到此模型',
        submit: true,
      });
    }
    // 已开始输入模型名时不再展示「查看当前」
    return rest ? picks.slice(1) : picks;
  }
  if (cmd === 'queue') {
    const sub = [
      { token: '', label: '/queue', hint: '查看队列', value: '/queue', submit: true as const },
      { token: 'clear', label: '/queue clear', hint: '清空队列', value: '/queue clear', submit: true as const },
    ];
    return sub.filter((s) => s.token.startsWith(rest)).map((s) => ({
      value: s.value,
      label: s.label,
      hint: s.hint,
      submit: s.submit,
    }));
  }
  return [];
}

export function paletteWindow<T>(items: T[], cursor: number, max = 8): { slice: T[]; offset: number } {
  if (items.length <= max) return { slice: items, offset: 0 };
  const start = Math.min(Math.max(0, cursor - Math.floor(max / 2)), items.length - max);
  return { slice: items.slice(start, start + max), offset: start };
}
