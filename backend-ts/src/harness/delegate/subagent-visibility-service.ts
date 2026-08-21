import type { Session } from '../deps.js';
import type { AgentExecutionContext } from '../core/agent-execution-context.js';
import { CompositeAgentEventListener } from '../core/composite-agent-event-listener.js';
import type { HarnessService } from '../core/harness-service.js';
import { SubAgentResultCollector } from './subagent-result-collector.js';
import { harnessLog } from '../log.js';
import { wsEvent } from '../../session/ws/ws-event.js';
import type { StreamingWsRegistry } from '../../session/ws/streaming-ws-registry.js';
import { ToolCallContext } from '../tool/tool-call-context.js';
import { WsStreamingEventListener, type WsListenerDeps } from '../../session/ws/ws-streaming-event-listener.js';

export interface VisibleRunResult {
  collector: SubAgentResultCollector;
  executionId: string;
}

export interface SubAgentVisibilityDeps {
  registry: StreamingWsRegistry;
  activityService: WsListenerDeps['activityService'];
  activityHeartbeat: WsListenerDeps['activityHeartbeat'];
  sessionTodoMapper: WsListenerDeps['sessionTodoMapper'];
  sessionService: WsListenerDeps['sessionService'] & {
    updatePhase(sessionId: number, phase: string): Promise<void>;
  };
  taskTerminalService: {
    finishExecution(
      sessionId: number,
      userId: number | null | undefined,
      phase: string,
      executionId: string,
      reason?: string,
    ): Promise<void>;
  };
  llmModelLookup: { findById(id: number): Promise<{ supportsVision?: number | null } | null> };
  harnessService: Pick<HarnessService, 'executePrepared'>;
}

export class SubAgentVisibilityService {
  constructor(private readonly deps: SubAgentVisibilityDeps) {}

  notifySubagentCreated(
    parentSession: Session,
    childSession: Session,
    agentType: string,
    task: string,
    toolCallId?: string | null,
  ): void {
    const userId = parentSession.userId;
    const childSessionId = childSession.id;
    if (userId == null || childSessionId == null) return;
    this.deps.registry.subscribe(userId, childSessionId);
    const boundToolCallId = toolCallId ?? ToolCallContext.getToolCallId();
    const data: Record<string, unknown> = {
      childSessionId,
      title: childSession.title || '子代理',
      agentType: agentType ?? '',
      task: task ?? '',
    };
    if (boundToolCallId) data.toolCallId = boundToolCallId;
    this.deps.registry.send(userId, wsEvent('subagent_session_created', parentSession.id ?? null, data));
    harnessLog(
      'info',
      `Notified subagent_session_created parent=${parentSession.id} child=${childSessionId} agentType=${agentType} toolCallId=${boundToolCallId ?? ''}`,
    );
  }

  ensureSubscribed(userId: number | null | undefined, childSessionId: number): void {
    if (userId == null) return;
    this.deps.registry.subscribe(userId, childSessionId);
  }

  async executeVisible(
    childSession: Session,
    subContext: AgentExecutionContext,
    skip: boolean,
    collector: SubAgentResultCollector = new SubAgentResultCollector(),
  ): Promise<VisibleRunResult> {
    const executionId = crypto.randomUUID();
    if (skip) {
      collector.completed = true;
      return { collector, executionId };
    }

    try {
      await this.runVisible(childSession, subContext, collector, executionId);
    } catch (error) {
      collector.onError(error);
    }
    return { collector, executionId };
  }

  async executeVisibleWithTimeout(
    childSession: Session,
    subContext: AgentExecutionContext,
    skip: boolean,
    childCancel: { set(value: boolean): void } | null | undefined,
    timeoutSeconds: number,
    cancelGraceSeconds: number,
  ): Promise<VisibleRunResult> {
    const run = this.executeVisible(childSession, subContext, skip);
    const first = await Promise.race([
      run.then((result) => ({ type: 'done' as const, result })),
      sleep(timeoutSeconds * 1000).then(() => ({ type: 'timeout' as const })),
    ]);
    if (first.type === 'done') return first.result;

    childCancel?.set(true);
    const second = await Promise.race([
      run.then((result) => ({ type: 'done' as const, result })),
      sleep(cancelGraceSeconds * 1000).then(() => ({ type: 'timeout' as const })),
    ]);
    if (second.type === 'done') return second.result;
    throw new Error(`子代理执行超时，取消宽限期(${cancelGraceSeconds}s)内未退出`);
  }

  async finishSubagent(
    childSessionId: number,
    userId: number | null | undefined,
    phase: string,
    executionId: string,
  ): Promise<void> {
    try {
      await this.deps.taskTerminalService.finishExecution(childSessionId, userId, phase, executionId);
    } catch (e) {
      harnessLog('warn', `Failed to finish subagent session ${childSessionId}: ${(e as Error).message}`);
      try {
        await this.deps.sessionService.updatePhase(childSessionId, phase);
        if (userId != null) {
          const data: Record<string, unknown> = { phase };
          if (executionId) data.executionId = executionId;
          this.deps.registry.send(userId, wsEvent('session_status', childSessionId, data));
        }
      } catch {
        /* best-effort */
      }
    }
  }

  private async runVisible(
    childSession: Session,
    subContext: AgentExecutionContext,
    collector: SubAgentResultCollector,
    executionId: string,
  ): Promise<void> {
    const userId = childSession.userId;
    const childSessionId = childSession.id;
    if (childSessionId == null || userId == null) {
      throw new Error('子会话缺少 id 或 userId');
    }
    await this.deps.sessionService.updatePhase(childSessionId, 'RUNNING');
    this.deps.registry.send(userId, wsEvent('session_status', childSessionId, {
      phase: 'RUNNING',
      executionId,
    }));
    const wsListener = new WsStreamingEventListener(
      this.deps,
      childSessionId,
      userId,
      executionId,
      await this.resolveSupportsVision(childSession),
    );
    const composite = CompositeAgentEventListener.of(wsListener, collector);
    try {
      await this.deps.harnessService.executePrepared(subContext, composite);
    } catch (e) {
      // 执行异常（如 LLM 重试耗尽）必须让 WS 端也收到 error 事件，
      // 前端子代理面板据此显示异常提示与重试按钮；collector 同时记录错误供上层判定 FAILED。
      composite.onError(e);
      throw e;
    }
  }

  private async resolveSupportsVision(session: Session): Promise<boolean> {
    if (session.modelId == null) return false;
    try {
      const model = await this.deps.llmModelLookup.findById(session.modelId);
      return model?.supportsVision === 1;
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
