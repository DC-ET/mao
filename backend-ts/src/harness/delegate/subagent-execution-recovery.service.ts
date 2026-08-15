import type { SubagentExecution } from '../../session/types.js';
import type { AgentLoop } from '../core/agent-loop.js';
import type { Message, SessionCompactionService, SessionMapper, SessionService } from '../deps.js';
import type { LocalToolSessionRegistry } from '../local/local-tool-session-registry.js';
import { harnessLog } from '../log.js';
import type { DelegateTool } from '../tool/impl/delegate-tool.js';
import type { AgentDefinitionRegistry } from './agent-definition-registry.js';
import type { SubagentExecutionMapper } from './subagent-execution.mapper.js';
import type { SubAgentVisibilityService } from './subagent-visibility-service.js';

export class SubagentExecutionRecoveryService {
  constructor(
    private readonly executionMapper: SubagentExecutionMapper,
    private readonly sessionMapper: SessionMapper,
    private readonly sessionService: SessionService,
    private readonly compactionService: SessionCompactionService,
    private readonly definitionRegistry: AgentDefinitionRegistry,
    private readonly delegateTool: DelegateTool,
    private readonly agentLoop: AgentLoop,
    private readonly visibilityService: SubAgentVisibilityService,
    private readonly localRegistry: LocalToolSessionRegistry,
    private readonly timeoutSeconds = 3600,
    private readonly cancelGraceSeconds = 30,
  ) {}

  async recover(execution: SubagentExecution): Promise<void> {
    if (execution.id == null || execution.childSessionId == null) return;
    if (!['RUNNING', 'RECOVERING'].includes(execution.status ?? '')) return;
    const parent = execution.parentSessionId != null
      ? await this.sessionMapper.selectById(execution.parentSessionId) : null;
    const child = await this.sessionMapper.selectById(execution.childSessionId);
    if (!parent || isTerminal(parent.phase)) {
      await this.executionMapper.updateTerminal(execution.id, {
        status: 'CANCELLED', result: '子代理已随父会话取消', completedAt: nowSql(),
      });
      return;
    }
    if (!child) {
      await this.fail(execution, '子代理恢复失败：原子会话不存在');
      return;
    }
    const definition = this.definitionRegistry.getDefinition(execution.agentType ?? '');
    if (!definition) {
      await this.fail(execution, `子代理恢复失败：未知的子代理类型 ${execution.agentType ?? ''}`);
      return;
    }
    await this.executionMapper.claimRecovering(execution.id);
    harnessLog('info', `subagent_recovery_start executionId=${execution.id} parent=${execution.parentSessionId} child=${child.id} invocation=${execution.invocationType ?? 'legacy'}`);
    try {
      const existingFinal = await this.findPersistedFinal(execution);
      if (existingFinal) {
        const status = terminalStatus(existingFinal.metadata);
        await this.executionMapper.updateTerminal(execution.id, {
          status, result: existingFinal.content ?? '(子代理未产生文本输出)',
          finalMessageId: existingFinal.id, completedAt: nowSql(),
        });
        await this.sessionService.updatePhase(child.id!, status);
        return;
      }
      const compaction = await this.compactionService.loadValidated(child.id!);
      const boundary = this.compactionService.boundaryOf(compaction);
      await this.sessionService.cleanupIncompleteTailAfterId?.(child.id!, boundary);
      await this.sessionService.updatePhase(child.id!, 'RESUMING');
      const context = await this.delegateTool.buildSubContext(child, definition);
      const cancel = this.agentLoop.registerCancelFlag(child.id!);
      context.cancelFlag = cancel;
      const deadline = startedDeadline(execution.startedAt, this.timeoutSeconds);
      if (deadline <= Date.now()) throw new Error('子代理恢复失败：原委派执行已超时');
      if (child.executionMode?.toUpperCase() === 'LOCAL') {
        if (parent.userId != null) {
          this.localRegistry.setUserForSession(parent.id!, parent.userId);
          this.localRegistry.setUserForSession(child.id!, parent.userId);
        }
        const connected = await this.waitForLocal(child.id!, deadline, cancel);
        if (!connected) throw new Error('子代理恢复失败：LOCAL 客户端未在恢复超时内连接');
      }
      const remainingSeconds = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
      const run = await this.visibilityService.executeVisibleWithTimeout(
        child, context, false, cancel, remainingSeconds, this.cancelGraceSeconds,
      );
      const collector = run.collector;
      const cancelled = cancel.get();
      let status = cancelled ? 'CANCELLED' : collector.error ? 'FAILED' : 'COMPLETED';
      let result = collector.getResult();
      if (!result) {
        result = status === 'COMPLETED'
          ? '(子代理未产生文本输出)'
          : `子代理恢复失败：${collector.error instanceof Error ? collector.error.message : '子代理执行异常'}`;
        await this.sessionService.saveMessage(
          child.id!, 'ASSISTANT', result, collector.getThinkingContent(), null, null, 0,
          context.modelConfig?.id ?? null,
          status === 'FAILED' ? JSON.stringify({ subagentTerminalStatus: 'FAILED' }) : null,
        );
      }
      const final = await this.findLastAssistant(child.id!, execution.executionStartMessageId ?? 0);
      await this.executionMapper.updateTerminal(execution.id, {
        status, result, finalMessageId: final?.id ?? null,
        totalRounds: context.currentRound,
        totalPromptTokens: collector.totalUsage?.promptTokens ?? 0,
        totalCompletionTokens: collector.totalUsage?.completionTokens ?? 0,
        totalToolCalls: collector.toolCallCount,
        completedAt: nowSql(),
      });
      await this.visibilityService.finishSubagent(child.id!, parent.userId, status, run.executionId);
    } catch (error) {
      await this.fail(execution, `子代理恢复失败：${(error as Error).message}`);
      await this.visibilityService.finishSubagent(child.id!, parent.userId, 'FAILED', '');
    } finally {
      this.agentLoop.removeCancelFlag(child.id!);
      this.localRegistry.removeSession?.(child.id!);
      harnessLog('info', `subagent_recovery_complete executionId=${execution.id}`);
    }
  }

