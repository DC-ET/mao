import type { MessageVO, SessionVO } from '../rest/types';
import { formatRelativeTime } from './relative-time';

export function formatSessionBanner(
  session: SessionVO,
  opts: { resumed?: boolean; now?: number } = {},
): string {
  const id = session.id != null ? `#${session.id}` : '';
  const agent = session.agentName || session.agentId || 'Agent';
  const model = session.modelName || session.modelId || 'model';
  const mode = session.executionMode || 'CLOUD';
  const ws = session.executionMode === 'LOCAL' && session.workspace ? ` · ${session.workspace}` : '';
  const head = `mao-agent  ${id} · ${agent} · ${model} · ${mode}${ws}`;
  if (opts.resumed) {
    const ago = formatRelativeTime(session.updatedAt, opts.now);
    const when = ago ? ` · 上次更新 ${ago}` : '';
    return `恢复 ${id} · ${agent}${when}`;
  }
  return head;
}

export function formatWelcomeHints(): string {
  return '输入消息开始 · /help  /session  /model · Ctrl+C 取消';
}

export function formatHistorySummary(messages: MessageVO[], full: boolean): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role ?? '?';
    const content = (m.content ?? '').replace(/\s+/g, ' ').trim();
    if (full) {
      const mark = role === 'user' ? '❯' : '⏺';
      lines.push(`${mark} ${m.content ?? ''}`);
      continue;
    }
    const first = content.split('\n')[0]?.slice(0, 72) ?? '';
    const counts = toolCounts(m.toolCalls);
    const tools = counts ? `  · ${counts}` : '';
    if (role === 'user') lines.push(`❯ ${first}`);
    else lines.push(`⏺ ${first}${tools}`);
  }
  return lines;
}

function toolCounts(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  const map = new Map<string, number>();
  for (const t of toolCalls as Array<{ name?: string; toolName?: string }>) {
    const name = t.name || t.toolName;
    if (!name) continue;
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return [...map.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(', ');
}
