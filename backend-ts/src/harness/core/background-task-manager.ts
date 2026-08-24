import { harnessLog } from '../log.js';

const MAX_OUTPUT_LENGTH = 500;
const ABANDONED_THRESHOLD_MS = 30 * 60 * 1000;

interface TaskEntry {
  sessionId: number | null;
  promise: Promise<string>;
  done: boolean;
  result?: string;
  error?: unknown;
  submitTimeMs: number;
  cancelled: boolean;
}

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, TaskEntry>();

  submit(sessionId: number | null, task: () => Promise<string> | string): string {
    const taskId = 'bg-' + process.hrtime.bigint().toString();
    const entry: TaskEntry = {
      sessionId,
      promise: Promise.resolve().then(task),
      done: false,
      submitTimeMs: Date.now(),
      cancelled: false,
    };
    entry.promise.then(
      (r) => { entry.done = true; entry.result = r; },
      (e) => { entry.done = true; entry.error = e; },
    );
    this.tasks.set(taskId, entry);
    harnessLog('debug', `Submitted background task: ${taskId} for session=${sessionId}`);
    return taskId;
  }

  async consumeCompletedResults(sessionId: number | null): Promise<Record<string, string>> {
    const completed: Record<string, string> = {};
    const now = Date.now();
    for (const taskId of [...this.tasks.keys()]) {
      const entry = this.tasks.get(taskId);
      if (!entry) continue;
      if (entry.done) {
        if (sessionId !== entry.sessionId) {
          // 其他会话的已完成结果留给所属会话消费；超过阈值仍无人领取则回收，避免死会话泄漏
          if (now - entry.submitTimeMs > ABANDONED_THRESHOLD_MS) {
            this.tasks.delete(taskId);
          }
          continue;
        }
        try {
          let result = entry.error
            ? 'Error: ' + ((entry.error as Error).message ?? String(entry.error))
            : (entry.result ?? '');
          if (result.length > MAX_OUTPUT_LENGTH) {
            result = result.slice(0, MAX_OUTPUT_LENGTH) + '... [truncated]';
          }
          completed[taskId] = result;
        } catch {
          continue;
        }
        this.tasks.delete(taskId);
      } else if (now - entry.submitTimeMs > ABANDONED_THRESHOLD_MS) {
        if (sessionId !== entry.sessionId) continue;
        entry.cancelled = true;
        this.tasks.delete(taskId);
        harnessLog('warn', `Cancelled abandoned background task: ${taskId} session=${entry.sessionId}`);
      }
    }
    return completed;
  }

  async getResult(taskId: string, timeoutSeconds: number): Promise<string> {
    const entry = this.tasks.get(taskId);
    if (!entry) return `Error: task not found: ${taskId}`;
    try {
      const result = await Promise.race([
        entry.promise,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutSeconds * 1000)),
      ]);
      this.tasks.delete(taskId);
      return result.length > MAX_OUTPUT_LENGTH ? result.slice(0, MAX_OUTPUT_LENGTH) + '... [truncated]' : result;
    } catch (e) {
      if ((e as Error).message === 'timeout') {
        return `Error: task timed out after ${timeoutSeconds} seconds`;
      }
      this.tasks.delete(taskId);
      return 'Error: ' + ((e as Error).message ?? String(e));
    }
  }
}
