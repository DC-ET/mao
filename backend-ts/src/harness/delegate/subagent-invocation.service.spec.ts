import { describe, expect, it, vi } from 'vitest';
import { Db } from '../../db/db.js';
import type { Session } from '../deps.js';
import { SubagentInvocationService } from './subagent-invocation.service.js';

// 使用真实 Db.transaction，验证清理和新执行写入共用事务及失败时的回滚。
function setup(child: Session | null = {
  id: 42, parentSessionId: 10, sessionType: 'SUBAGENT', phase: 'COMPLETED',
}) {
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: vi.fn().mockResolvedValue([child ? [child] : []]),
    execute: vi.fn().mockResolvedValue([{ affectedRows: 1, insertId: 9001 }]),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(connection) };
  const service = new SubagentInvocationService(new Db(pool as never));
  return { connection, service };
}

const parent: Session = { id: 10, userId: 7, modelId: 3 };
const clearSql = 'UPDATE session_todo SET deleted = 1 WHERE session_id = ? AND deleted = 0';

describe('SubagentInvocationService 来源继承', () => {
  it('子代理会话继承父会话来源，其余继承字段不串位（D8）', async () => {
    const { service } = setup();
    const parentWithSource: Session = {
      id: 10, userId: 7, modelId: 3, source: 'desktop',
      executionMode: 'LOCAL', workspace: '/Users/me/proj', projectKey: 'proj', permissionLevel: 'READ_WRITE',
    };
    const result = await service.createBackground(parentWithSource, 'worker', 'task', '子任务', 'tc-source');
    expect(result.child.source).toBe('desktop');
    expect(result.child.executionMode).toBe('LOCAL');
    expect(result.child.workspace).toBe('/Users/me/proj');
    expect(result.child.projectKey).toBe('proj');
    expect(result.child.parentSessionId).toBe(10);
    expect(result.child.sessionType).toBe('SUBAGENT');
  });
});

describe('SubagentInvocationService 运行身份继承（§5.8）', () => {
  it('spawn 继承父会话当前运行身份并写入 last_runtime_user_id', async () => {
    const { service, connection } = setup();
    const parentWithRuntime: Session = { id: 10, userId: 7, modelId: 3, lastRuntimeUserId: 67 };
    const result = await service.createBackground(parentWithRuntime, 'worker', 'task', '子任务', 'tc-runtime');
    expect(result.child.lastRuntimeUserId).toBe(67);
    const insert = connection.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO `session`'));
    expect(insert).toBeTruthy();
    const [sql, params] = insert!;
    const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(', ').map((c) => c.replace(/`/g, ''));
    // 列名与值按位对齐：漏字段/串位都会在这里暴露。
    expect(params[cols.indexOf('last_runtime_user_id')]).toBe(67);
  });

  it('父会话无运行身份时回落归属用户', async () => {
    const { service } = setup();
    const result = await service.createBackground(parent, 'worker', 'task', '子任务', 'tc-fallback');
    expect(result.child.lastRuntimeUserId).toBe(7);
  });

  it('followup 按父会话当前运行身份刷新子会话', async () => {
    const { service, connection } = setup();
    const parentWithRuntime: Session = { id: 10, userId: 7, modelId: 3, lastRuntimeUserId: 67 };
    const result = await service.createFollowupWithOptions(parentWithRuntime, 42, 'reviewer', '再审查', 'tc-fu', null);
    expect(result?.child.lastRuntimeUserId).toBe(67);
    expect(connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('last_runtime_user_id = ?'), [3, 67, 42],
    );
  });
});

describe('SubagentInvocationService followup todos', () => {
  it.each([undefined, '上一轮已中断，按新要求执行'])('clears only child todos within the new-round transaction (%s)', async (notice) => {
    const { connection, service } = setup();
    const result = await service.createFollowupWithOptions(parent, 42, 'reviewer', '再审查', 'tc-2', notice);
    expect(result?.execution.invocationType).toBe('FOLLOWUP');
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [42]);
    expect(connection.execute).toHaveBeenCalledWith(clearSql, [42]);
    expect(connection.execute.mock.calls.filter(([sql]) => sql === clearSql)).toHaveLength(1);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.execute.mock.invocationCallOrder[0]).toBeGreaterThan(connection.beginTransaction.mock.invocationCallOrder[0]);
    expect(connection.commit.mock.invocationCallOrder[0]).toBeGreaterThan(connection.execute.mock.invocationCallOrder.at(-1)!);
    // 不删除历史消息/执行记录，纠偏提示与新用户消息仍正常写入。
    const inserts = connection.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO `message`'));
    expect(inserts).toHaveLength(notice ? 2 : 1);
  });

  it.each(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])('preserves todos when child is %s', async (phase) => {
    const { connection, service } = setup({ id: 42, parentSessionId: 10, sessionType: 'SUBAGENT', phase });
    expect(await service.createFollowup(parent, 42, 'reviewer', '再审查', 'tc-2')).toBeNull();
    expect(connection.execute).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { id: 42, parentSessionId: 99, sessionType: 'SUBAGENT', phase: 'COMPLETED' },
    { id: 42, parentSessionId: 10, sessionType: 'MAIN', phase: 'COMPLETED' },
  ])('preserves todos for a missing or unrelated child (%j)', async (child) => {
    const { connection, service } = setup(child);
    expect(await service.createFollowup(parent, 42, 'reviewer', '再审查', 'tc-2')).toBeNull();
    expect(connection.execute).not.toHaveBeenCalled();
  });

  it('rolls back todo cleanup when creating the execution fails', async () => {
    const { connection, service } = setup();
    connection.execute.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSERT INTO `subagent_execution`')) throw new Error('insert failed');
      return [{ affectedRows: 1, insertId: 9001 }];
    });
    await expect(service.createFollowup(parent, 42, 'reviewer', '再审查', 'tc-2')).rejects.toThrow('insert failed');
    expect(connection.execute).toHaveBeenCalledWith(clearSql, [42]);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('does not start a new execution when todo cleanup fails', async () => {
    const { connection, service } = setup();
    connection.execute.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(service.createFollowup(parent, 42, 'reviewer', '再审查', 'tc-2')).rejects.toThrow('cleanup failed');
    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(clearSql, [42]);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
  });
});
