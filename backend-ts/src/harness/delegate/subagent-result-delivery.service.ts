import { nowSql } from '../../common/datetime.js';
import type { Db } from '../../db/db.js';
import type { FileChange, Message, Session, SubagentExecution } from '../../session/types.js';
import { harnessLog } from '../log.js';
import { SubagentExecutionMapper } from './subagent-execution.mapper.js';
import { SubagentRecoveryResultFactory } from './subagent-recovery-result-factory.js';

const TERMINAL_PHASES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export interface BackgroundFileChangeRepo {
  listBySession(sessionId: number): Promise<FileChange[]>;
  insert(change: FileChange): Promise<number>;
}

export class SubagentResultDeliveryService {
  constructor(
    private readonly db: Db,
    private readonly fileChangeRepo?: BackgroundFileChangeRepo,
  ) {}

  async inferLegacyFields(execution: SubagentExecution): Promise<SubagentExecution> {
    if (execution.id == null || execution.childSessionId == null) return execution;
    if (execution.invocationType && execution.parentToolCallId) return execution;
    return this.db.transaction(async (tx) => {
      const mapper = new SubagentExecutionMapper(tx);
      const locked = await mapper.findByIdForUpdate(execution.id!);
      if (!locked) throw new Error(`Subagent execution ${execution.id} not found`);
      const first = await mapper.findFirstByChildSessionId(locked.childSessionId!);
      const invocationType = locked.invocationType ?? (first?.id === locked.id ? 'DELEGATE' : 'FOLLOWUP');
      const parentToolCallId = locked.parentToolCallId ?? `recovered_subagent_execution_${locked.id}`;
      await mapper.updateById(locked.id!, { invocationType, parentToolCallId });
      return { ...locked, invocationType, parentToolCallId };
    });
  }

  async deliver(executionId: number): Promise<'DELIVERED' | 'SUPPRESSED' | 'SKIPPED'> {
    return this.db.transaction(async (tx) => {
      const mapper = new SubagentExecutionMapper(tx);
      let execution = await mapper.findByIdForUpdate(executionId);
      if (!execution) throw new Error(`Subagent execution ${executionId} not found`);
      if (execution.deliveryStatus === 'DELIVERED' || execution.deliveryStatus === 'SUPPRESSED') return 'SKIPPED';
      if (execution.parentSessionId == null || execution.childSessionId == null) {
        await mapper.updateById(executionId, { deliveryStatus: 'SUPPRESSED' });
        return 'SUPPRESSED';
      }
      const parentSessionId = execution.parentSessionId;
      const childSessionId = execution.childSessionId;
      const parent = await tx.queryOne<Session>(
        'SELECT * FROM session WHERE id = ? AND deleted = 0 FOR UPDATE', [parentSessionId],
      );
      if (!parent || TERMINAL_PHASES.has(parent.phase ?? '')) {
        await tx.execute(
          `UPDATE subagent_execution SET delivery_status = 'SUPPRESSED'
           WHERE parent_session_id = ? AND delivery_status = 'PENDING'`,
          [parentSessionId],
        );
        return 'SUPPRESSED';
      }
      execution = await this.inferLocked(tx, mapper, execution);
      if (execution.invocationType === 'BACKGROUND' || execution.invocationType === 'FOLLOWUP') {
        return this.deliverBackground(tx, mapper, execution, parentSessionId);
      }
      const toolCallId = execution.parentToolCallId!;
      const existing = await this.findMessagePair(tx, parentSessionId, toolCallId);
      let assistantId = existing.assistant?.id ?? null;
      let toolId = existing.tool?.id ?? null;
      if (!existing.complete) {
        await this.removeIncompletePair(tx, parentSessionId, toolCallId);
        assistantId = await tx.insert('message', {
          sessionId: parentSessionId,
          role: 'ASSISTANT',
          content: '',
          thinkingContent: null,
          toolCallId: null,
          toolCalls: JSON.stringify([{
            id: toolCallId,
            type: 'function',
            function: {
              name: 'delegate',
              arguments: JSON.stringify(SubagentRecoveryResultFactory.invocationArguments(execution)),
            },
          }]),
          tokenCount: 0,
          modelId: null,
          metadata: null,
          sourceSessionId: null,
          deleted: 0,
        });
        toolId = await tx.insert('message', {
          sessionId: parentSessionId,
          role: 'TOOL',
          content: JSON.stringify(SubagentRecoveryResultFactory.build(execution)),
          thinkingContent: null,
          toolCallId,
          toolCalls: null,
          tokenCount: 0,
          modelId: null,
          metadata: null,
          sourceSessionId: childSessionId,
          deleted: 0,
        });
      }
      const now = nowSql();
      await mapper.updateById(executionId, {
        deliveryStatus: 'DELIVERED',
        parentResultDeliveredAt: now,
        parentAssistantMessageId: assistantId,
        parentToolMessageId: toolId,
      });
      await tx.execute('UPDATE session SET updated_at = ? WHERE id = ?', [now, parentSessionId]);
      harnessLog('info', `subagent_result_delivered executionId=${executionId} parent=${execution.parentSessionId} toolCallId=${toolCallId}`);
      return 'DELIVERED';
    });
  }

