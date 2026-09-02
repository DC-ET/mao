import type { AgentVO, CreateSessionRequest, SessionVO } from '../rest/types';
import type { RestClient } from '../rest/rest-client';
import type { WsClient } from '../ws/ws-client';
import type { AskAnswer, AskQuestion, TodoItem, WsEvent } from '../ws/event-types';
import { acceptEvent, isRunningPhase, isTerminalStatus } from '../ws/event-filter';
import { randomUUID } from '../util/uuid';
import { CliError, EXIT } from '../util/exit-codes';
import type { AskHandler, CliEvent, FileChangeRecord, Renderer, RunResult, ToolCallRecord, UsageRecord } from '../render/types';
import type { LocalExecutor } from '../local/executor';

export interface SessionRunnerOptions {
  rest: RestClient;
  ws: WsClient;
  renderer: Renderer;
  printMode: boolean;
  ifRunning: 'wait' | 'cancel' | 'fail';
  onQuestion: 'ask' | 'fail';
  askHandler?: AskHandler;
  maxDurationSec?: number;
  includeToolIo?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  localExecutor?: LocalExecutor;
  localExtras?: () => { localSkills?: unknown[]; agentsMdContent?: string };
}

const QUESTION_FAIL_WAIT_MS = 2000;
const CANCEL_WAIT_MS = 5000;

