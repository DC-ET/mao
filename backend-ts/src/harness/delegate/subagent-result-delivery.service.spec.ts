import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/db.js';
import { MISSING_TOOL_RESULT_PLACEHOLDER } from '../core/message-history-normalizer.js';
import { SubagentResultDeliveryService } from './subagent-result-delivery.service.js';

const execution = {
  id: 9,
  parentSessionId: 1,
  childSessionId: 2,
  invocationType: 'BACKGROUND',
  parentToolCallId: 'tc-1',
  deliveryStatus: 'PENDING',
  status: 'COMPLETED',
  result: 'done',
  agentType: 'coder',
};

function fakeDb(
  messages: Array<Record<string, unknown>>,
  row: Record<string, unknown> = execution,
) {
  const inserts: object[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const executes: string[] = [];
  const tx = {
    async query(sql: string) {
      if (sql.includes('FROM message')) return messages;
      return [];
    },
    async queryOne(sql: string) {
      if (sql.includes('subagent_execution')) return row;
      if (sql.includes('FROM session')) return { id: 1, phase: 'RUNNING' };
      return null;
    },
    async execute(sql: string) {
      executes.push(sql);
      return { affectedRows: 1 };
    },
    async insert(_table: string, data: object) {
      inserts.push(data);
      return 99;
    },
    async updateById(_table: string, _id: number, data: Record<string, unknown>) {
      updates.push(data);
    },
    async transaction(fn: (db: Db) => Promise<unknown>) {
      return fn(tx as unknown as Db);
    },
  };
  return { db: tx as unknown as Db, inserts, updates, executes };
}

describe('SubagentResultDeliveryService background delivery', () => {
  it('does not insert a second completion notice when one was already persisted', async () => {
    const notice = {
      id: 41,
      metadata: JSON.stringify({
        backgroundSubagentCompletion: { childSessionId: 2, executionId: 9, status: 'COMPLETED', agentType: 'coder' },
      }),
    };
    const { db, inserts, updates } = fakeDb([notice]);
    const service = new SubagentResultDeliveryService(db);
    await expect(service.deliver(9)).resolves.toBe('DELIVERED');
    expect(inserts).toHaveLength(0);
    expect(updates.some((row) => row.deliveryStatus === 'DELIVERED' && row.parentAssistantMessageId === 41)).toBe(true);
  });

  it('inserts the completion notice when recovery is the first delivery', async () => {
    const { db, inserts } = fakeDb([]);
    const service = new SubagentResultDeliveryService(db);
    await expect(service.deliver(9)).resolves.toBe('DELIVERED');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual(expect.objectContaining({ role: 'ASSISTANT', sessionId: 1 }));
  });

  it('replaces a missing-tool placeholder with the real delegate result', async () => {
    const toolCallId = 'tc-delegate';
    const delegate = {
      ...execution,
      invocationType: 'DELEGATE',
      parentToolCallId: toolCallId,
      result: '子代理真实结论',
    };
    const { db, inserts, executes } = fakeDb([
      {
        id: 3,
        role: 'ASSISTANT',
        content: '先看一下仓库',
        toolCalls: JSON.stringify([
          { id: 'tc-read', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { id: toolCallId, type: 'function', function: { name: 'delegate', arguments: '{}' } },
        ]),
      },
      { id: 4, role: 'TOOL', toolCallId, content: MISSING_TOOL_RESULT_PLACEHOLDER },
    ], delegate);
    const service = new SubagentResultDeliveryService(db);
    await expect(service.deliver(9)).resolves.toBe('DELIVERED');
    expect(inserts.filter((row) => (row as { role?: string }).role === 'ASSISTANT')).toHaveLength(0);
    expect(inserts.some((row) => (row as { role?: string }).role === 'TOOL'
      && String((row as { content?: string }).content).includes('子代理真实结论'))).toBe(true);
    expect(executes.some((sql) => sql.includes('id = ?'))).toBe(true);
    expect(executes.some((sql) => sql.includes('id IN'))).toBe(false);
  });

  it('writes completed_at before status so a running row keeps its end time', async () => {
    const sqls: string[] = [];
    const { db } = fakeDb([]);
    const tx = db as unknown as { execute: (sql: string) => Promise<unknown> };
    const original = tx.execute.bind(tx);
    tx.execute = async (sql: string) => {
      sqls.push(sql);
      return original(sql);
    };
    const service = new SubagentResultDeliveryService(db);
    await service.suppressForParent(1);
    const update = sqls.find((sql) => sql.includes('completed_at'));
    expect(update).toBeTruthy();
    expect(update!.indexOf('completed_at')).toBeLessThan(update!.indexOf('status = CASE'));
  });
});

describe('SubagentResultDeliveryService 收件箱写入（SUBAGENT_DONE / deliverBackground）', () => {
  async function deliver(
    recorder: { recordSubagentDone: ReturnType<typeof vi.fn> } | null,
    row: Record<string, unknown> = { ...execution, status: 'COMPLETED', result: '子代理结论' },
  ) {
    const { db } = fakeDb([], row);
    const service = new SubagentResultDeliveryService(db, undefined, recorder as never);
    return service.deliver(9);
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('deliverBackground 投递成功后写入 SUBAGENT_DONE（COMPLETED）', async () => {
    const recorder = { recordSubagentDone: vi.fn(async () => undefined) };
    await expect(deliver(recorder)).resolves.toBe('DELIVERED');
    await settle();
    expect(recorder.recordSubagentDone).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 1,
      childSessionId: 2,
      executionId: 9,
      status: 'COMPLETED',
      result: '子代理结论',
    }));
  });

  it('deliverBackground 覆盖 FAILED / CANCELLED 终态', async () => {
    for (const status of ['FAILED', 'CANCELLED']) {
      const recorder = { recordSubagentDone: vi.fn(async () => undefined) };
      await expect(deliver(recorder, { ...execution, status })).resolves.toBe('DELIVERED');
      await settle();
      expect(recorder.recordSubagentDone).toHaveBeenCalledWith(expect.objectContaining({ status }));
    }
  });

  it('同步 delegate 路径不写入（只挂 deliverBackground，不挂 deliver）', async () => {
    const recorder = { recordSubagentDone: vi.fn(async () => undefined) };
    await expect(deliver(recorder, { ...execution, invocationType: 'DELEGATE' })).resolves.toBe('DELIVERED');
    await settle();
    expect(recorder.recordSubagentDone).not.toHaveBeenCalled();
  });

  it('已投递过的记录二次投递 → SKIPPED 分支不重复写入（幂等）', async () => {
    const recorder = { recordSubagentDone: vi.fn(async () => undefined) };
    await expect(deliver(recorder, { ...execution, deliveryStatus: 'DELIVERED' })).resolves.toBe('SKIPPED');
    await settle();
    expect(recorder.recordSubagentDone).not.toHaveBeenCalled();
  });

  it('未注入 inboxRecorder 时行为与改造前一致（零影响）', async () => {
    await expect(deliver(null)).resolves.toBe('DELIVERED');
  });
});
