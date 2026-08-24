import { BaseTool } from '../tool.js';
import { nowSql } from '../../../common/datetime.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import type { AgentDefinitionRegistry } from '../../delegate/agent-definition-registry.js';
import type { HarnessService } from '../../core/harness-service.js';
import type { AgentLoop } from '../../core/agent-loop.js';
import type { MessageMapper, Session, SessionCompactionService, SessionMapper, SessionService } from '../../deps.js';
import type { SubagentExecutionMapper } from '../../delegate/subagent-execution.mapper.js';
import type { LocalToolSessionRegistry } from '../../local/local-tool-session-registry.js';
import type { SubAgentVisibilityService } from '../../delegate/subagent-visibility-service.js';
import type { SubAgentResultCollector } from '../../delegate/subagent-result-collector.js';
import type { SubagentExecution } from '../../../session/types.js';
import { harnessLog } from '../../log.js';
import { ToolCallContext } from '../tool-call-context.js';
import type { SubagentInvocationService } from '../../delegate/subagent-invocation.service.js';
import { BACKGROUND_SUBAGENT_TOOLS } from '../../delegate/background-subagent-manager.js';

export class DelegateTool extends BaseTool {
  constructor(
    private readonly definitionRegistry: AgentDefinitionRegistry,
    private readonly harnessService: HarnessService,
    private readonly agentLoop: AgentLoop,
    private readonly sessionService: SessionService,
    private readonly sessionMapper: SessionMapper,
    private readonly subagentExecutionMapper: SubagentExecutionMapper,
    private readonly localToolSessionRegistry: LocalToolSessionRegistry,
    private readonly visibilityService: SubAgentVisibilityService,
    private readonly invocationService?: SubagentInvocationService,
  ) { super(); }

