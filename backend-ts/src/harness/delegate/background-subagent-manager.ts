import { nowSql } from '../../common/datetime.js';
import type { FileChange, SubagentExecution } from '../../session/types.js';
import type { AtomicBoolean } from '../atomic-boolean.js';
import type { AgentExecutionContext } from '../core/agent-execution-context.js';
import type { AgentLoop } from '../core/agent-loop.js';
import type { HarnessService } from '../core/harness-service.js';
import type { Session, SessionMapper, SessionService } from '../deps.js';
import { harnessLog } from '../log.js';
import type { LocalToolSessionRegistry } from '../local/local-tool-session-registry.js';
import type { AgentDefinition, AgentDefinitionRegistry } from './agent-definition-registry.js';
import { SubAgentResultCollector } from './subagent-result-collector.js';
import type { SubagentExecutionMapper } from './subagent-execution.mapper.js';
import type { SubagentInvocationService } from './subagent-invocation.service.js';
import type { SubAgentVisibilityService } from './subagent-visibility-service.js';

export const BACKGROUND_SUBAGENT_TOOLS = [
  'spawn_subagent',
  'subagent_followup',
  'check_subagent',
  'cancel_subagent',
  'wait_subagents',
] as const;

export interface BackgroundSpawnResult {
  ok: boolean;
  taskId?: number;
  childSessionId?: number;
  error?: string;
}

export interface BackgroundProgress {
  taskId: number;
  childSessionId: number | null;
  agentType: string | null;
  status: string | null;
  totalRounds: number | null;
  totalToolCalls: number | null;
  totalPromptTokens: number | null;
  totalCompletionTokens: number | null;
  recentOutput: string | null;
}

interface BackgroundResultEntry {
  executionId: number;
  resultJson: string;
}

interface RunningExecutionRefs {
  context: AgentExecutionContext;
  collector: SubAgentResultCollector;
}

export interface BackgroundSubagentManagerDeps {
  definitionRegistry: AgentDefinitionRegistry;
  harnessService: () => HarnessService;
  agentLoop: () => AgentLoop;
  sessionMapper: SessionMapper;
  sessionService: SessionService;
  subagentExecutionMapper: SubagentExecutionMapper;
  subagentInvocationService: SubagentInvocationService;
  localToolSessionRegistry: LocalToolSessionRegistry;
  visibilityService: SubAgentVisibilityService;
  agentExecutor: { submit(fn: () => void | Promise<void>): void };
  fileChangeRepo?: {
    listBySession(sessionId: number): Promise<FileChange[]>;
    insert(change: FileChange): Promise<number>;
  };
}

export class BackgroundSubagentManager {
  private readonly runningByParent = new Map<number, Set<number>>();
  private readonly resultsByParent = new Map<number, BackgroundResultEntry[]>();
  private readonly runningRefsByTask = new Map<number, RunningExecutionRefs>();

  constructor(private readonly deps: BackgroundSubagentManagerDeps) {}

  async spawn(
    parentSessionId: number,
    agentType: string,
    task: string,
    parentToolCallId: string,
  ): Promise<BackgroundSpawnResult> {
    const parentSession = await this.deps.sessionMapper.selectById(parentSessionId);
    if (!parentSession) return { ok: false, error: '父会话不存在: ' + parentSessionId };
    const definition = this.deps.definitionRegistry.getDefinition(agentType);
    if (!definition) {
      return {
        ok: false,
        error: '未知的子代理类型: ' + agentType,
      };
    }

    const childTitle = '后台子代理(' + agentType + '): ' + (task.length > 40 ? task.slice(0, 40) + '...' : task);
    const { child, execution } = await this.deps.subagentInvocationService.createBackground(
      parentSession, agentType, task, childTitle, parentToolCallId,
    );
    if (execution.id == null || child.id == null) {
      return { ok: false, error: '后台子代理执行记录创建失败' };
    }

    this.deps.visibilityService.notifySubagentCreated(parentSession, child, agentType, task, parentToolCallId);
    const submitted = await this.submitExecution(parentSession, child, execution, definition);
    if (!submitted.ok) return submitted;

    return { ok: true, taskId: execution.id, childSessionId: child.id };
  }