  private async findPersistedFinal(execution: SubagentExecution): Promise<Message | null> {
    if (execution.finalMessageId != null) {
      const messages = await this.sessionService.getMessagesAfterId(execution.childSessionId!, execution.finalMessageId - 1);
      return messages.find((message) => message.id === execution.finalMessageId && message.role === 'ASSISTANT') ?? null;
    }
    if (execution.executionStartMessageId == null) return null;
    const messages = await this.sessionService.getMessagesAfterId(execution.childSessionId!, execution.executionStartMessageId);
    return [...messages].reverse().find((message) => message.role === 'ASSISTANT' && !message.toolCalls) ?? null;
  }

  private async findLastAssistant(childSessionId: number, startMessageId: number): Promise<Message | null> {
    const messages = await this.sessionService.getMessagesAfterId(childSessionId, startMessageId);
    return [...messages].reverse().find((message) => message.role === 'ASSISTANT' && !message.toolCalls) ?? null;
  }

  private async waitForLocal(
    childSessionId: number,
    deadline: number,
    cancel: { get(): boolean },
  ): Promise<boolean> {
    while (!cancel.get() && Date.now() < deadline) {
      if (await this.localRegistry.isConnected(childSessionId)) return true;
      await sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
    }
    return false;
  }

  private async fail(execution: SubagentExecution, message: string): Promise<void> {
    if (execution.id == null) return;
    const childId = execution.childSessionId;
    if (childId != null) {
      const existing = await this.findLastAssistant(childId, execution.executionStartMessageId ?? 0);
      if (!existing) {
        await this.sessionService.saveMessage(
          childId, 'ASSISTANT', message, null, null, null, 0, null,
          JSON.stringify({ subagentTerminalStatus: 'FAILED' }),
        );
      }
      await this.sessionService.updatePhase(childId, 'FAILED');
    }
    await this.executionMapper.updateTerminal(execution.id, {
      status: 'FAILED', result: message, completedAt: nowSql(),
    });
  }
}

function terminalStatus(metadata: string | null | undefined): 'COMPLETED' | 'FAILED' | 'CANCELLED' {
  if (!metadata) return 'COMPLETED';
  try {
    const status = (JSON.parse(metadata) as { subagentTerminalStatus?: string }).subagentTerminalStatus;
    return status === 'FAILED' || status === 'CANCELLED' ? status : 'COMPLETED';
  } catch {
    return 'COMPLETED';
  }
}

function startedDeadline(startedAt: string | null | undefined, timeoutSeconds: number): number {
  const started = startedAt ? new Date(startedAt.replace(' ', 'T') + 'Z').getTime() : Date.now();
  return (Number.isFinite(started) ? started : Date.now()) + timeoutSeconds * 1000;
}

function isTerminal(phase: string | null | undefined): boolean {
  return phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
}

function nowSql(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
