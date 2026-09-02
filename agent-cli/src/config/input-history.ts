import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config-store';

export const HISTORY_FILE = path.join(CONFIG_DIR, 'history');
const HISTORY_MAX = 200;

/**
 * 输入历史：跨进程持久化，最新的在最后。
 * 一行一条，多行输入按 JSON 字符串编码（`"a\nb"`），旧的裸文本行也能读。
 */
export function loadInputHistory(max = HISTORY_MAX): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(HISTORY_FILE, 'utf8');
  } catch {
    return [];
  }
  const items: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    items.push(decodeLine(t));
  }
  return items.slice(Math.max(0, items.length - max));
}

function decodeLine(line: string): string {
  if (!line.startsWith('"')) return line;
  try {
    const v = JSON.parse(line);
    return typeof v === 'string' ? v : line;
  } catch {
    return line;
  }
}

export function appendInputHistory(text: string, max = HISTORY_MAX): void {
  const one = text.trim();
  if (!one) return;
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(one) + '\n', { mode: 0o600 });
    trimHistory(max);
  } catch {
    // 历史是锦上添花，写不进去不影响会话
  }
}

function trimHistory(max: number): void {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length <= max * 2) return;
    fs.writeFileSync(HISTORY_FILE, lines.slice(lines.length - max).join('\n') + '\n', { mode: 0o600 });
  } catch {
    // ignore
  }
}