  async followup(
    parentSessionId: number,
    childSessionId: number,
    task: string,
    parentToolCallId: string,
  ): Promise<BackgroundSpawnResult & { corrected?: boolean }> {
    const parentSession = await this.deps.sessionMapper.selectById(parentSessionId);
    if (!parentSession) return { ok: false, error: '父会话不存在: ' + parentSessionId };
    const childSession = await this.deps.sessionMapper.selectById(childSessionId);
    if (!childSession) return { ok: false, error: '子代理会话不存在: ' + childSessionId };
    if (childSession.sessionType !== 'SUBAGENT') {
      return { ok: false, error: '会话 ' + childSessionId + ' 不是子代理会话，无法追问' };
    }
    if (childSession.parentSessionId !== parentSessionId) {
      return { ok: false, error: '子代理会话 ' + childSessionId + ' 不属于当前会话，无法追问' };
    }
    const agentType = await this.resolveAgentType(childSessionId);
    if (!agentType) return { ok: false, error: '子代理会话 ' + childSessionId + ' 无执行记录，无法追问' };
    const definition = this.deps.definitionRegistry.getDefinition(agentType);
    if (!definition) return { ok: false, error: '未知的子代理类型: ' + agentType };

    const running = await this.deps.subagentExecutionMapper.findRunningByChildSessionId(childSessionId);
    let corrected = false;
    let correctionNotice: string | null = null;
    if (running != null) {
      if (running.parentSessionId !== parentSessionId) {
        return { ok: false, error: '运行中的子代理执行不属于当前会话，无法纠偏' };
      }
      const interrupted = await this.interruptRunningForCorrection(running, childSession);
      if (!interrupted.ok) return interrupted;
      corrected = true;
      correctionNotice = '上一轮子代理执行已因新的追问/纠偏消息中断，以下是新的纠偏要求。';
    }

    const created = await this.deps.subagentInvocationService.createFollowupWithOptions(
      parentSession, childSessionId, agentType, task, parentToolCallId, correctionNotice,
    );
    if (!created) return { ok: false, error: '子代理会话 ' + childSessionId + ' 正在执行中，无法追问' };
    // 先广播 followup 事件再提交执行：前端先补插新轮 USER 消息，流式增量才不会续接到上一回合
    this.deps.visibilityService.notifySubagentFollowup(
      parentSession, created.child, agentType, task,
      created.execution.executionStartMessageId, corrected,
    );
    const submitted = await this.submitExecution(parentSession, created.child, created.execution, definition);
    if (!submitted.ok) return submitted;
    return { ok: true, taskId: created.execution.id, childSessionId, corrected };
  }

  hasRunning(parentSessionId: number | null | undefined): boolean {
    if (parentSessionId == null) return false;
    const set = this.runningByParent.get(parentSessionId);
    return set != null && set.size > 0;
  }

  hasPendingResults(parentSessionId: number | null | undefined): boolean {
    if (parentSessionId == null) return false;
    const entries = this.resultsByParent.get(parentSessionId);
    return entries != null && entries.length > 0;
  }

  clearResults(parentSessionId: number | null | undefined): void {
    if (parentSessionId == null) return;
    this.resultsByParent.delete(parentSessionId);
  }

