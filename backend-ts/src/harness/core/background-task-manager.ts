import { harnessLog } from '../log.js';
import { parseObject } from '../tool/json.js';

/** 后台任务注入上下文的整体长度上限（字符）。 */
const MAX_RESULT_LENGTH = 10000;
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
          completed[taskId] = entry.error ? this.formatError(entry.error) : this.normalizeResult(entry.result ?? '');
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
      return this.normalizeResult(result);
    } catch (e) {
      if ((e as Error).message === 'timeout') {
        return `Error: task timed out after ${timeoutSeconds} seconds`;
      }
      this.tasks.delete(taskId);
      return this.formatError(e);
    }
  }

  /**
   * 把后台任务结果统一为可注入上下文的文本：
   * shell 后台任务（CLOUD exec / LOCAL await_async）的返回是 JSON，先解析重组出
   * 与同步路径同构的结构化摘要（exit_code/completed/output），再整体限长；
   * 纯文本结果仅做整体限长。
   */
  private normalizeResult(raw: string): string {
    const parsed = parseObject(raw);
    let text: string;
    if (parsed != null && typeof parsed.output === 'string') {
      // output 截断预留 JSON 头部与 error 字段开销，保证重组后的完整 JSON 不再触发整体二次截断
      const budget = MAX_RESULT_LENGTH - 400;
      const exitCode = typeof parsed.exit_code === 'number' ? parsed.exit_code : -1;
      const completed = parsed.completed !== false;
      let output = parsed.output;
      if (output.length > budget) {
        output = output.slice(0, budget) + '... [truncated]';
      }
      const payload: Record<string, unknown> = { exit_code: exitCode, completed, output };
      if (parsed.error != null) payload.error = String(parsed.error).slice(0, 100);
      text = JSON.stringify(payload, null, 2);
    } else {
      text = raw;
    }
    if (text.length > MAX_RESULT_LENGTH) {
      text = text.slice(0, MAX_RESULT_LENGTH) + '... [truncated]';
    }
    return text;
  }

  private formatError(e: unknown): string {
    return 'Error: ' + ((e as Error).message ?? String(e));
  }
}
