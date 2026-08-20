import type { RestClient } from '../rest/rest-client';
import type { SessionVO } from '../rest/types';

export async function cmdLs(rest: RestClient, json: boolean): Promise<void> {
  const sessions = await rest.listSessions({ status: 'ACTIVE' });
  const sorted = [...sessions].sort((a, b) => {
    const ta = Date.parse(a.updatedAt ?? '') || 0;
    const tb = Date.parse(b.updatedAt ?? '') || 0;
    if (tb !== ta) return tb - ta;
    return (b.id ?? 0) - (a.id ?? 0);
  });
  if (json) {
    process.stdout.write(JSON.stringify(sorted, null, 2) + '\n');
    return;
  }
  if (sorted.length === 0) {
    process.stdout.write('(没有可恢复的 ACTIVE 会话)\n');
    return;
  }
  const width = Math.max(...sorted.map((s) => String(s.id ?? '').length), 2);
  for (const s of sorted) {
    process.stdout.write(`${formatRow(s, width)}\n`);
  }
}

function formatRow(s: SessionVO, width: number): string {
  const id = String(s.id ?? '').padStart(width);
  const pin = s.isPinned ? '*' : ' ';
  const phase = (s.phase ?? 'IDLE').padEnd(10);
  const agent = (s.agentName ?? '').slice(0, 16).padEnd(16);
  const title = (s.title ?? '未命名会话').replace(/\s+/g, ' ').slice(0, 48);
  const updated = s.updatedAt ?? '';
  return `${pin}${id}  ${phase}  ${agent}  ${title}  ${updated}`;
}
