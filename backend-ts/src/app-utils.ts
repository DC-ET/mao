import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export function expandHome(v: string): string {
  if (v.startsWith('$HOME')) return v.replace(/^\$HOME/, process.env.HOME ?? '');
  if (v.startsWith('~/')) return resolve(process.env.HOME ?? '', v.slice(2));
  return v;
}

/** 解析 MySQL datetime（`yyyy-MM-dd HH:mm:ss`）为毫秒时间戳；缺失或不可解析返回 null。 */
export function parseSqlTimeMs(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

/** 会话删除时清理该会话 runtime 目录（incoming 上传、skills 同步副本、shell 输出等临时数据）。 */
export function runtimeSessionCleanup(runtimeRoot: string): (userId: number, sessionId: number) => void {
  return (userId: number, sessionId: number): void => {
    try {
      const sessionDir = resolve(runtimeRoot, String(userId), String(sessionId));
      if (existsSync(sessionDir)) {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`Failed to clean runtime dir for session ${sessionId}`, e);
    }
  };
}
