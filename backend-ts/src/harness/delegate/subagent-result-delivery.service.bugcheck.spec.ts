import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/db.js';
import type { FileChange } from '../../session/types.js';
import { SubagentResultDeliveryService } from './subagent-result-delivery.service.js';

/**
 * BUG：SubagentResultDeliveryService.deliverBackground 用
 * `existingId == null` 同时把「通知消息已存在」和「文件变更还没聚合」两件独立的事
 * 绑在一起：
 *
 *   const existingId = await this.findBackgroundNotice(...);
 *   const assistantId = existingId ?? await tx.insert('message', {...});
 *   if (existingId == null && this.fileChangeRepo && ...) {
 *     await this.copyFileChanges(...);
 *   }
 *
 * 正常完成路径（BackgroundSubagentManager.onCompleted）的顺序是：
 *   persistCompletionNotice()  →  先插通知消息，紧跟着 copyFileChanges()
 *   updateById(deliveryStatus = 'DELIVERED')
 * 若进程在「通知已落库、DELIVERED 尚未写」之间崩溃，库里留下
 * 「通知已存在 + delivery_status = PENDING + 文件变更未复制」。
 *
 * 崩溃恢复再走 deliver() 时：findBackgroundNotice 命中已有通知（去重正确，
 * 不再插第二条），但 existingId != null 使 copyFileChanges 被整体跳过——
 * 该后台子代理本轮的文件变更再也不会被聚合进父会话（copyFileChanges 本身
 * 按 fileChangeCopyKey 去重，重复调用是幂等安全的，没有不调用的理由）。
 */

const execution = {
  id: 9,
  parentSessionId: 1,
  childSessionId: 2,
  invocationType: 'BACKGROUND',
  parentToolCallId: 'tc-1',
  deliveryStatus: 'PENDING',
  status: 'COMPLETED',
  result: 'done',
  agentType: 'worker',
  executionStartMessageId: 400,
};

function fakeDb(messages: Array<Record<string, unknown>>, row: Record<string, unknown> = execution) {
  const inserts: object[] = [];
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
    async execute() {
      return { affectedRows: 1 };
    },
    async insert(_table: string, data: object) {
      inserts.push(data);
      return 99;
    },
    async updateById() { /* noop */ },
    async transaction(fn: (db: Db) => Promise<unknown>) {
      return fn(tx as unknown as Db);
    },
  };
  return { db: tx as unknown as Db, inserts };
}

describe('deliverBackground reuses notice but must still aggregate file changes (bugcheck)', () => {
  it('copies the child file changes when recovery reuses an already-persisted notice', async () => {
    // 崩溃窗口残留：通知消息已落库（executionId=9），delivery_status 仍为 PENDING。
    const notice = {
      id: 41,
      metadata: JSON.stringify({
        backgroundSubagentCompletion: { childSessionId: 2, executionId: 9, status: 'COMPLETED', agentType: 'worker' },
      }),
    };
    const { db, inserts } = fakeDb([notice]);

    const childChange: FileChange = {
      id: 1,
      sessionId: 2,
      messageId: 450, // > executionStartMessageId(400)：本轮执行产生的变更
      filePath: '/repo/src/app.ts',
      changeType: 'MODIFIED',
      linesAdded: 3,
      linesDeleted: 1,
    } as unknown as FileChange;
    const fileChangeRepo = {
      listBySession: vi.fn(async (sessionId: number) => (sessionId === 2 ? [childChange] : [])),
      insert: vi.fn(async () => 77),
    };

    const service = new SubagentResultDeliveryService(db, fileChangeRepo);
    await expect(service.deliver(9)).resolves.toBe('DELIVERED');

    // 去重正确：不插第二条通知。
    expect(inserts).toHaveLength(0);
    // 但文件变更必须仍然聚合进父会话（幂等去重由 fileChangeCopyKey 保证）。
    expect(fileChangeRepo.insert).toHaveBeenCalledTimes(1);
    expect(fileChangeRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 1,
      messageId: 41,
      filePath: '/repo/src/app.ts',
    }));
  });
});
