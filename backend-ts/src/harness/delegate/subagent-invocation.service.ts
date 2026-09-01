import { nowSql } from '../../common/datetime.js';
import type { Db } from '../../db/db.js';
import type { SubagentExecution } from '../../session/types.js';
import type { Session } from '../deps.js';
import { SubagentExecutionMapper } from './subagent-execution.mapper.js';

export class SubagentInvocationService {
  constructor(private readonly db: Db) {}

  async createDelegate(
    parent: Session, agentType: string, task: string, title: string, parentToolCallId: string,
  ): Promise<{ child: Session; execution: SubagentExecution }> {
    return this.create(parent, agentType, task, title, parentToolCallId, 'DELEGATE');
  }

  async createBackground(
    parent: Session, agentType: string, task: string, title: string, parentToolCallId: string,
  ): Promise<{ child: Session; execution: SubagentExecution }> {
    return this.create(parent, agentType, task, title, parentToolCallId, 'BACKGROUND');
  }

  private async create(
    parent: Session,
    agentType: string,
    task: string,
    title: string,
    parentToolCallId: string,
    invocationType: SubagentExecution['invocationType'],
  ): Promise<{ child: Session; execution: SubagentExecution }> {
    return this.db.transaction(async (tx) => {
      const child: Session = {
        userId: parent.userId,
        agentId: parent.agentId,
        title,
        executionMode: parent.executionMode,
        workspace: parent.workspace,
        permissionLevel: parent.permissionLevel,
        modelId: parent.modelId,
        isGit: parent.isGit,
        platform: parent.platform,
        shellPath: parent.shellPath,
        osVersion: parent.osVersion,
        phase: null,
        projectKey: parent.projectKey,
        parentSessionId: parent.id,
        sessionType: 'SUBAGENT',
      };
      child.id = await tx.insert('session', child);
      const execution: SubagentExecution = {
        parentSessionId: parent.id,
        childSessionId: child.id,
        agentType,
        invocationType,
        parentToolCallId,
        deliveryStatus: 'PENDING',
        taskDescription: task,
        status: 'RUNNING',
        startedAt: nowSql(),
      };
      await new SubagentExecutionMapper(tx).insert(execution);
      execution.executionStartMessageId = await tx.insert('message', userMessage(child.id, task));
      await new SubagentExecutionMapper(tx).updateById(execution.id!, {
        executionStartMessageId: execution.executionStartMessageId,
      });
      return { child, execution };
    });
  }

  async createFollowup(
    parent: Session, childSessionId: number, agentType: string, task: string, parentToolCallId: string,
  ): Promise<{ child: Session; execution: SubagentExecution } | null> {
    return this.createFollowupWithOptions(parent, childSessionId, agentType, task, parentToolCallId);
  }

  async createFollowupWithOptions(
    parent: Session,
    childSessionId: number,
    agentType: string,
    task: string,
    parentToolCallId: string,
    beforeUserMessage?: string | null,
  ): Promise<{ child: Session; execution: SubagentExecution } | null> {
    return this.db.transaction(async (tx) => {
      const child = await tx.queryOne<Session>(
        'SELECT * FROM session WHERE id = ? AND deleted = 0 FOR UPDATE', [childSessionId],
      );
      if (!child || child.sessionType !== 'SUBAGENT' || child.parentSessionId !== parent.id) return null;
      if (child.phase === 'RUNNING' || child.phase === 'RESUMING'
        || child.phase === 'WAITING_APPROVAL' || child.phase === 'CANCELLING') return null;
      // 追问/纠偏时让子代理跟随主代理当前模型：主代理切换模型后，子代理复用其既有上下文、但改用主代理正在用的新模型。
      // 首次 spawn 时子代理继承 parent.modelId；追问时需要重新同步，否则子代理会一直用创建时绑定的旧模型。
      await tx.execute("UPDATE session SET phase = 'RUNNING', model_id = ? WHERE id = ?", [parent.modelId, childSessionId]);
      child.phase = 'RUNNING';
      child.modelId = parent.modelId;
      if (beforeUserMessage && beforeUserMessage.trim() !== '') {
        await tx.insert('message', assistantMessage(childSessionId, beforeUserMessage));
      }
      const execution: SubagentExecution = {
        parentSessionId: parent.id,
        childSessionId,
        agentType,
        invocationType: 'FOLLOWUP',
        parentToolCallId,
        deliveryStatus: 'PENDING',
        taskDescription: task,
        status: 'RUNNING',
        startedAt: nowSql(),
      };
      await new SubagentExecutionMapper(tx).insert(execution);
      execution.executionStartMessageId = await tx.insert('message', userMessage(childSessionId, task));
      await new SubagentExecutionMapper(tx).updateById(execution.id!, {
        executionStartMessageId: execution.executionStartMessageId,
      });
      return { child, execution };
    });
  }
}

function userMessage(sessionId: number, content: string): Record<string, unknown> {
  return message(sessionId, 'USER', content, null);
}

function assistantMessage(sessionId: number, content: string): Record<string, unknown> {
  return message(sessionId, 'ASSISTANT', content, JSON.stringify({ subagentCorrectionInterrupted: true }));
}

function message(sessionId: number, role: string, content: string, metadata: string | null): Record<string, unknown> {
  return {
    sessionId,
    role,
    content,
    thinkingContent: null,
    toolCallId: null,
    toolCalls: null,
    tokenCount: 0,
    modelId: null,
    metadata,
    sourceSessionId: null,
    deleted: 0,
  };
}
