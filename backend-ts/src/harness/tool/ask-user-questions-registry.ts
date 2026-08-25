import { randomUUID } from 'node:crypto';
import { harnessLog } from '../log.js';

const DEFAULT_TIMEOUT_MILLIS = 900_000;

export interface PendingQuestion {
  requestId: string;
  questions: Array<Record<string, unknown>>;
  metadata: Record<string, unknown> | null;
}

/** waitForAnswer 的结构化终态：answered/cancelled 与 timeout 互斥，禁止用结果内容猜测。 */
export interface AskUserAnswersResult {
  answered: boolean;
  /** 会话停止/中止等场景由 failAll 结束等待，调用方应广播取消事件。 */
  cancelled: boolean;
  /** answered=true 时为 {"answers": [...]}；否则为错误说明 JSON。 */
  resultJson: string;
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

  async waitForAnswer(sessionId: number, requestId: string): Promise<AskUserAnswersResult> {
    const entry = this.pending.get(this.key(sessionId, requestId));
    if (!entry) {
      return { answered: false, cancelled: false, resultJson: JSON.stringify({ error: `No pending question found for requestId: ${requestId}` }) };
    }
    try {
      const resultJson = await Promise.race([
        entry.future.promise,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), this.timeoutMillis)),
      ]);
      // failAllForSession 结束等待时也走 resolve 通道，须解析标记区分「正常应答」与「会话取消」
      let cancelled = false;
      try {
        cancelled = JSON.parse(resultJson)?.cancelled === true;
      } catch { /* 非 JSON 视为正常应答 */ }
      return { answered: true, cancelled, resultJson };
    } catch {
      this.pending.delete(this.key(sessionId, requestId));
      harnessLog('warn', `ask_user_questions timeout for session ${sessionId}, requestId ${requestId}`);
      return { answered: false, cancelled: false, resultJson: JSON.stringify({ error: 'User did not respond within timeout' }) };
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
        // cancelled=true 标记取消终态：dispatcher 据此广播 ask_user_questions_cancelled，
        // 结果内容仍以 {"error": ...} 传给 LLM，不靠内容猜语义
        entry.future.resolve(JSON.stringify({ error: 'Session cancelled', cancelled: true }));
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
