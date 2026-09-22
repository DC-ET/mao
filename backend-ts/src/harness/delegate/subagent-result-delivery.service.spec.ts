import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/db.js';
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

function fakeDb(messages: Array<{ id: number; metadata: string }>) {
  const inserts: object[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    async query(sql: string) {
      if (sql.includes('FROM message')) return messages;
      return [];
    },
    async queryOne(sql: string) {
      if (sql.includes('subagent_execution')) return execution;
      if (sql.includes('FROM session')) return { id: 1, phase: 'RUNNING' };
      return null;
    },
    async execute() {
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
  return { db: tx as unknown as Db, inserts, updates };
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
});
