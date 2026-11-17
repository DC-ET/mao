import { harnessLog } from '../log.js';
import { parseObject } from '../tool/json.js';

/** 后台任务注入上下文的整体长度上限（字符）。 */
const MAX_RESULT_LENGTH = 10000;
/** 已完成但无人领取（跨会话遗留）的结果保留时长。 */
const ABANDONED_THRESHOLD_MS = 30 * 60 * 1000;
/** 仍未结束的任务保留上限：超过即认为不可能再有人领结果，才允许回收登记表。 */
const UNFINISHED_HARD_EXPIRY_MS = 24 * 60 * 60 * 1000;
/**
 * 结果被消费后「已交付」标记的保留时长。
 * task_id 是一次性的：等待或自动注入取走结果后登记项即删除。但调用方常在拿到结果后
 * 仍带着同一个 task_id 重问（例如同时传 task_id + session_id 续等），没有这个标记就
 * 只能回答「任务不存在」，把「结果已交付」误报成「任务丢失」。
 */
const DELIVERED_RETENTION_MS = 30 * 60 * 1000;

interface TaskEntry {
  sessionId: number | null;
  promise: Promise<string>;
  done: boolean;
  result?: string;
  error?: unknown;
  submitTimeMs: number;
  overdueWarned: boolean;
}

/** 已交付结果后的短期标记：区分「结果已取走」与「从未存在 / 被回收」。 */
interface DeliveredEntry {
  sessionId: number | null;
  deliveredAtMs: number;
}

