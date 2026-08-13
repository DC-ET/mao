import { harnessLog } from '../log.js';

const MAX_CONTENT_LENGTH = 100 * 1024;

export class LocalAgentsMdRegistry {
  private readonly reported = new Map<number, string>();

  report(sessionId: number | null | undefined, content: string | null | undefined): void {
    if (sessionId == null) return;
    if (content == null || content.trim() === '') {
      this.reported.delete(sessionId);
    } else {
      let c = content;
      if (c.length > MAX_CONTENT_LENGTH) {
        harnessLog('warn', `AGENTS.md content too large (${c.length} chars), truncating to ${MAX_CONTENT_LENGTH} chars for session ${sessionId}`);
        c = c.slice(0, MAX_CONTENT_LENGTH);
      }
      this.reported.set(sessionId, c);
    }
  }

  get(sessionId: number | null | undefined): string | null {
    if (sessionId == null) return null;
    return this.reported.get(sessionId) ?? null;
  }

  clear(sessionId: number | null | undefined): void {
    if (sessionId != null) this.reported.delete(sessionId);
  }
}
