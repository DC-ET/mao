export const SLASH_COMMANDS = [
  'cancel',
  'model',
  'todo',
  'context',
  'session',
  'verbose',
  'queue',
  'clear',
  'copy',
  'agent',
  'help',
  'exit',
  'quit',
] as const;

const NEEDS_ARG = new Set(['model', 'queue']);

export interface SlashCompleteOptions {
  models?: string[];
}

/** readline completer：返回 [候选, 被补全的前缀]。 */
export function completeSlash(line: string, opts: SlashCompleteOptions = {}): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const inner = line.slice(1);
  const space = inner.indexOf(' ');
  if (space === -1) {
    const hits = SLASH_COMMANDS.filter((c) => c.startsWith(inner)).map((c) => `/${c}${NEEDS_ARG.has(c) ? ' ' : ''}`);
    return [hits, line];
  }
  const cmd = inner.slice(0, space);
  const rest = inner.slice(space + 1);
  if (cmd === 'model') {
    const names = opts.models ?? [];
    const hits = names.filter((n) => n.startsWith(rest));
    return [hits, rest];
  }
  if (cmd === 'queue') {
    const hits = ['clear'].filter((s) => s.startsWith(rest));
    return [hits, rest];
  }
  return [[], line];
}