  getName(): string { return 'delegate'; }
  getDescription(): string {
    return '将子任务委派给专用子代理执行。子代理拥有独立会话和工具集，专注完成指定任务后返回结果。\n\n'
      + '何时使用：\n'
      + '- 任务可以拆分为独立的子任务\n'
      + '- 某个子任务需要不同的专注策略（如纯研究、纯编码、代码审查）\n'
      + '- 子任务的上下文与当前对话不同，需要隔离执行\n\n'
      + '何时不要使用：\n'
      + '- 简单的单步任务\n'
      + '- 需要与用户交互的子任务（子代理无法直接与用户对话）\n'
      + '- 子任务之间有强依赖关系（请串行调用）';
  }
  getInputSchema(): Record<string, unknown> {
    const agentNames = this.definitionRegistry.getAllDefinitions().map((d) => d.name);
    return {
      type: 'object',
      properties: {
        agent_type: {
          type: 'string',
          description: '子代理类型。不同类型擅长不同任务：\n'
            + this.definitionRegistry.getAllDefinitions().map((d) => `- ${d.name}：${d.description}`).join('\n'),
          enum: agentNames,
        },
        task: {
          type: 'string',
          description: '要委派给子代理的任务描述。应足够具体，包含：\n1. 明确的目标\n2. 输入数据或上下文\n3. 期望的输出格式\n4. 约束条件（如有）',
        },
      },
      required: ['agent_type', 'task'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(argumentsJson: string, sessionId: number | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson);
      if (!args) return toJson({ error: '无效的JSON参数' });
      const agentType = asText(args.agent_type);
      const task = asText(args.task);
      if (!agentType || !task) return toJson({ error: '缺少必填参数: agent_type, task' });
      const definition = this.definitionRegistry.getDefinition(agentType);
      if (!definition) {
        return toJson({
          error: '未知的子代理类型: ' + agentType,
          available_types: this.definitionRegistry.getAllDefinitions().map((d) => d.name),
        });
      }
      const parentSession = sessionId != null ? await this.sessionMapper.selectById(sessionId) : null;
      if (!parentSession) return toJson({ error: '父会话不存在: ' + sessionId });
      const toolCallId = ToolCallContext.getToolCallId()
        ?? (this.invocationService ? null : `legacy_delegate_${Date.now()}`);
      if (!toolCallId) return errorJson('缺少父工具调用 ID');
      const childTitle = '子代理(' + agentType + '): ' + (task.length > 40 ? task.slice(0, 40) + '...' : task);
      let childSession: Session;
      let execution: SubagentExecution;
      if (this.invocationService) {
        ({ child: childSession, execution } = await this.invocationService.createDelegate(
          parentSession, agentType, task, childTitle, toolCallId,
        ));
      } else {
        if (!this.sessionService.createSession) return errorJson('createSession 不可用');
        childSession = await this.sessionService.createSession(
          parentSession.userId, parentSession.agentId, childTitle,
          parentSession.executionMode, parentSession.workspace, parentSession.permissionLevel,
          parentSession.isGit, parentSession.platform, parentSession.shellPath, parentSession.osVersion,
          parentSession.modelId,
        );
        childSession.parentSessionId = sessionId;
        childSession.sessionType = 'SUBAGENT';
        childSession.phase = null;
        await this.sessionMapper.updateById?.(childSession);
        execution = {
          parentSessionId: sessionId, childSessionId: childSession.id, agentType,
          invocationType: 'DELEGATE', parentToolCallId: toolCallId, deliveryStatus: 'PENDING',
          taskDescription: task, status: 'RUNNING', startedAt: nowSql(),
        };
        await this.subagentExecutionMapper.insert(execution);
        const start = await this.sessionService.saveMessage(childSession.id!, 'USER', task, null, null, null, 0, null);
        execution.executionStartMessageId = start.id;
        if (execution.id != null) await this.subagentExecutionMapper.updateById(execution.id, { executionStartMessageId: start.id });
      }
      if (parentSession.executionMode?.toUpperCase() === 'LOCAL' && parentSession.userId != null) {
        this.localToolSessionRegistry.setUserForSession(childSession.id!, parentSession.userId);
      }
      this.visibilityService.notifySubagentCreated(parentSession, childSession, agentType, task, toolCallId);
      const subContext = await this.buildSubContext(childSession, definition);
      const parentCancel = this.agentLoop.getCancelFlag(sessionId!);
      const childCancel = this.agentLoop.registerCancelFlag(childSession.id!);
      if (parentCancel) {
        subContext.cancelFlag = parentCancel;
        if (parentCancel.get()) childCancel.set(true);
      }
      let runResult;
      try {
        runResult = await this.visibilityService.executeVisible(
          childSession, subContext, childCancel.get(),
        );
      } finally {
        if (!childCancel.get()) {
          this.agentLoop.removeCancelFlag(childSession.id!);
        }
        this.localToolSessionRegistry.removeSession?.(childSession.id!);
      }
      const collector = runResult.collector;
      const cancelled = childCancel.get() || parentCancel?.get() === true;
      let resultText: string;
      let success = !cancelled && collector.error == null;
      let terminalPhase: string;
      if (cancelled) {
        resultText = '子代理已随父会话取消';
        terminalPhase = 'CANCELLED';
      } else if (success) {
        resultText = collector.getResult();
        if (!resultText) {
          resultText = '(子代理未产生文本输出)';
          await this.sessionService.saveMessage(childSession.id!, 'ASSISTANT', resultText, collector.getThinkingContent(), null, null,
            collector.totalUsage?.totalTokens ?? 0, subContext.modelConfig?.id ?? null);
        }
        terminalPhase = 'COMPLETED';
      } else {
        resultText = '子代理执行失败: ' + ((collector.error as Error)?.message ?? '子代理执行异常');
        terminalPhase = 'FAILED';
        await this.sessionService.saveMessage(
          childSession.id!, 'ASSISTANT', resultText, null, null, null, 0,
          subContext.modelConfig?.id ?? null, JSON.stringify({ subagentTerminalStatus: 'FAILED' }),
        );
      }
      if (execution.id != null) {
        await this.subagentExecutionMapper.updateById(execution.id, {
          status: terminalPhase, result: resultText, totalRounds: subContext.currentRound,
          totalPromptTokens: collector.totalUsage?.promptTokens ?? 0,
          totalCompletionTokens: collector.totalUsage?.completionTokens ?? 0,
          totalToolCalls: collector.toolCallCount,
          completedAt: nowSql(),
        });
      }
      await this.visibilityService.finishSubagent(childSession.id!, parentSession.userId, terminalPhase, runResult.executionId);
      const response: Record<string, unknown> = {
        success, cancelled, agent_type: agentType, child_session_id: childSession.id, result: resultText,
        rounds: subContext.currentRound, tool_calls: collector.toolCallCount,
      };
      if (cancelled) response.error = resultText;
      if (collector.totalUsage) {
        response.usage = {
          prompt_tokens: collector.totalUsage.promptTokens,
          completion_tokens: collector.totalUsage.completionTokens,
          total_tokens: collector.totalUsage.totalTokens,
        };
      }
      return toJson(response);
    } catch (e) {
      return errorJson((e as Error).message);
    }
  }

  async buildSubContext(
    childSession: { id?: number },
    definition: { name: string; systemPromptOverride?: string; excludedToolNames?: string[]; allowedToolNames?: string[] },
  ) {
    const ctx = await this.harnessService.buildContext(childSession.id!);
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
    return ctx;
  }
}

export class DelegateFollowupTool extends BaseTool {
  constructor(
    private readonly definitionRegistry: AgentDefinitionRegistry,
    private readonly harnessService: HarnessService,
    private readonly agentLoop: AgentLoop,
    private readonly sessionService: SessionService,
    private readonly sessionMapper: SessionMapper,
    private readonly messageMapper: MessageMapper,
    private readonly sessionCompactionService: SessionCompactionService,
    private readonly subagentExecutionMapper: SubagentExecutionMapper,
    private readonly localToolSessionRegistry: LocalToolSessionRegistry,
    private readonly visibilityService: SubAgentVisibilityService,
    private readonly delegateTool: DelegateTool,
    private readonly invocationService?: SubagentInvocationService,
  ) { super(); }