/** awaitResult 的四态：任务不存在 / 结果已交付过 / 仍在跑（未消费） / 已完成（本次消费）。 */
export type AwaitTaskResult =
  | { status: 'not_found' }
  | { status: 'delivered' }
  | { status: 'pending' }
  | { status: 'done'; result: string };

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, TaskEntry>();
  /** 已交付结果的短期标记（task_id 一次性，重问时回答「已交付」而不是「不存在」）。 */
  private readonly delivered = new Map<string, DeliveredEntry>();

  /** now 可注入，便于测试超时回收而不依赖真实时钟。 */
  constructor(private readonly now: () => number = () => Date.now()) {}

  submit(sessionId: number | null, task: () => Promise<string> | string): string {
    const taskId = 'bg-' + process.hrtime.bigint().toString();
    const entry: TaskEntry = {
      sessionId,
      promise: Promise.resolve().then(task),
      done: false,
      submitTimeMs: this.now(),
      overdueWarned: false,
    };
    entry.promise.then(
      (r) => { entry.done = true; entry.result = r; },
      (e) => { entry.done = true; entry.error = e; },
    );
    this.tasks.set(taskId, entry);
    harnessLog('debug', `Submitted background task: ${taskId} for session=${sessionId}`);
    return taskId;
  }

  /** 未消费（含未完成）任务数：容器 idle 判定的容器内状态上报用（技术方案 §5.3.1）。 */
  countUnfinished(): number {
    return this.tasks.size;
  }

  async consumeCompletedResults(sessionId: number | null): Promise<Record<string, string>> {
    const completed: Record<string, string> = {};
    const now = this.now();
    this.gcDelivered(now);
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
        this.markDelivered(taskId, entry.sessionId);
        continue;
      }
      // 仍在跑的任务必须留在登记表里：长时构建超过 30 分钟很常见，提前移除会让
      // 结果永久无人消费（自动注入拿不到），模型再 await_async 也只会得到「任务不存在」。
      // 硬过期回收不限所属会话（会话可能已死、永远不再来消费），但下面的超时告警限所属会话。
      if (now - entry.submitTimeMs > UNFINISHED_HARD_EXPIRY_MS) {
        this.tasks.delete(taskId);
        harnessLog('warn', `Dropped background task after hard expiry: ${taskId} session=${entry.sessionId}`);
        continue;
      }
      if (sessionId !== entry.sessionId) continue;
      if (!entry.overdueWarned && now - entry.submitTimeMs > ABANDONED_THRESHOLD_MS) {
        entry.overdueWarned = true;
        harnessLog(
          'warn',
          `Background task still running after ${ABANDONED_THRESHOLD_MS / 60_000} minutes, keeping it for delivery: ${taskId} session=${entry.sessionId}`,
        );
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
    this.gcDelivered(this.now());
    const entry = this.tasks.get(taskId);
    if (!entry) {
      // 结果可能已被等待或自动注入消费掉：凭短期标记回答「已交付」，不能误报「不存在」
      const delivered = this.delivered.get(taskId);
      if (delivered && this.ownedBy(delivered.sessionId, sessionId)) return { status: 'delivered' };
      return { status: 'not_found' };
    }
    if (!this.ownedBy(entry.sessionId, sessionId)) return { status: 'not_found' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('timeout');
    try {
      const raced = await Promise.race([
        entry.promise.then((r) => r as string | typeof timedOut),
        new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); }),
      ]);
      if (raced === timedOut) return { status: 'pending' };
      this.tasks.delete(taskId);
      this.markDelivered(taskId, entry.sessionId);
      return { status: 'done', result: this.normalizeResult(raced) };
    } catch (e) {
      this.tasks.delete(taskId);
      this.markDelivered(taskId, entry.sessionId);
      return { status: 'done', result: this.formatError(e) };
    } finally {
      // 不清理定时器的话，任务早已返回，事件循环仍会被挂住最长 timeoutMs
      if (timer) clearTimeout(timer);
    }
  }

  /** 归属校验：调用方给了 sessionId 且登记项也有 sessionId 时必须一致。 */
  private ownedBy(entrySessionId: number | null, callerSessionId: number | null): boolean {
    return callerSessionId == null || entrySessionId == null || entrySessionId === callerSessionId;
  }

  /** 结果被消费后登记「已交付」：短期保留，把「已取走」与「从未存在 / 被回收」区分开。 */
  private markDelivered(taskId: string, sessionId: number | null): void {
    this.delivered.set(taskId, { sessionId, deliveredAtMs: this.now() });
  }

  private gcDelivered(now: number): void {
    for (const [taskId, entry] of this.delivered) {
      if (now - entry.deliveredAtMs > DELIVERED_RETENTION_MS) this.delivered.delete(taskId);
    }
  }

  /**
   * 把后台任务结果统一为可注入上下文的文本：
   * shell 后台任务（CLOUD exec / LOCAL await_async）的返回是 JSON，整体透传其字段、
   * 仅对 output 限长，保证与同步路径 formatResult 同构；纯文本结果仅做整体限长。
   */
  private normalizeResult(raw: string): string {
    const parsed = parseObject(raw);
    let text: string;
    if (parsed != null && typeof parsed.output === 'string') {
      // 白名单重建会静默丢掉 truncated/output_file/current_workdir/shellExited 等字段：
      // 模型会把被裁掉尾段的构建日志当成完整输出，也失去完整日志的读取入口，
      // 甚至继续 await_async 一个已退出的死会话。这里展开全部字段，只对 output 限长。
      const payload: Record<string, unknown> = { ...parsed };
      const output = payload.output as string;
      // message/error 可能来自本地 shell 的任意输出，仍保留长度上限
      if (typeof payload.message === 'string') payload.message = payload.message.slice(0, 300);
      if (payload.error != null) payload.error = String(payload.error).slice(0, 100);
      // output 截断必须转义感知：JSON.stringify 对引号/反斜杠/换行逐字符膨胀（控制字符最多 ×6），
      // 固定预算会被引号密集输出击穿，二次截断在字符串值中间切断产出非法 JSON、连带丢掉
      // output_file/current_workdir。按整体序列化长度收敛 output 预算，保证结果恒为合法 JSON。
      let budget = MAX_RESULT_LENGTH - 400;
      for (;;) {
        payload.output = output.length > budget ? output.slice(0, budget) + '... [truncated]' : output;
        text = JSON.stringify(payload, null, 2);
        if (text.length <= MAX_RESULT_LENGTH || budget <= 0) break;
        budget = Math.floor(budget / 2);
      }
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