  async waitForAll(
    parentSessionId: number | null | undefined,
    cancelFlag?: AtomicBoolean | null,
    timeoutMs?: number | null,
  ): Promise<{ completed: boolean; timedOut: boolean }> {
    if (parentSessionId == null) return { completed: true, timedOut: false };
    const deadline = timeoutMs != null ? Date.now() + timeoutMs : null;
    while (true) {
      if (cancelFlag?.get()) return { completed: false, timedOut: false };
      if (!this.hasRunning(parentSessionId)) return { completed: true, timedOut: false };
      if (deadline != null) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { completed: false, timedOut: true };
        await sleep(Math.min(300, remaining));
      } else {
        await sleep(300);
      }
    }
  }

  async consumeResults(parentSessionId: number | null | undefined): Promise<Record<string, string>> {
    if (parentSessionId == null) return {};
    const entries = this.resultsByParent.get(parentSessionId);
    if (!entries || entries.length === 0) return {};
    this.resultsByParent.delete(parentSessionId);
    const result: Record<string, string> = {};
    for (const entry of entries) {
      result[String(entry.executionId)] = entry.resultJson;
    }
    return result;
  }

  async progress(parentSessionId: number, taskId: number | null): Promise<BackgroundProgress[] | BackgroundProgress | null> {
    if (taskId != null) {
      const execution = await this.deps.subagentExecutionMapper.findById(taskId);
      if (!execution || execution.parentSessionId !== parentSessionId || !isAsyncInvocation(execution.invocationType)) {
        return null;
      }
      return this.snapshot(taskId);
    }
    const executions = await this.deps.subagentExecutionMapper.listByParent(parentSessionId);
    const backgrounds = executions.filter((e) => isAsyncInvocation(e.invocationType));
    const result: BackgroundProgress[] = [];
    for (const execution of backgrounds) {
      if (execution.id == null) continue;
      const snap = await this.snapshot(execution.id);
      if (snap) result.push(snap);
    }
    return result;
  }

  async cancel(parentSessionId: number, taskId: number): Promise<Record<string, unknown>> {
    const execution = await this.deps.subagentExecutionMapper.findById(taskId);
    if (!execution || execution.parentSessionId !== parentSessionId || !isAsyncInvocation(execution.invocationType)) {
      return { success: false, error: '后台子代理不存在或不属于当前会话: ' + taskId };
    }
    if (isTerminal(execution.status)) {
      return {
        success: execution.status === 'CANCELLED',
        cancelled: execution.status === 'CANCELLED',
        task_id: taskId,
        status: execution.status,
      };
    }
    if (execution.childSessionId != null) {
      const loop = this.deps.agentLoop();
      const flag = loop.getCancelFlag(execution.childSessionId) ?? loop.registerCancelFlag(execution.childSessionId);
      flag.set(true);
    }
    const reachedTerminal = await this.waitTerminal(taskId, 30_000);
    const current = await this.deps.subagentExecutionMapper.findById(taskId);
    const status = current?.status ?? 'CANCELLED';
    const response: Record<string, unknown> = {
      success: status === 'CANCELLED',
      cancelled: status === 'CANCELLED',
      task_id: taskId,
      status,
    };
    if (!reachedTerminal) {
      response.error = '取消请求已发出，但子代理未在宽限期内结束';
    }
    return response;
  }

  async cancelAllForParent(parentSessionId: number): Promise<void> {
    const executions = await this.deps.subagentExecutionMapper.listByParent(parentSessionId);
    const backgrounds = executions.filter((e) => isAsyncInvocation(e.invocationType) && !isTerminal(e.status));
    for (const execution of backgrounds) {
      if (execution.childSessionId != null) {
        const loop = this.deps.agentLoop();
        const flag = loop.getCancelFlag(execution.childSessionId) ?? loop.registerCancelFlag(execution.childSessionId);
        flag.set(true);
      }
      if (execution.id != null) {
        await this.deps.subagentExecutionMapper.updateById(execution.id, {
          status: 'CANCELLED',
          result: '后台子代理已随父会话取消',
          deliveryStatus: 'SUPPRESSED',
          completedAt: nowSql(),
        });
      }
      if (execution.childSessionId != null) {
        const child = await this.deps.sessionMapper.selectById(execution.childSessionId);
        await this.deps.visibilityService.finishSubagent(
          execution.childSessionId, child?.userId, 'CANCELLED', '',
        );
      }
    }
  }

  private async snapshot(taskId: number): Promise<BackgroundProgress | null> {
    const execution = await this.deps.subagentExecutionMapper.findById(taskId);
    if (!execution) return null;
    const terminal = isTerminal(execution.status);
    const recentOutput = terminal
      ? truncate(execution.result ?? '', 2000) || null
      : await this.recentOutput(execution.childSessionId ?? null);
    // 运行中优先读内存实时引用（context/collector），DB 里的统计值要到终态才落库
    const refs = terminal ? undefined : this.runningRefsByTask.get(taskId);
    return {
      taskId,
      childSessionId: execution.childSessionId ?? null,
      agentType: execution.agentType ?? null,
      status: execution.status ?? null,
      totalRounds: refs ? refs.context.currentRound : execution.totalRounds ?? null,
      totalToolCalls: refs ? refs.collector.toolCallCount : execution.totalToolCalls ?? null,
      // 运行中 totalUsage 由 AgentLoop 每轮流式 onComplete 实时累计（context.addUsage），
      // 终态 onMessageEnd 传入的也是同一累计对象，运行中读取与终态落库值天然一致
      totalPromptTokens: refs ? refs.context.totalUsage?.promptTokens ?? 0 : execution.totalPromptTokens ?? null,
      totalCompletionTokens: refs ? refs.context.totalUsage?.completionTokens ?? 0 : execution.totalCompletionTokens ?? null,
      recentOutput,
    };
  }

  private async recentOutput(childSessionId: number | null): Promise<string | null> {
    if (childSessionId == null) return null;
    try {
      const messages = this.deps.sessionService.getMessages
        ? await this.deps.sessionService.getMessages(childSessionId)
        : [];
      // 后台代理运行中的 ASSISTANT 消息常同时带工具调用（toolCalls 非空），
      // 只看 content 是否非空，避免运行中 recentOutput 恒为 null
      const last = [...messages].reverse().find((m) => m.role === 'ASSISTANT' && m.content);
      const content = last?.content;
      if (content == null || content.trim() === '') return null;
      return truncate(content, 2000);
    } catch (e) {
      harnessLog('warn', `Failed to load recent subagent output for session ${childSessionId}: ${(e as Error).message}`);
      return null;
    }
  }

  private async waitTerminal(taskId: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const execution = await this.deps.subagentExecutionMapper.findById(taskId);
      if (!execution || isTerminal(execution.status)) return true;
      await sleep(300);
    }
    return false;
  }

  private async waitTerminalAndUntracked(taskId: number, parentSessionId: number | null | undefined, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const execution = await this.deps.subagentExecutionMapper.findById(taskId);
      const terminal = !execution || isTerminal(execution.status);
      const tracked = parentSessionId != null && this.runningByParent.get(parentSessionId)?.has(taskId) === true;
      if (terminal && !tracked) return true;
      await sleep(300);
    }
    return false;
  }

  private async resolveAgentType(childSessionId: number): Promise<string | null> {
    const row = await this.deps.subagentExecutionMapper.findByChildSessionId(childSessionId);
    return row?.agentType ?? null;
  }

  private async submitExecution(
    parentSession: Session,
    child: Session,
    execution: SubagentExecution,
    definition: AgentDefinition,
  ): Promise<BackgroundSpawnResult> {
    if (execution.id == null || child.id == null || execution.parentSessionId == null) {
      return { ok: false, error: '后台子代理执行记录创建失败' };
    }
    this.trackRunning(execution.parentSessionId, execution.id);
    if (parentSession.executionMode?.toUpperCase() === 'LOCAL' && parentSession.userId != null) {
      this.deps.localToolSessionRegistry.setUserForSession(child.id, parentSession.userId);
    }
    try {
      this.deps.agentExecutor.submit(() => this.runBackground(execution, child, definition));
      return { ok: true, taskId: execution.id, childSessionId: child.id };
    } catch (e) {
      this.untrackRunning(execution.parentSessionId, execution.id);
      const message = '后台子代理执行提交失败: ' + ((e as Error)?.message ?? 'agent executor rejected');
      await this.deps.subagentExecutionMapper.updateById(execution.id, {
        status: 'FAILED',
        result: message,
        deliveryStatus: 'SUPPRESSED',
        completedAt: nowSql(),
      });
      await this.deps.visibilityService.finishSubagent(child.id, child.userId, 'FAILED', '');
      // 必须向父代理投递失败结果：否则 waitForAll 正常退出且无待收结果，
      // 父代理上下文永远不知道这个子代理失败了
      const entries = this.resultsByParent.get(execution.parentSessionId) ?? [];
      entries.push({
        executionId: execution.id,
        resultJson: JSON.stringify({
          success: false,
          cancelled: false,
          task_id: execution.id,
          child_session_id: child.id,
          agent_type: execution.agentType ?? '',
          status: 'FAILED',
          result: message,
          error: message,
          rounds: 0,
          tool_calls: 0,
        }),
      });
      this.resultsByParent.set(execution.parentSessionId, entries);
      return { ok: false, error: '后台子代理执行提交失败，请稍后重试' };
    }
  }

  private async interruptRunningForCorrection(
    execution: SubagentExecution,
    childSession: Session,
  ): Promise<BackgroundSpawnResult> {
    if (execution.id == null || execution.childSessionId == null) {
      return { ok: false, error: '运行中的子代理执行记录缺少 ID' };
    }
    await this.deps.subagentExecutionMapper.updateById(execution.id, { deliveryStatus: 'SUPPRESSED' });
    const loop = this.deps.agentLoop();
    const flag = loop.getCancelFlag(execution.childSessionId) ?? loop.registerCancelFlag(execution.childSessionId);
    flag.set(true);
    const settled = await this.waitTerminalAndUntracked(execution.id, execution.parentSessionId, 30_000);
    if (!settled) {
      await this.deps.subagentExecutionMapper.updateById(execution.id, { deliveryStatus: 'PENDING' });
      return { ok: false, error: '纠偏请求已发出，但子代理未在 30 秒内结束，未创建新的追问任务' };
    }
    // L-13：check-then-act——等待期间子代理可能已正常收尾（COMPLETED 且结果已 DELIVERED），
    // 必须按 DB 最新状态决定是否改写 CANCELLED，且仅 RUNNING/RECOVERING 可置 CANCELLED。
    const latest = execution.id != null ? await this.deps.subagentExecutionMapper.findById(execution.id) : null;
    if (latest == null || latest.status === 'RUNNING' || latest.status === 'RECOVERING') {
      await this.deps.subagentExecutionMapper.updateById(execution.id, {
        status: 'CANCELLED',
        result: '后台子代理因纠偏中断',
        deliveryStatus: 'SUPPRESSED',
        completedAt: nowSql(),
      });
    } else if (latest.deliveryStatus === 'PENDING') {
      // 已终态但结果未交付：纠偏打断了交付，保留终态结果并禁止交付。
      await this.deps.subagentExecutionMapper.updateById(execution.id, { deliveryStatus: 'SUPPRESSED' });
    }
    // 清理纠偏注册的 cancel flag，避免泄漏影响后续执行。
    try { loop.removeCancelFlag(execution.childSessionId); } catch { /* best-effort */ }
    return { ok: true, taskId: execution.id, childSessionId: execution.childSessionId };
  }

  private trackRunning(parentSessionId: number, executionId: number): void {
    const set = this.runningByParent.get(parentSessionId) ?? new Set<number>();
    set.add(executionId);
    this.runningByParent.set(parentSessionId, set);
  }

  private untrackRunning(parentSessionId: number, executionId: number): void {
    const set = this.runningByParent.get(parentSessionId);
    if (!set) return;
    set.delete(executionId);
    if (set.size === 0) this.runningByParent.delete(parentSessionId);
  }

  private async runBackground(
    execution: SubagentExecution,
    childSession: Session,
    definition: AgentDefinition,
  ): Promise<void> {
    const childSessionId = childSession.id!;
    const parentSessionId = execution.parentSessionId!;
    let runExecutionId = '';
    try {
      // 排队期间可能已被取消或父会话已终结：启动前二次校验，避免无谓执行产生副作用
      if (execution.id != null) {
        const latest = await this.deps.subagentExecutionMapper.findById(execution.id);
        if (latest && isTerminal(latest.status)) return;
      }
      const parent = await this.deps.sessionMapper.selectById(parentSessionId);
      if (!parent || isTerminal(parent.phase)) {
        await this.markCancelledSuppressed(execution, childSession);
        return;
      }

      const loop = this.deps.agentLoop();
      const parentCancel = loop.getCancelFlag(parentSessionId);
      const childCancel = loop.getCancelFlag(childSessionId) ?? loop.registerCancelFlag(childSessionId);
      if (parentCancel?.get()) childCancel.set(true);

      if (childCancel.get()) {
        await this.deps.visibilityService.finishSubagent(childSessionId, childSession.userId, 'CANCELLED', '');
        await this.onCompletedCancelled(execution, childSession);
        return;
      }

      const subContext = await this.buildSubContext(childSession, definition);
      if (parentCancel) {
        subContext.cancelFlag = parentCancel;
        if (parentCancel.get()) childCancel.set(true);
      }

      const collector = new SubAgentResultCollector();
      if (execution.id != null) {
        this.runningRefsByTask.set(execution.id, { context: subContext, collector });
      }

      let runResult;
      try {
        runResult = await this.deps.visibilityService.executeVisible(childSession, subContext, childCancel.get(), collector);
      } finally {
        loop.removeCancelFlag(childSessionId);
        this.deps.localToolSessionRegistry.removeSession?.(childSessionId);
      }

      runExecutionId = runResult.executionId;
      const cancelled = childCancel.get() || parentCancel?.get() === true;
      let resultText: string;
      let status: string;
      if (cancelled) {
        resultText = '后台子代理已取消';
        status = 'CANCELLED';
      } else if (collector.error == null) {
        resultText = collector.getResult();
        if (!resultText) {
          resultText = '(子代理未产生文本输出)';
          await this.deps.sessionService.saveMessage(
            childSessionId, 'ASSISTANT', resultText, collector.getThinkingContent(), null, null,
            collector.totalUsage?.totalTokens ?? 0, subContext.modelConfig?.id ?? null,
          );
        }
        status = 'COMPLETED';
      } else {
        resultText = '后台子代理执行失败: ' + ((collector.error as Error)?.message ?? '子代理执行异常');
        status = 'FAILED';
        await this.deps.sessionService.saveMessage(
          childSessionId, 'ASSISTANT', resultText, null, null, null, 0,
          subContext.modelConfig?.id ?? null, JSON.stringify({ subagentTerminalStatus: 'FAILED' }),
        );
      }

      if (execution.id != null) {
        await this.deps.subagentExecutionMapper.updateById(execution.id, {
          status,
          result: resultText,
          totalRounds: subContext.currentRound,
          totalPromptTokens: collector.totalUsage?.promptTokens ?? 0,
          totalCompletionTokens: collector.totalUsage?.completionTokens ?? 0,
          totalToolCalls: collector.toolCallCount,
          completedAt: nowSql(),
        });
      }
      await this.deps.visibilityService.finishSubagent(childSessionId, childSession.userId, status, runExecutionId);
      await this.onCompleted(execution, childSession, status, resultText, subContext, collector);
    } catch (e) {
      const message = '后台子代理执行失败: ' + ((e as Error)?.message ?? '子代理执行异常');
      await this.failExecution(execution, childSession, message, runExecutionId);
    } finally {
      if (execution.id != null) this.runningRefsByTask.delete(execution.id);
      this.untrackRunning(parentSessionId, execution.id ?? -1);
      this.deps.agentLoop().removeCancelFlag(childSessionId);
    }
  }

  private async markCancelledSuppressed(
    execution: SubagentExecution,
    childSession: Session,
  ): Promise<void> {
    if (execution.id == null) return;
    await this.deps.subagentExecutionMapper.updateById(execution.id, {
      status: 'CANCELLED',
      result: '后台子代理已随父会话取消',
      deliveryStatus: 'SUPPRESSED',
      completedAt: nowSql(),
    });
    await this.deps.visibilityService.finishSubagent(childSession.id!, childSession.userId, 'CANCELLED', '');
  }

  private async onCompletedCancelled(
    execution: SubagentExecution,
    childSession: Session,
  ): Promise<void> {
    const resultText = '后台子代理已取消';
    if (execution.id != null) {
      await this.deps.subagentExecutionMapper.updateById(execution.id, {
        status: 'CANCELLED',
        result: resultText,
        completedAt: nowSql(),
      });
    }
    await this.onCompleted(execution, childSession, 'CANCELLED', resultText, null, null);
  }

  private async onCompleted(
    execution: SubagentExecution,
    childSession: Session,
    status: string,
    resultText: string,
    subContext: AgentExecutionContext | null,
    collector: SubAgentResultCollector | null,
  ): Promise<void> {
    const parentId = execution.parentSessionId!;
    if (execution.id == null) return;
    const latest = await this.deps.subagentExecutionMapper.findById(execution.id);
    if (latest?.deliveryStatus === 'SUPPRESSED') {
      if (latest.status === 'CANCELLED') {
        await this.deps.subagentExecutionMapper.updateById(execution.id, {
          result: latest.result ?? resultText,
          completedAt: latest.completedAt ?? nowSql(),
        });
      }
      return;
    }
    const parent = await this.deps.sessionMapper.selectById(parentId);
    if (!parent || isTerminal(parent.phase)) {
      await this.deps.subagentExecutionMapper.updateById(execution.id, { deliveryStatus: 'SUPPRESSED' });
      return;
    }
    const resultJson = JSON.stringify(this.buildResultPayload(execution, status, resultText, subContext, collector));
    const entries = this.resultsByParent.get(parentId) ?? [];
    entries.push({ executionId: execution.id, resultJson });
    this.resultsByParent.set(parentId, entries);
    await this.persistCompletionNotice(execution, childSession, status, resultText);
    await this.deps.subagentExecutionMapper.updateById(execution.id, { deliveryStatus: 'DELIVERED' });
  }

  private buildResultPayload(
    execution: SubagentExecution,
    status: string,
    resultText: string,
    subContext: AgentExecutionContext | null,
    collector: SubAgentResultCollector | null,
  ): Record<string, unknown> {
    const success = status === 'COMPLETED';
    const cancelled = status === 'CANCELLED';
    const payload: Record<string, unknown> = {
      success,
      cancelled,
      task_id: execution.id,
      child_session_id: execution.childSessionId,
      agent_type: execution.agentType ?? '',
      status,
      result: resultText,
      rounds: subContext?.currentRound ?? 0,
      tool_calls: collector?.toolCallCount ?? 0,
    };
    if (!success) payload.error = resultText;
    if (collector?.totalUsage) {
      payload.usage = {
        prompt_tokens: collector.totalUsage.promptTokens,
        completion_tokens: collector.totalUsage.completionTokens,
        total_tokens: collector.totalUsage.totalTokens,
      };
    }
    return payload;
  }

  private async persistCompletionNotice(
    execution: SubagentExecution,
    childSession: Session,
    status: string,
    resultText: string,
  ): Promise<void> {
    const parentId = execution.parentSessionId!;
    const summary = truncate(resultText, 2000);
    const content = `后台子代理（${execution.agentType ?? ''}）${statusLabel(status)}：${summary}`;
    const metadata = JSON.stringify({
      backgroundSubagentCompletion: {
        childSessionId: childSession.id,
        executionId: execution.id,
        status,
        agentType: execution.agentType ?? null,
      },
    });
    const saved = await this.deps.sessionService.saveMessage(
      parentId, 'ASSISTANT', content, null, null, null, 0, null, metadata,
    );
    if (saved.id != null) {
      await this.copyFileChanges(childSession.id!, saved.id, parentId);
    }
  }

  private async copyFileChanges(childSessionId: number, noticeMessageId: number, parentSessionId: number): Promise<void> {
    const repo = this.deps.fileChangeRepo;
    if (!repo) return;
    try {
      const changes = await repo.listBySession(childSessionId);
      for (const change of changes) {
        await repo.insert({
          ...change,
          id: undefined,
          messageId: noticeMessageId,
          sessionId: parentSessionId,
        });
      }
    } catch (e) {
      harnessLog('warn', `Failed to aggregate file changes for background subagent ${childSessionId}: ${(e as Error).message}`);
    }
  }

  private async failExecution(
    execution: SubagentExecution,
    childSession: Session,
    message: string,
    runExecutionId: string,
  ): Promise<void> {
    const parentId = execution.parentSessionId!;
    try {
      if (execution.id != null) {
        const latest = await this.deps.subagentExecutionMapper.findById(execution.id);
        if (latest?.deliveryStatus === 'SUPPRESSED') return;
      }
      if (execution.id != null) {
        await this.deps.subagentExecutionMapper.updateById(execution.id, {
          status: 'FAILED',
          result: message,
          completedAt: nowSql(),
        });
      }
      await this.deps.visibilityService.finishSubagent(childSession.id!, childSession.userId, 'FAILED', runExecutionId);

      const parent = await this.deps.sessionMapper.selectById(parentId);
      if (!parent || isTerminal(parent.phase)) {
        if (execution.id != null) {
          await this.deps.subagentExecutionMapper.updateById(execution.id, { deliveryStatus: 'SUPPRESSED' });
        }
        return;
      }
      const entries = this.resultsByParent.get(parentId) ?? [];
      entries.push({
        executionId: execution.id ?? 0,
        resultJson: JSON.stringify({
          success: false,
          cancelled: false,
          task_id: execution.id,
          child_session_id: childSession.id,
          agent_type: execution.agentType ?? '',
          status: 'FAILED',
          result: message,
          error: message,
        }),
      });
      this.resultsByParent.set(parentId, entries);
      await this.persistCompletionNotice(execution, childSession, 'FAILED', message);
      if (execution.id != null) {
        await this.deps.subagentExecutionMapper.updateById(execution.id, { deliveryStatus: 'DELIVERED' });
      }
    } catch (e) {
      harnessLog('error', `Failed to finalize background subagent execution ${execution.id}`, e);
    }
  }

  async buildSubContext(
    childSession: Session,
    definition: AgentDefinition,
  ): Promise<AgentExecutionContext> {
    const ctx = await this.deps.harnessService().buildContext(childSession.id!);
    if (definition.systemPromptOverride) ctx.systemPrompt = definition.systemPromptOverride;
    ctx.agentName = definition.name + '-agent';
    const excluded = new Set(['delegate', 'delegate_followup', ...BACKGROUND_SUBAGENT_TOOLS, ...(definition.excludedToolNames ?? [])]);
    const allowed = definition.allowedToolNames;
    ctx.tools = ctx.tools.filter((t) => {
      if (excluded.has(t.getName())) return false;
      if (allowed && allowed.length > 0 && !allowed.includes(t.getName())) return false;
      return true;
    });
    ctx.availableSkillNames = [];
    ctx.availableSkillDocs.clear();
    ctx.preparedRequest = null;
    return ctx;
  }
}

function isTerminal(status: string | null | undefined): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

function isAsyncInvocation(invocationType: string | null | undefined): boolean {
  return invocationType === 'BACKGROUND' || invocationType === 'FOLLOWUP';
}

function statusLabel(status: string): string {
  if (status === 'COMPLETED') return '已完成';
  if (status === 'FAILED') return '执行失败';
  if (status === 'CANCELLED') return '已取消';
  return status;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
