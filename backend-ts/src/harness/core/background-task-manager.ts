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

/** awaitResult 的三态：任务不存在 / 仍在跑（未消费） / 已完成（已消费）。 */
export type AwaitTaskResult =
  | { status: 'not_found' }
  | { status: 'pending' }
  | { status: 'done'; result: string };

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

  /**
   * 主动等待某个后台任务：超时不消费（留给下一轮自动注入），完成即消费并归一化。
   * sessionId 用于归属校验，避免跨会话领取他人任务结果。
   */
  async awaitResult(
    taskId: string, timeoutMs: number, sessionId: number | null = null,
  ): Promise<AwaitTaskResult> {
    const entry = this.tasks.get(taskId);
    if (!entry) return { status: 'not_found' };
    if (sessionId != null && entry.sessionId != null && entry.sessionId !== sessionId) {
      return { status: 'not_found' };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('timeout');
    try {
      const raced = await Promise.race([
        entry.promise.then((r) => r as string | typeof timedOut),
        new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); }),
      ]);
      if (raced === timedOut) return { status: 'pending' };
      this.tasks.delete(taskId);
      return { status: 'done', result: this.normalizeResult(raced) };
    } catch (e) {
      this.tasks.delete(taskId);
      return { status: 'done', result: this.formatError(e) };
    } finally {
      // 不清理定时器的话，任务早已返回，事件循环仍会被挂住最长 timeoutMs
      if (timer) clearTimeout(timer);
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
      // 未结束的命令必须带上 session_id 与续等提示，否则模型无从继续 await_async
      if (typeof parsed.session_id === 'string') payload.session_id = parsed.session_id;
      if (typeof parsed.matched === 'string') payload.matched = parsed.matched;
      if (!completed && typeof parsed.message === 'string') payload.message = parsed.message.slice(0, 300);
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