  getName(): string { return 'delegate_followup'; }
  getDescription(): string {
    return '对既有子代理会话发起追问（续查）。子代理保留上次全部上下文，'
      + '基于你描述的最新状态做增量核查，适合「审查 → 修复 → 再审查」闭环。\n\n'
      + '何时使用：\n'
      + '- 已有子代理完成过任务（如代码审查），你修复了其发现的问题，需要它核查修复情况并继续审查\n'
      + '- 需要基于上次结论增量推进，而不是重新全量分析\n\n'
      + '何时不要使用：\n'
      + '- 全新任务（请使用 delegate 新建子代理）\n'
      + '- 没有对应的 child_session_id（需先从 delegate 返回结果获取）\n'
      + '- 目标子代理与本次问题无关';
  }
  getToolPrompt(): string {
    return '## 子代理追问\n\n'
      + '使用 `delegate_followup` 工具对既有子代理会话发起追问，复用其历史上下文做增量核查。\n\n'
      + '### 使用步骤\n\n'
      + '1. 从历史工具结果中找到目标子代理的 `child_session_id`（`delegate` 返回的 `child_session_id` 字段）\n'
      + '2. 在 `task` 中描述本次变更内容与核查重点，调用 `delegate_followup`\n\n'
      + '### 使用原则\n\n'
      + '1. 子代理保留上次全部上下文（上次结论、工具输出），会自动聚焦增量核查，不要让它重新全量分析\n'
      + '2. 追问任务描述要具体：列出上次结论、本次修复内容、期望核查点\n'
      + '3. 子代理可用文件/git 工具核实实际改动，可要求它确认修复是否到位\n'
      + '4. 子代理无法与用户交互\n'
      + '5. 全新任务请使用 `delegate` 新建子代理，不要追问无关子代理\n';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        child_session_id: {
          type: 'integer',
          description: '要追问的子代理会话 id，取自历史中 delegate 或上一次 delegate_followup 工具返回结果的 child_session_id 字段，支持连续多轮追问',
        },
        task: {
          type: 'string',
          description: '追问任务描述。应说明：上次结论、本次修复/变更内容、期望核查的重点、输出格式。子代理会保留上次全部上下文做增量核查',
        },
      },
      required: ['child_session_id', 'task'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithSession(argumentsJson: string, sessionId: number | null): Promise<string> {
    let parentSession: Session | null = null;
    let childSession: Session | null = null;
    let execution: SubagentExecution | null = null;
    let runExecutionId: string | null = null;
    let localRegistered = false;
    let cancelFlagRegistered = false;
    let terminalHandled = false;
    let claimed = false;
    let originalPhase: string | null = null;

    try {
      const args = parseObject(argumentsJson);
      if (!args) return toJson({ error: '无效的JSON参数' });
      let childSessionId: number | null = null;
      if (args.child_session_id != null) {
        const idNode = args.child_session_id;
        if (typeof idNode === 'string' || (typeof idNode === 'number' && !Number.isInteger(idNode))) {
          return toJson({ error: '参数 child_session_id 必须是整数' });
        }
        childSessionId = Number(idNode);
        if (!Number.isInteger(childSessionId)) {
          return toJson({ error: '参数 child_session_id 必须是整数' });
        }
      }
      const task = asText(args.task);
      if (childSessionId == null || !task || task.trim() === '') {
        return toJson({ error: '缺少必填参数: child_session_id, task' });
      }

      parentSession = sessionId != null ? await this.sessionMapper.selectById(sessionId) : null;
      if (!parentSession) return toJson({ error: '父会话不存在: ' + sessionId });

      childSession = await this.sessionMapper.selectById(childSessionId);
      if (!childSession) return toJson({ error: '子代理会话不存在: ' + childSessionId });
      if (childSession.sessionType !== 'SUBAGENT') {
        return toJson({ error: '会话 ' + childSessionId + ' 不是子代理会话，无法追问' });
      }
      if (childSession.parentSessionId !== sessionId) {
        return toJson({ error: '子代理会话 ' + childSessionId + ' 不属于当前会话，无法追问' });
      }
      if (childSession.phase === 'RUNNING' || childSession.phase === 'RESUMING'
        || childSession.phase === 'WAITING_APPROVAL' || childSession.phase === 'CANCELLING') {
        return toJson({ error: '子代理会话 ' + childSessionId + ' 正在执行中，无法追问' });
      }

      const agentType = await this.resolveAgentType(childSessionId);
      if (agentType == null) {
        return toJson({ error: '子代理会话 ' + childSessionId + ' 无执行记录，无法追问' });
      }
      const definition = this.definitionRegistry.getDefinition(agentType);
      if (!definition) return toJson({ error: '未知的子代理类型: ' + agentType });

      originalPhase = childSession.phase ?? null;
      const toolCallId = ToolCallContext.getToolCallId()
        ?? (this.invocationService ? null : `legacy_delegate_${Date.now()}`);
      if (!toolCallId) return errorJson('缺少父工具调用 ID');

      const compactionRecord = await this.sessionCompactionService.loadValidated(childSessionId);
      const boundary = this.sessionCompactionService.boundaryOf(compactionRecord);
      await this.sessionService.cleanupIncompleteTailAfterId?.(childSessionId, boundary);

      while (this.messageMapper.selectLast) {
        const lastMsg = await this.messageMapper.selectLast(childSessionId);
        if (!lastMsg || lastMsg.role !== 'USER') break;
        await this.messageMapper.deleteById?.(lastMsg.id!);
        harnessLog('info', `Removed orphan USER message ${lastMsg.id} before follow-up of sub-agent session ${childSessionId}`);
      }

      let savedUserMessage: { id?: number } | null = null;
      if (this.invocationService) {
        const created = await this.invocationService.createFollowup(
          parentSession, childSessionId, agentType, task, toolCallId,
        );
        if (!created) return toJson({ error: '子代理会话 ' + childSessionId + ' 正在执行中，无法追问' });
        childSession = created.child;
        execution = created.execution;
        savedUserMessage = { id: execution.executionStartMessageId ?? undefined };
      } else {
        const claimedRows = this.sessionMapper.claimRunningIfIdle
          ? await this.sessionMapper.claimRunningIfIdle(childSessionId) : 0;
        if (claimedRows === 0) return toJson({ error: '子代理会话 ' + childSessionId + ' 正在执行中，无法追问' });
        savedUserMessage = await this.sessionService.saveMessage(childSessionId, 'USER', task, null, null, null, 0, null);
        execution = {
          parentSessionId: sessionId, childSessionId, agentType,
          invocationType: 'FOLLOWUP', parentToolCallId: toolCallId, deliveryStatus: 'PENDING',
          executionStartMessageId: savedUserMessage.id, taskDescription: task,
          status: 'RUNNING', startedAt: nowSql(),
        };
        await this.subagentExecutionMapper.insert(execution);
      }
      claimed = true;

      if (parentSession.executionMode?.toUpperCase() === 'LOCAL' && parentSession.userId != null) {
        this.localToolSessionRegistry.setUserForSession(childSessionId, parentSession.userId);
        localRegistered = true;
      }
      this.visibilityService.ensureSubscribed(parentSession.userId, childSessionId);

      const subContext = await this.delegateTool.buildSubContext(childSession, definition);
      const parentCancel = this.agentLoop.getCancelFlag(sessionId);
      const childCancel = this.agentLoop.registerCancelFlag(childSessionId);
      cancelFlagRegistered = true;
      if (parentCancel) {
        subContext.cancelFlag = parentCancel;
        if (parentCancel.get()) childCancel.set(true);
      }

      const skip = childCancel.get();
      let runResult;
      try {
        if (skip) {
          harnessLog('info', `Skip follow-up of sub-agent session ${childSessionId}: parent already cancelled`);
        }
        runResult = await this.visibilityService.executeVisible(childSession, subContext, skip);
      } finally {
        if (cancelFlagRegistered && !childCancel.get()) {
          this.agentLoop.removeCancelFlag(childSessionId);
          cancelFlagRegistered = false;
        }
        if (localRegistered) {
          this.localToolSessionRegistry.removeSession(childSessionId);
          localRegistered = false;
        }
      }

      const resultCollector = runResult.collector;
      runExecutionId = runResult.executionId;
      const cancelled = childCancel.get() || parentCancel?.get() === true;
      let resultText: string;
      const success = !cancelled && resultCollector.error == null;
      let terminalPhase: string;

      if (cancelled) {
        if (skip && originalPhase != null && isTerminalPhase(originalPhase)) {
          const current = await this.sessionMapper.selectById(childSessionId);
          if (current?.phase === 'RUNNING') {
            await this.sessionMapper.updatePhase?.(childSessionId, originalPhase);
            harnessLog('info', `Follow-up of sub-agent session ${childSessionId} skipped (parent cancelled), restore phase ${originalPhase}`);
          }
        }
        if (savedUserMessage?.id != null) {
          await this.messageMapper.deleteFromId?.(childSessionId, savedUserMessage.id);
        }
        resultText = '子代理已随父会话取消';
        terminalPhase = 'CANCELLED';
        await this.markExecutionTerminal(execution, 'CANCELLED', resultText, subContext.currentRound, resultCollector);
      } else if (success) {
        resultText = resultCollector.getResult();
        if (!resultText) {
          resultText = '(子代理未产生文本输出)';
          await this.sessionService.saveMessage(
            childSessionId, 'ASSISTANT', resultText, resultCollector.getThinkingContent(), null, null,
            resultCollector.totalUsage?.totalTokens ?? 0, subContext.modelConfig?.id ?? null,
          );
        }
        terminalPhase = 'COMPLETED';
        await this.markExecutionTerminal(execution, 'COMPLETED', resultText, subContext.currentRound, resultCollector);
      } else {
        const errorMsg = resultCollector.error instanceof Error
          ? resultCollector.error.message : '子代理执行异常';
        resultText = '子代理执行失败: ' + errorMsg;
        terminalPhase = 'FAILED';
        await this.sessionService.saveMessage(
          childSessionId, 'ASSISTANT', resultText, null, null, null, 0,
          subContext.modelConfig?.id ?? null, JSON.stringify({ subagentTerminalStatus: 'FAILED' }),
        );
        await this.markExecutionTerminal(execution, 'FAILED', resultText, subContext.currentRound, resultCollector);
      }

      await this.visibilityService.finishSubagent(childSessionId, parentSession.userId, terminalPhase, runExecutionId);
      terminalHandled = true;

      const round = await this.subagentExecutionMapper.countByChildSessionId(childSessionId);
      const completedRounds = await this.subagentExecutionMapper.countCompletedByChildSessionId(childSessionId);
      const response: Record<string, unknown> = {
        success, cancelled, follow_up: true, agent_type: agentType,
        child_session_id: childSessionId, round, completed_rounds: completedRounds, result: resultText,
        rounds: subContext.currentRound, tool_calls: resultCollector.toolCallCount,
      };
      if (cancelled) response.error = resultText;
      if (resultCollector.totalUsage) {
        response.usage = {
          prompt_tokens: resultCollector.totalUsage.promptTokens,
          completion_tokens: resultCollector.totalUsage.completionTokens,
          total_tokens: resultCollector.totalUsage.totalTokens,
        };
      }
      return toJson(response);
    } catch (e) {
      harnessLog('error', 'DelegateFollowupTool execution failed', e);
      if (childSession != null && claimed && !terminalHandled) {
        await this.failCreatedSubagent(childSession, parentSession, execution, runExecutionId, e as Error);
      }
      const err: Record<string, unknown> = { error: '追问执行失败: ' + (e as Error).message };
      if (childSession != null) {
        err.child_session_id = childSession.id;
        err.success = false;
      }
      return toJson(err);
    } finally {
      if (claimed && childSession?.id != null) {
        try { this.agentLoop.removeCancelFlag(childSession.id); } catch { /* best-effort */ }
      }
      if (localRegistered && childSession?.id != null) {
        try { this.localToolSessionRegistry.removeSession(childSession.id); } catch { /* best-effort */ }
      }
    }
  }

  private async resolveAgentType(childSessionId: number): Promise<string | null> {
    const row = await this.subagentExecutionMapper.findByChildSessionId(childSessionId);
    return row?.agentType ?? null;
  }

  private async failCreatedSubagent(
    childSession: Session, parentSession: Session | null, execution: SubagentExecution | null,
    runExecutionId: string | null, cause: Error,
  ): Promise<void> {
    const resultText = '子代理执行失败: ' + (cause.message || cause.name);
    if (execution?.id != null) {
      await this.markExecutionTerminal(execution, 'FAILED', resultText, null, null);
    }
    await this.sessionService.saveMessage(childSession.id!, 'ASSISTANT', resultText, null, null, null, 0, null);
    const userId = parentSession?.userId ?? childSession.userId;
    await this.visibilityService.finishSubagent(childSession.id!, userId, 'FAILED', runExecutionId ?? '');
  }

  private async markExecutionTerminal(
    execution: SubagentExecution, status: string, resultText: string,
    rounds: number | null, collector: SubAgentResultCollector | null,
  ): Promise<void> {
    execution.status = status;
    execution.result = truncate(resultText, 65000);
    execution.completedAt = nowSql();
    if (rounds != null) execution.totalRounds = rounds;
    if (collector) execution.totalToolCalls = collector.toolCallCount;
    if (collector?.totalUsage) {
      execution.totalPromptTokens = collector.totalUsage.promptTokens;
      execution.totalCompletionTokens = collector.totalUsage.completionTokens;
    }
    if (execution.executionStartMessageId != null) {
      const messages = await this.sessionService.getMessagesAfterId(
        execution.childSessionId!, execution.executionStartMessageId,
      );
      execution.finalMessageId = [...messages].reverse()
        .find((message) => message.role === 'ASSISTANT' && !message.toolCalls)?.id ?? null;
    }
    if (execution.id != null) {
      await this.subagentExecutionMapper.updateById(execution.id, execution);
    }
  }
}

function isTerminalPhase(phase: string): boolean {
  return phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
}

function truncate(text: string | null, maxLen: number): string | null {
  if (text == null) return null;
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