export class SessionRunner {
  private sessionId = 0;
  private renderer: Renderer;
  private executionId: string | null = null;
  private seenRunning = false;
  private busyRejectedEid: string | null = null;
  private reconnected = false;
  private currentText = '';
  private lastAssistantText = '';
  private usage: UsageRecord = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private toolCalls = new Map<string, ToolCallRecord>();
  private fileChanges: FileChangeRecord[] = [];
  private todos: TodoItem[] = [];
  private lastContext: { estimated?: number; actual?: number } = {};
  private startedAt = 0;
  private terminal: { phase: string } | null = null;
  private waiters: Array<() => void> = [];
  private asked = new Set<string>();
  private unsub: (() => void) | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelledByUserFlag = false;
  private timedOutFlag = false;
  private questionFailedFlag = false;
  private approvalFailedFlag = false;
  private session: SessionVO | null = null;
  private snapshotPhase: string | null = null;
  private snapshotWaiters: Array<() => void> = [];
  private busy = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: SessionRunnerOptions) {
    this.renderer = opts.renderer;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  /** 交互模式挂载 Ink 后替换渲染链（trace + TUI）。 */
  setRenderer(renderer: Renderer): void {
    this.renderer = renderer;
  }

  getSession(): SessionVO | null {
    return this.session;
  }

  getTodos(): TodoItem[] {
    return this.todos;
  }

  getContext(): { estimated?: number; actual?: number } {
    return this.lastContext;
  }

  isRunning(): boolean {
    return this.busy;
  }

  get questionFailed(): boolean {
    return this.questionFailedFlag;
  }

  get approvalFailed(): boolean {
    return this.approvalFailedFlag;
  }

  get timedOut(): boolean {
    return this.timedOutFlag;
  }

  get cancelledByUser(): boolean {
    return this.cancelledByUserFlag;
  }

  get snapshotIsActive(): boolean {
    return isRunningPhase(this.snapshotPhase ?? this.session?.phase);
  }

  async attach(session: SessionVO): Promise<void> {
    if (session.id == null) throw new CliError('会话缺少 id');
    this.session = session;
    this.sessionId = session.id;
    this.resetRound();
    this.unsub?.();
    this.unsub = this.opts.ws.on((evt) => this.handleWs(evt));
    await this.opts.ws.connect();
    this.opts.ws.subscribe(this.sessionId);
    await this.waitForSnapshot(2000);
  }

  async createAndAttach(req: CreateSessionRequest): Promise<SessionVO> {
    const session = await this.opts.rest.createSession({
      executionMode: 'CLOUD',
      permissionLevel: 'READ_WRITE',
      ...req,
    });
    await this.attach(session);
    return session;
  }

  async runPrompt(content: string, modelId?: number): Promise<RunResult> {
    if (this.busy) {
      throw new CliError('上一条还在跑。请等待结束或 /cancel。');
    }
    this.busy = true;
    try {
      const wasActive = isRunningPhase(this.snapshotPhase ?? this.session?.phase);
      const activeEid = this.executionId;
      this.resetRound();
      this.startedAt = this.now();
      this.armMaxDuration();

      if (wasActive) {
        this.executionId = activeEid;
        this.seenRunning = true;
        await this.handleAlreadyActive(this.snapshotPhase ?? this.session?.phase);
      }

      // 服务端可能以 session_already_running 拒收（会话被别的客户端占用）。
      // 此时等占用方结束再重发一次，重试只做一次以免死循环。
      for (let attempt = 0; ; attempt++) {
        this.resetRound();
        this.executionId = randomUUID();
        this.emit({ type: 'session_started', sessionId: this.sessionId, executionId: this.executionId });
        const sent = await this.sendMessage(content, modelId);
        if (!sent) {
          return this.finishWith('FAILED', '发送失败');
        }
        await this.waitUntilSettled();
        if (attempt > 0 || this.terminal?.phase !== 'ALREADY_RUNNING' || !this.busyRetryMode()) {
          return this.buildResult();
        }
        await this.awaitBusyRun(this.busyRejectedEid, this.busyRetryMode() === 'cancel');
        if (this.cancelledByUserFlag || this.timedOutFlag) {
          return this.buildResult();
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** 被拒后是否重发：REPL 一律重发；-p 由 --if-running 决定。 */
  private busyRetryMode(): 'wait' | 'cancel' | null {
    if (!this.opts.printMode) return 'wait';
    return this.opts.ifRunning === 'fail' ? null : this.opts.ifRunning;
  }

  /** 盯住占用方的执行直到它落终态（cancel 模式先发取消）。 */
  private async awaitBusyRun(busyEid: string | null, cancelFirst: boolean): Promise<void> {
    this.terminal = null;
    this.executionId = busyEid;
    this.seenRunning = true;
    if (cancelFirst) await this.sendCancel();
    await this.waitUntilSettled(cancelFirst ? CANCEL_WAIT_MS : undefined);
  }

  async waitForCurrentRun(): Promise<RunResult> {
    if (this.busy) {
      throw new CliError('当前任务仍在执行，请等待结束或 /cancel');
    }
    this.busy = true;
    try {
      this.startedAt = this.now();
      this.armMaxDuration();
      this.emit({ type: 'session_started', sessionId: this.sessionId, executionId: this.executionId ?? undefined });
      await this.waitUntilSettled();
      return this.buildResult();
    } finally {
      this.busy = false;
    }
  }

  async cancel(): Promise<void> {
    this.cancelledByUserFlag = true;
    await this.sendCancel();
  }

  markApprovalDenied(): void {
    this.approvalFailedFlag = true;
    void this.cancel();
  }

  async shutdown(): Promise<void> {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    if (this.sessionId) {
      this.opts.ws.unsubscribe(this.sessionId);
      try {
        await this.opts.rest.markRead(this.sessionId);
      } catch {
        // ignore
      }
    }
    this.unsub?.();
    this.unsub = null;
    if (this.opts.localExecutor) {
      await this.opts.localExecutor.close(this.sessionId || undefined);
    }
    this.opts.ws.close();
  }

  getSentCancelPayload(): { type: string; sessionId: number } {
    return { type: 'cancel', sessionId: this.sessionId };
  }

  /**
   * 取消是关键控制帧：走可靠发送（断线时先重连再发），
   * 避免裸 send 在断线窗口静默丢弃导致服务端任务跑满全程。
   */
  private async sendCancel(): Promise<void> {
    const sent = await this.opts.ws.sendReliable({ type: 'cancel', sessionId: this.sessionId });
    if (!sent) {
      console.error('[cancel] 取消帧发送失败（连接不可用），任务可能在服务端继续执行');
    }
  }

  private resetRound(): void {
    this.executionId = null;
    this.seenRunning = false;
    this.busyRejectedEid = null;
    this.currentText = '';
    this.lastAssistantText = '';
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.toolCalls.clear();
    this.fileChanges = [];
    this.terminal = null;
    this.cancelledByUserFlag = false;
    this.timedOutFlag = false;
    this.questionFailedFlag = false;
    this.approvalFailedFlag = false;
    this.asked.clear();
  }

  private armMaxDuration(): void {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    const sec = this.opts.maxDurationSec;
    if (!sec || sec <= 0) return;
    this.durationTimer = setTimeout(() => {
      this.timedOutFlag = true;
      void this.sendCancel().then(() => this.waitCancelThenSettle(CANCEL_WAIT_MS));
    }, sec * 1000);
  }

  private async sendMessage(content: string, modelId?: number): Promise<boolean> {
    const data: Record<string, unknown> = {
      content,
      eventId: this.executionId,
      images: [],
    };
    if (modelId != null) data.modelId = modelId;
    const extras = this.opts.localExtras?.();
    if (extras?.localSkills && extras.localSkills.length > 0) data.localSkills = extras.localSkills;
    if (extras?.agentsMdContent) data.agentsMdContent = extras.agentsMdContent;
    return this.opts.ws.sendReliable({ type: 'send_message', sessionId: this.sessionId, data });
  }

  private async handleAlreadyActive(phase?: string): Promise<void> {
    if (this.opts.printMode) {
      if (this.opts.ifRunning === 'fail') {
        throw new CliError('该会话仍在执行（--if-running=fail）', EXIT.GENERAL);
      }
      if (this.opts.ifRunning === 'cancel') {
        await this.sendCancel();
        await this.waitUntilSettled(CANCEL_WAIT_MS);
        this.resetRound();
        return;
      }
      await this.waitUntilSettled();
      this.resetRound();
      return;
    }
    // REPL：会话忙时消息照常发送；服务端回 session_already_running 后
    // 由 runPrompt 的重试循环等占用执行结束再重发
  }

  private handleWs(evt: WsEvent): void {
    if (evt.type === 'connected' || evt.type === 'pong') return;
    if (evt.sessionId == null && evt.type !== 'error') return;

    // 该事件是服务端对我们 send_message 的拒绝回执，收件人就是发送方本人，
    // 其 data.executionId 指向占用方，不能走按自身 executionId 的过滤。
    // 这里只记录并结束本次等待，重发逻辑放在 runPrompt 主流程里（避免两处并发等同一个 waiters 队列）
    if (evt.type === 'session_already_running' && (evt.sessionId == null || evt.sessionId === this.sessionId)) {
      const busyEid = evt.data?.executionId != null ? String(evt.data.executionId) : undefined;
      this.emit({
        type: 'session_already_running',
        message: String(evt.data?.message ?? '该会话仍在执行'),
        executionId: busyEid,
      });
      this.busyRejectedEid = busyEid ?? null;
      this.terminal = { phase: 'ALREADY_RUNNING' };
      this.flushWaiters();
      return;
    }

    if (!acceptEvent(evt, this.sessionId, this.executionId)) return;

    if (evt.type === 'tool_execute' || evt.type === 'skill_sync_required' || evt.type === 'mcp_sync_required') {
      void this.opts.localExecutor?.handleEvent(evt);
      return;
    }

    if (evt.type === 'session_snapshot') {
      const phase = String(evt.data?.phase ?? '');
      const eid = evt.data?.executionId != null ? String(evt.data.executionId) : null;
      this.snapshotPhase = phase;
      if (this.session) this.session.phase = phase;
      if (eid && !this.executionId && isRunningPhase(phase)) {
        this.executionId = eid;
        this.seenRunning = true;
      }
      const snaps = this.snapshotWaiters.splice(0);
      for (const w of snaps) w();
      return;
    }

    if (evt.type === 'session_status') {
      const phase = String(evt.data?.phase ?? '');
      if (this.session) this.session.phase = phase;
      this.snapshotPhase = phase;
      if (phase === 'RUNNING' || phase === 'WAITING_APPROVAL') this.seenRunning = true;
      this.emit({ type: 'session_status', phase, executionId: evt.data?.executionId != null ? String(evt.data.executionId) : undefined });
      if (isTerminalStatus(evt, this.executionId, this.seenRunning)) {
        this.terminal = { phase };
        this.flushWaiters();
      }
      return;
    }

    this.routeStream(evt);
  }

  private routeStream(evt: WsEvent): void {
    const d = evt.data ?? {};
    switch (evt.type) {
      case 'user_message_saved':
        this.emit({ type: 'user_message_saved', messageId: Number(d.messageId) });
        break;
      case 'content_delta':
        this.currentText += String(d.delta ?? '');
        this.lastAssistantText = this.currentText;
        this.emit({ type: 'content_delta', delta: String(d.delta ?? '') });
        break;
      case 'thinking_start':
        this.emit({ type: 'thinking_start' });
        break;
      case 'thinking_delta':
        this.emit({ type: 'thinking_delta', delta: String(d.delta ?? '') });
        break;
      case 'thinking_end':
        this.emit({ type: 'thinking_end' });
        break;
      case 'tool_call_start': {
        const id = String(d.tool_call_id ?? '');
        const name = String(d.tool_name ?? '');
        const existing = this.toolCalls.get(id);
        const rec: ToolCallRecord = {
          toolCallId: id,
          toolName: name,
          status: 'RUNNING',
          arguments: d.arguments != null ? String(d.arguments) : existing?.arguments,
        };
        this.toolCalls.set(id, rec);
        this.currentText = '';
        this.lastAssistantText = '';
        this.emit({ type: 'tool_call_start', toolCallId: id, toolName: name, arguments: rec.arguments });
        break;
      }
      case 'tool_call_args_delta': {
        const id = String(d.tool_call_id ?? '');
        const rec = this.toolCalls.get(id);
        if (rec) rec.arguments = String(d.arguments ?? rec.arguments ?? '');
        this.emit({ type: 'tool_call_args_delta', toolCallId: id, arguments: String(d.arguments ?? '') });
        break;
      }
      case 'tool_call_result': {
        const id = String(d.tool_call_id ?? '');
        const rec = this.toolCalls.get(id) ?? {
          toolCallId: id,
          toolName: String(d.tool_name ?? ''),
          status: 'SUCCESS',
        };
        rec.status = String(d.status ?? 'SUCCESS');
        rec.result = d.result != null ? String(d.result) : rec.result;
        if (d.tool_name) rec.toolName = String(d.tool_name);
        this.toolCalls.set(id, rec);
        this.emit({
          type: 'tool_call_result',
          toolCallId: id,
          toolName: rec.toolName,
          status: rec.status,
          result: rec.result,
          preview: d.preview != null ? String(d.preview) : undefined,
          summary: d.summary != null ? String(d.summary) : undefined,
        });
        break;
      }
      case 'file_change': {
        const fc: FileChangeRecord = {
          path: String(d.path ?? ''),
          type: String(d.type ?? 'MODIFY'),
          linesAdded: Number(d.lines_added ?? 0),
          linesDeleted: Number(d.lines_deleted ?? 0),
        };
        this.fileChanges.push(fc);
        this.emit({ type: 'file_change', path: fc.path, changeType: fc.type, linesAdded: fc.linesAdded, linesDeleted: fc.linesDeleted });
        break;
      }
      case 'message_end':
        this.usage.promptTokens += Number(d.prompt_tokens ?? 0);
        this.usage.completionTokens += Number(d.completion_tokens ?? 0);
        this.usage.totalTokens += Number(d.total_tokens ?? 0);
        this.emit({
          type: 'message_end',
          promptTokens: Number(d.prompt_tokens ?? 0),
          completionTokens: Number(d.completion_tokens ?? 0),
          totalTokens: Number(d.total_tokens ?? 0),
        });
        break;
      case 'context_window':
        this.lastContext = {
          estimated: d.estimated != null ? Number(d.estimated) : undefined,
          actual: d.actual != null ? Number(d.actual) : undefined,
        };
        this.emit({ type: 'context_window', ...this.lastContext });
        break;
      case 'compaction_start':
        this.emit({
          type: 'compaction_start',
          messageCount: d.messageCount != null ? Number(d.messageCount) : undefined,
          estimatedTokens: d.estimatedTokens != null ? Number(d.estimatedTokens) : undefined,
        });
        break;
      case 'compaction_end':
        this.emit({
          type: 'compaction_end',
          savedTokens: d.savedTokens != null ? Number(d.savedTokens) : undefined,
          durationMs: d.durationMs != null ? Number(d.durationMs) : undefined,
        });
        break;
      case 'llm_waiting':
        this.emit({
          type: 'llm_waiting',
          phase: d.phase != null ? String(d.phase) : undefined,
          elapsedSeconds: d.elapsedSeconds != null ? Number(d.elapsedSeconds) : undefined,
        });
        break;
      case 'llm_retry':
        this.emit({
          type: 'llm_retry',
          reason: d.reason != null ? String(d.reason) : undefined,
          attempt: d.attempt != null ? Number(d.attempt) : undefined,
          maxRetries: d.maxRetries != null ? Number(d.maxRetries) : undefined,
          delaySeconds: d.delaySeconds != null ? Number(d.delaySeconds) : undefined,
        });
        break;
      case 'llm_stream_reset':
        this.currentText = '';
        this.lastAssistantText = '';
        this.emit({ type: 'llm_stream_reset' });
        break;
      case 'ask_user_questions': {
        const requestId = String(d.requestId ?? '');
        if (!requestId || this.asked.has(requestId)) return;
        this.asked.add(requestId);
        const questions = (Array.isArray(d.questions) ? d.questions : []) as AskQuestion[];
        this.emit({ type: 'ask_user_questions', requestId, questions });
        void this.handleQuestions(requestId, questions);
        break;
      }
      case 'ask_user_questions_cancelled':
        this.emit({ type: 'ask_user_questions_cancelled', requestId: String(d.requestId ?? '') });
        break;
      case 'todo_updated':
        this.todos = (Array.isArray(d.todos) ? d.todos : []) as TodoItem[];
        this.emit({ type: 'todo_updated', todos: this.todos });
        break;
      case 'activity':
        this.emit({ type: 'activity', summary: d.summary != null ? String(d.summary) : undefined, status: d.status != null ? String(d.status) : undefined });
        break;
      case 'error':
        this.emit({ type: 'error', message: String(d.message ?? 'Agent 执行异常') });
        this.terminal = { phase: 'FAILED' };
        this.flushWaiters();
        break;
      case 'side_session_created':
        this.emit({
          type: 'side_session_created',
          sideSessionId: Number(d.sideSessionId),
          title: d.title != null ? String(d.title) : undefined,
        });
        break;
      case 'subagent_session_created':
        this.emit({
          type: 'subagent_session_created',
          childSessionId: Number(d.childSessionId),
          title: d.title != null ? String(d.title) : undefined,
        });
        break;
      default:
        break;
    }
  }

  private async handleQuestions(requestId: string, questions: AskQuestion[]): Promise<void> {
    if (this.opts.onQuestion === 'fail' || !this.opts.askHandler) {
      this.questionFailedFlag = true;
      await this.sendCancel();
      await this.waitCancelThenSettle(QUESTION_FAIL_WAIT_MS);
      return;
    }
    const answers = await this.opts.askHandler(requestId, questions);
    if (answers === 'cancelled') {
      // 服务端已取消问答：静默收尾，不置 questionFailedFlag、不发 cancel/result
      return;
    }
    if (answers === 'fail') {
      this.questionFailedFlag = true;
      await this.sendCancel();
      await this.waitCancelThenSettle(QUESTION_FAIL_WAIT_MS);
      return;
    }
    await this.opts.ws.sendReliable({
      type: 'ask_user_questions_result',
      sessionId: this.sessionId,
      data: { requestId, answers },
    });
  }

  markReconnected(): void {
    this.reconnected = true;
    this.emit({ type: 'reconnected' });
  }

  private emit(evt: CliEvent): void {
    this.renderer.onEvent(evt);
  }

  private waitUntilSettled(timeoutMs?: number): Promise<void> {
    if (this.terminal) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.waiters.push(done);
      const timer = timeoutMs
        ? setTimeout(() => {
            if (!this.terminal) this.terminal = { phase: this.timedOutFlag ? 'CANCELLED' : 'FAILED' };
            this.flushWaiters();
          }, timeoutMs)
        : null;
    });
  }

  private async waitCancelThenSettle(timeoutMs: number): Promise<void> {
    if (!this.terminal) await this.waitUntilSettled(timeoutMs);
    if (!this.terminal) {
      this.terminal = { phase: 'CANCELLED' };
      this.flushWaiters();
    }
  }

  private flushWaiters(): void {
    const list = this.waiters.splice(0);
    for (const w of list) w();
  }

  private waitForSnapshot(timeoutMs: number): Promise<void> {
    if (this.snapshotPhase != null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.snapshotWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private finishWith(phase: string, error?: string): RunResult {
    this.terminal = { phase };
    this.flushWaiters();
    const result = this.buildResult();
    if (error) result.error = error;
    return result;
  }

  private buildResult(): RunResult {
    let status = this.terminal?.phase ?? 'FAILED';
    if (this.approvalFailedFlag) status = 'CANCELLED';
    else if (this.questionFailedFlag) status = 'CANCELLED';
    else if (this.timedOutFlag) status = 'CANCELLED';
    else if (this.cancelledByUserFlag && status !== 'COMPLETED') status = 'CANCELLED';
    const result: RunResult = {
      type: 'result',
      sessionId: this.sessionId,
      executionId: this.executionId ?? '',
      status,
      result: this.lastAssistantText,
      usage: { ...this.usage },
      toolCalls: [...this.toolCalls.values()].map((t) => {
        const copy: ToolCallRecord = { toolCallId: t.toolCallId, toolName: t.toolName, status: t.status };
        if (this.opts.includeToolIo) {
          copy.arguments = t.arguments;
          copy.result = t.result;
        }
        return copy;
      }),
      fileChanges: [...this.fileChanges],
      durationMs: Math.max(0, this.now() - this.startedAt),
    };
    if (this.reconnected) result.reconnected = true;
    this.renderer.finish?.(result);
    return result;
  }
}

export function exitCodeFor(result: RunResult, flags: { questionFailed: boolean; timedOut: boolean; interrupted: boolean; approvalFailed?: boolean }): number {
  if (flags.approvalFailed) return EXIT.APPROVAL;
  if (flags.questionFailed) return EXIT.QUESTION;
  if (flags.timedOut) return EXIT.TIMEOUT;
  if (flags.interrupted || result.status === 'CANCELLED') return EXIT.CANCELLED;
  if (result.status === 'COMPLETED') return EXIT.SUCCESS;
  if (result.status === 'FAILED') return EXIT.FAILED;
  if (result.status === 'ALREADY_RUNNING') return EXIT.GENERAL;
  return EXIT.GENERAL;
}

export async function resolveAgent(rest: RestClient, spec?: string, fallbackId?: number): Promise<AgentVO> {
  const agents = await rest.listAgents(spec && !/^\d+$/.test(spec) ? spec : undefined);
  if (spec) {
    if (/^\d+$/.test(spec)) {
      const byId = agents.find((a) => Number(a.id) === Number(spec));
      if (!byId) {
        const all = spec && /^\d+$/.test(spec) ? await rest.listAgents() : agents;
        const found = all.find((a) => Number(a.id) === Number(spec));
        if (found) return found;
        throw new CliError(`找不到 Agent id=${spec}`);
      }
      return byId;
    }
    const exact = agents.filter((a) => a.name === spec);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new CliError(`多个 Agent 名为「${spec}」，请改用 --agent <id>`);
    throw new CliError(`找不到名为「${spec}」的 Agent`);
  }
  if (fallbackId != null) {
    const byId = (await rest.listAgents()).find((a) => Number(a.id) === fallbackId);
    if (byId) return byId;
  }
  const defaults = (agents.length ? agents : await rest.listAgents()).filter((a) => a.isDefault);
  if (defaults.length === 1) return defaults[0];
  if (defaults.length > 1) throw new CliError('存在多个默认 Agent，请用 --agent 指定');
  throw new CliError('没有默认 Agent，请用 --agent <id|name> 指定');
}

export async function resolveModelId(rest: RestClient, spec?: string, fallbackId?: number): Promise<number | undefined> {
  if (!spec && fallbackId == null) return undefined;
  const models = await rest.listActiveModels();
  if (spec) {
    if (/^\d+$/.test(spec)) {
      const found = models.find((m) => Number(m.id) === Number(spec));
      if (!found) throw new CliError(`找不到模型 id=${spec}`);
      return found.id;
    }
    const exact = models.filter((m) => m.name === spec || m.modelId === spec);
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) throw new CliError(`多个模型名为「${spec}」，请改用 --model <id>`);
    throw new CliError(`找不到名为「${spec}」的模型`);
  }
  return fallbackId;
}

export function pickLatestSession(sessions: SessionVO[]): SessionVO | null {
  const active = sessions.filter((s) => (s.status ?? 'ACTIVE') === 'ACTIVE');
  if (active.length === 0) return null;
  return [...active].sort((a, b) => {
    const ta = Date.parse(a.updatedAt ?? '') || 0;
    const tb = Date.parse(b.updatedAt ?? '') || 0;
    if (tb !== ta) return tb - ta;
    return (b.id ?? 0) - (a.id ?? 0);
  })[0];
}

export type { AskAnswer };
