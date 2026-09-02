export interface SlashItem {
  cmd: string;
  hint: string;
  needsArg?: boolean;
  /** 帮助里展示的参数占位与说明，缺省用 hint。 */
  usage?: string;
  help?: string;
}

/** 斜杠命令的唯一数据源：补全面板、/help、REPL 分发校验都读这里。 */
export const SLASH_ITEMS: SlashItem[] = [
  { cmd: 'help', hint: '查看斜杠命令' },
  { cmd: 'session', hint: '当前会话信息', help: 'sessionId、Agent、模型、workspace、phase' },
  { cmd: 'model', hint: '切换模型', needsArg: true, usage: '<id|name>', help: '切换当前会话模型（持久写库）' },
  { cmd: 'todo', hint: '查看 Todo' },
  { cmd: 'context', hint: '上下文占用', help: '最近一次 context_window 用量' },
  { cmd: 'verbose', hint: '展开/折叠工具输出' },
  { cmd: 'thinking', hint: '展开/折叠思考内容' },
  { cmd: 'queue', hint: '查看或清空队列', needsArg: true, usage: '[clear]' },
  { cmd: 'cancel', hint: '取消当前任务' },
  { cmd: 'clear', hint: '清屏', help: '清屏与滚动缓冲，不删除服务端历史' },
  { cmd: 'copy', hint: '复制上一回合回复' },
  { cmd: 'agent', hint: '如何换 Agent' },
  { cmd: 'exit', hint: '退出' },
  { cmd: 'quit', hint: '退出' },
];

export const SLASH_COMMANDS = SLASH_ITEMS.map((i) => i.cmd);

const BY_CMD = new Map(SLASH_ITEMS.map((i) => [i.cmd, i]));

export function findSlashItem(cmd: string): SlashItem | undefined {
  return BY_CMD.get(cmd);
}

/** /help 正文：与补全面板同源，不会出现「补全有、帮助没有」。 */
export function formatSlashHelp(): string {
  const width = Math.max(...SLASH_ITEMS.map((i) => `/${i.cmd} ${i.usage ?? ''}`.trimEnd().length));
  const rows = SLASH_ITEMS.map((i) => {
    const left = `/${i.cmd}${i.usage ? ` ${i.usage}` : ''}`;
    return `  ${left.padEnd(width)}  ${i.help ?? i.hint}`;
  });
  return [
    '斜杠命令（本地拦截，不发给 Agent）:',
    ...rows,
    '',
    '输入 / 弹出命令面板，↑↓ 选择、Enter 执行、Tab 填入；/model 可补全模型名。',
    '多行输入：Ctrl+J 换行；行尾 \\ 续行；未闭合的 ``` 自动续行。',
    '编辑键：← → 移动，Alt+← / Alt+→ 按词，Ctrl+A/E 行首尾，Ctrl+W 删词，Ctrl+U 删到行首，Ctrl+K 删到行尾，Ctrl+L 清屏。',
    '执行中可继续输入，回车后进入队列，本轮结束自动发送。',
    'Ctrl+C：有草稿时清空草稿；任务在跑时取消（并清空队列）；空闲时连按两次退出。',
  ].join('\n');
}

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
