import { nowSql } from '../../common/datetime.js';
import type { Db } from '../../db/db.js';
import type { SubagentExecution } from '../../session/types.js';
import type { Session } from '../deps.js';
import { SessionTodoMapper } from '../todo/session-todo.mapper.js';
import { SubagentExecutionMapper } from './subagent-execution.mapper.js';

export class SubagentInvocationService {
  constructor(private readonly db: Db) {}

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
        // 创建即 RUNNING：execution 已是 RUNNING，与 followup 路径一致。
        // 若先建 NULL 等 runBackground 启动再置 RUNNING，窗口期内详情接口
        // 会把 NULL 映射为 IDLE 并被前端补拉覆盖，且 RUNNING 事件只推一次，界面永久卡 IDLE。
        phase: 'RUNNING',
        projectKey: parent.projectKey,
        parentSessionId: parent.id,
        sessionType: 'SUBAGENT',
        // 运行身份继承（技术方案 2026-11-04 §5.8）：子代理跟随父会话「本次执行身份」，
        // 缺失回落父会话归属；buildSubContext 按该身份构建子会话上下文（不回落 owner）。
        lastRuntimeUserId: parent.lastRuntimeUserId ?? parent.userId ?? null,
        // 子代理继承父会话来源：admin 按来源筛选时与父保持一致（技术方案 D8）。
        source: parent.source,
        // 子代理继承父会话执行端绑定（技术方案 2026-11-05 §4.1-4）：LOCAL 子会话保持定向投递。
        targetDeviceId: parent.targetDeviceId,
        targetDeviceName: parent.targetDeviceName,
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
      // 新一轮进度不继承上一轮待办；与执行记录同事务，拒绝或回滚追问时保留旧任务。
      await new SessionTodoMapper(tx).deleteBySessionId(childSessionId);
      // 追问/纠偏时让子代理跟随主代理当前模型：主代理切换模型后，子代理复用其既有上下文、但改用主代理正在用的新模型。
      // 首次 spawn 时子代理继承 parent.modelId；追问时需要重新同步，否则子代理会一直用创建时绑定的旧模型。
      // 运行身份同样按父会话当前值刷新（§5.8）：追问发生在父会话「当前发言者」的环境里。
      const parentRuntimeUser = parent.lastRuntimeUserId ?? parent.userId ?? null;
      await tx.execute(
        "UPDATE session SET phase = 'RUNNING', model_id = ?, last_runtime_user_id = ? WHERE id = ?",
        [parent.modelId, parentRuntimeUser, childSessionId],
      );
      child.phase = 'RUNNING';
      child.modelId = parent.modelId;
      child.lastRuntimeUserId = parentRuntimeUser;
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
