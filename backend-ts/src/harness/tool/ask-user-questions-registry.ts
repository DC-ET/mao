import { randomUUID } from 'node:crypto';
import { harnessLog } from '../log.js';

const DEFAULT_TIMEOUT_MILLIS = 900_000;

export interface PendingQuestion {
  requestId: string;
  questions: Array<Record<string, unknown>>;
  metadata: Record<string, unknown> | null;
}

interface PendingEntry {
  future: { resolve: (v: string) => void; promise: Promise<string> };
  questions: Array<Record<string, unknown>>;
  metadata: Record<string, unknown> | null;
}

export class AskUserQuestionsRegistry {
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly timeoutMillis = DEFAULT_TIMEOUT_MILLIS) {}

  register(sessionId: number, questions: Array<Record<string, unknown>>, metadata: Record<string, unknown> | null): string {
    const requestId = randomUUID();
    let resolve!: (v: string) => void;
    const promise = new Promise<string>((r) => { resolve = r; });
    this.pending.set(this.key(sessionId, requestId), { future: { resolve, promise }, questions, metadata });
    harnessLog('debug', `Registered ask_user_questions request ${requestId} for session ${sessionId}`);
    return requestId;
  }

  async waitForAnswer(sessionId: number, requestId: string): Promise<string> {
    const entry = this.pending.get(this.key(sessionId, requestId));
    if (!entry) {
      return JSON.stringify({ error: `No pending question found for requestId: ${requestId}` });
    }
    try {
      return await Promise.race([
        entry.future.promise,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), this.timeoutMillis)),
      ]);
    } catch {
      this.pending.delete(this.key(sessionId, requestId));
      harnessLog('warn', `ask_user_questions timeout for session ${sessionId}, requestId ${requestId}`);
      return JSON.stringify({ error: 'User did not respond within timeout' });
    }
  }

  complete(sessionId: number, requestId: string, result: string): boolean {
    const k = this.key(sessionId, requestId);
    const entry = this.pending.get(k);
    if (entry) {
      this.pending.delete(k);
      entry.future.resolve(result);
      return true;
    }
    return false;
  }

  getPendingForSession(sessionId: number | null): PendingQuestion[] {
    if (sessionId == null) return [];
    const prefix = sessionId + ':';
    const result: PendingQuestion[] = [];
    for (const [key, entry] of this.pending) {
      if (key.startsWith(prefix)) {
        result.push({ requestId: key.slice(prefix.length), questions: entry.questions, metadata: entry.metadata });
      }
    }
    return result;
  }

  countPendingBySessionIds(sessionIds: Iterable<number> | null): Map<number, number> {
    const result = new Map<number, number>();
    if (!sessionIds) return result;
    const wanted = new Set(sessionIds);
    for (const key of this.pending.keys()) {
      const colon = key.indexOf(':');
      if (colon <= 0) continue;
      const sid = Number(key.slice(0, colon));
      if (wanted.has(sid)) result.set(sid, (result.get(sid) ?? 0) + 1);
    }
    return result;
  }

  failAllForSession(sessionId: number): void {
    const prefix = sessionId + ':';
    for (const [key, entry] of [...this.pending.entries()]) {
      if (key.startsWith(prefix)) {
        entry.future.resolve(JSON.stringify({ error: 'Session cancelled' }));
        this.pending.delete(key);
      }
    }
  }

  failAllForSessions(sessionIds: Iterable<number>): void {
    for (const id of sessionIds) this.failAllForSession(id);
  }

  private key(sessionId: number, requestId: string): string {
    return `${sessionId}:${requestId}`;
  }
}
