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
    return this.db.transaction(async (tx) => {
      const child = await tx.queryOne<Session>(
        'SELECT * FROM session WHERE id = ? AND deleted = 0 FOR UPDATE', [childSessionId],
      );
      if (!child || child.sessionType !== 'SUBAGENT' || child.parentSessionId !== parent.id) return null;
      if (child.phase === 'RUNNING' || child.phase === 'RESUMING') return null;
      await tx.execute("UPDATE session SET phase = 'RUNNING' WHERE id = ?", [childSessionId]);
      child.phase = 'RUNNING';
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
  return {
    sessionId,
    role: 'USER',
    content,
    thinkingContent: null,
    toolCallId: null,
    toolCalls: null,
    tokenCount: 0,
    modelId: null,
    metadata: null,
    sourceSessionId: null,
    deleted: 0,
  };
}