  private async deliverBackground(
    tx: Db,
    mapper: SubagentExecutionMapper,
    execution: SubagentExecution,
    parentSessionId: number,
  ): Promise<'DELIVERED' | 'SUPPRESSED'> {
    const summary = truncate(execution.result ?? '', 2000);
    const content = `后台子代理（${execution.agentType ?? ''}）${backgroundStatusLabel(execution.status ?? '')}：${summary}`;
    const metadata = JSON.stringify({
      backgroundSubagentCompletion: {
        childSessionId: execution.childSessionId,
        executionId: execution.id,
        status: execution.status,
        agentType: execution.agentType ?? null,
      },
    });
    const assistantId = await tx.insert('message', {
      sessionId: parentSessionId,
      role: 'ASSISTANT',
      content,
      thinkingContent: null,
      toolCallId: null,
      toolCalls: null,
      tokenCount: 0,
      modelId: null,
      metadata,
      sourceSessionId: execution.childSessionId,
      deleted: 0,
    });
    if (this.fileChangeRepo && execution.childSessionId != null) {
      await this.copyFileChanges(execution.childSessionId, assistantId, parentSessionId);
    }
    const now = nowSql();
    await mapper.updateById(execution.id!, {
      deliveryStatus: 'DELIVERED',
      parentResultDeliveredAt: now,
      parentAssistantMessageId: assistantId,
    });
    await tx.execute('UPDATE session SET updated_at = ? WHERE id = ?', [now, parentSessionId]);
    harnessLog('info', `background_subagent_result_delivered executionId=${execution.id} parent=${parentSessionId}`);
    return 'DELIVERED';
  }

  private async copyFileChanges(
    childSessionId: number,
    noticeMessageId: number,
    parentSessionId: number,
  ): Promise<void> {
    const repo = this.fileChangeRepo;
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
      harnessLog('warn', `Failed to aggregate file changes for recovered background subagent ${childSessionId}: ${(e as Error).message}`);
    }
  }

  async suppressForParent(parentSessionId: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.queryOne('SELECT id FROM session WHERE id = ? FOR UPDATE', [parentSessionId]);
      await tx.execute(
        `UPDATE subagent_execution
         SET delivery_status = 'SUPPRESSED',
             status = CASE WHEN status IN ('RUNNING', 'RECOVERING') THEN 'CANCELLED' ELSE status END,
             completed_at = CASE WHEN status IN ('RUNNING', 'RECOVERING') THEN ? ELSE completed_at END
         WHERE parent_session_id = ? AND delivery_status = 'PENDING'`,
        [nowSql(), parentSessionId],
      );
    });
  }

  private async inferLocked(
    tx: Db, mapper: SubagentExecutionMapper, execution: SubagentExecution,
  ): Promise<SubagentExecution> {
    if (execution.invocationType && execution.parentToolCallId) return execution;
    const first = await mapper.findFirstByChildSessionId(execution.childSessionId!);
    const invocationType = execution.invocationType ?? (first?.id === execution.id ? 'DELEGATE' : 'FOLLOWUP');
    const parentToolCallId = execution.parentToolCallId ?? `recovered_subagent_execution_${execution.id}`;
    await mapper.updateById(execution.id!, { invocationType, parentToolCallId });
    return { ...execution, invocationType, parentToolCallId };
  }

  private async findMessagePair(
    tx: Db, parentSessionId: number, toolCallId: string,
  ): Promise<{ assistant: Message | null; tool: Message | null; complete: boolean }> {
    const rows = await tx.query<Message>(
      `SELECT * FROM message WHERE session_id = ? AND deleted = 0
       AND (tool_call_id = ? OR (role = 'ASSISTANT' AND tool_calls IS NOT NULL)) ORDER BY id`,
      [parentSessionId, toolCallId],
    );
    let assistant: Message | null = null;
    const tool = rows.find((row) => row.role === 'TOOL' && row.toolCallId === toolCallId) ?? null;
    for (const row of rows) {
      if (row.role !== 'ASSISTANT' || !row.toolCalls) continue;
      try {
        const calls = JSON.parse(row.toolCalls) as Array<{ id?: string }>;
        if (calls.some((call) => call.id === toolCallId)) assistant = row;
      } catch {
        // Damaged assistant rows are removed below before reconstruction.
      }
    }
    return { assistant, tool, complete: assistant != null && tool != null };
  }

  private async removeIncompletePair(tx: Db, parentSessionId: number, toolCallId: string): Promise<void> {
    const rows = await tx.query<Message>(
      `SELECT * FROM message WHERE session_id = ? AND deleted = 0
       AND (tool_call_id = ? OR role = 'ASSISTANT')`,
      [parentSessionId, toolCallId],
    );
    const ids: number[] = [];
    for (const row of rows) {
      if (row.role === 'TOOL' && row.toolCallId === toolCallId && row.id != null) ids.push(row.id);
      if (row.role === 'ASSISTANT' && row.toolCalls && row.id != null) {
        try {
          const calls = JSON.parse(row.toolCalls) as Array<{ id?: string }>;
          if (calls.some((call) => call.id === toolCallId)) ids.push(row.id);
        } catch {
          if (row.toolCalls.includes(toolCallId)) ids.push(row.id);
        }
      }
    }
    if (ids.length > 0) {
      await tx.execute(`UPDATE message SET deleted = 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    }
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function backgroundStatusLabel(status: string): string {
  if (status === 'COMPLETED') return '已完成';
  if (status === 'FAILED') return '执行失败';
  if (status === 'CANCELLED') return '已取消';
  return status;
}
