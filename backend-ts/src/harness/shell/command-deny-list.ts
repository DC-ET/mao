export interface ShellDenyMatch {
  id: string;
  reason: string;
}

const PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  {
    id: 'pkill-node',
    re: /\bpkill\b[^\n;|&]*\bnode\b/i,
    reason: '禁止 pkill 终止 Node 进程（会影响 Mao 后端）',
  },
  {
    id: 'killall',
    re: /\bkillall\b/,
    reason: '禁止 killall',
  },
];

/** CLOUD shell 命令硬拦截：仅覆盖会误杀 Mao 后端的常见模式。 */
export function matchShellDenyList(text: string | undefined | null): ShellDenyMatch | null {
  if (!text) return null;
  const sample = text.length > 20000 ? text.slice(0, 20000) : text;
  for (const pattern of PATTERNS) {
    if (pattern.re.test(sample)) {
      return { id: pattern.id, reason: pattern.reason };
    }
  }
  return null;
}
