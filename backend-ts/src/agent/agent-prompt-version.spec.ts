import { describe, expect, it, vi } from 'vitest';
import { Db } from '../db/db.js';
import { MysqlAgentRepository } from './agent.repository.js';
import type { Agent } from './types.js';

function fixture() {
  const current: Agent = { id: 4, name: 'agent', systemPrompt: 'current', defaultModelId: 9 };
  const tx = {
    queryOne: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
    insert: vi.fn(async () => 4),
    updateById: vi.fn(async () => undefined),
  };
  const db = {
    transaction: vi.fn(async (fn: (value: Db) => Promise<unknown>) => fn(tx as unknown as Db)),
  };
  return { current, tx, db, repo: new MysqlAgentRepository(db as unknown as Db) };
}

describe('Agent prompt version persistence', () => {
  it('rolls back the real Db transaction when the history insert fails', async () => {
    const conn = {
      beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
      query: vi.fn(async (sql: string) => [sql.includes('FROM agent WHERE')
        ? [{ id: 4, name: 'agent', system_prompt: 'current' }]
        : [{ version: 1 }]]),
      execute: vi.fn(async (sql: string) => {
        if (sql.startsWith('INSERT')) throw new Error('history insert failed');
        return [{ affectedRows: 1 }];
      }),
    };
    const db = new Db({ getConnection: async () => conn } as never);
    await expect(new MysqlAgentRepository(db).updateById(
      { id: 4, name: 'agent', systemPrompt: 'new' }, 7, true,
    )).rejects.toThrow('history insert failed');
    expect(conn.beginTransaction).toHaveBeenCalledOnce();
    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('creates agent and v1 on the same transaction connection', async () => {
    const { repo, tx, db } = fixture();
    const agent = { name: 'new', systemPrompt: 'initial', creatorId: 7 };
    await expect(repo.insert(agent)).resolves.toBe(4);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(tx.insert).toHaveBeenNthCalledWith(1, 'agent', expect.objectContaining({ systemPrompt: 'initial' }));
    expect(tx.insert).toHaveBeenNthCalledWith(2, 'agent_prompt_versions', {
      agentId: 4, version: 1, systemPrompt: 'initial', operatorId: 7, sourceVersion: null,
    });
  });

  it('does not report successful creation when snapshot persistence fails', async () => {
    const { repo, tx } = fixture();
    tx.insert.mockResolvedValueOnce(4).mockRejectedValueOnce(new Error('snapshot failed'));
    const agent: Agent = { name: 'new', systemPrompt: 'initial' };
    await expect(repo.insert(agent)).rejects.toThrow('snapshot failed');
    expect(agent.id).toBeUndefined();
  });

  it('locks the agent row before updating and assigns the next version', async () => {
    const { repo, tx, current } = fixture();
    tx.queryOne.mockResolvedValueOnce(current).mockResolvedValueOnce({ version: 3 });
    await repo.updateById({ ...current, systemPrompt: 'changed' }, 7, true);
    expect(tx.queryOne).toHaveBeenNthCalledWith(1, expect.stringContaining('FOR UPDATE'), [4]);
    expect(tx.updateById).toHaveBeenCalledWith('agent', 4, expect.objectContaining({ systemPrompt: 'changed' }));
    expect(tx.insert).toHaveBeenCalledWith('agent_prompt_versions', {
      agentId: 4, version: 4, systemPrompt: 'changed', operatorId: 7, sourceVersion: null,
    });
    expect(tx.queryOne.mock.invocationCallOrder[0]).toBeLessThan(tx.updateById.mock.invocationCallOrder[0]);
  });

  it('does not add a version for unchanged content', async () => {
    const { repo, tx, current } = fixture();
    tx.queryOne.mockResolvedValueOnce(current);
    await repo.updateById({ ...current, name: 'renamed' }, 7, true);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('preserves the locked latest prompt when the request omitted it', async () => {
    const { repo, tx, current } = fixture();
    tx.queryOne.mockResolvedValueOnce(current);
    const stale = { ...current, systemPrompt: 'stale', name: 'renamed' };
    await repo.updateById(stale, 7, false);
    expect(stale.systemPrompt).toBe('current');
    expect(tx.updateById).toHaveBeenCalledWith('agent', 4, expect.objectContaining({ systemPrompt: 'current' }));
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('rolls back only the prompt and appends a version with its source', async () => {
    const { repo, tx, current } = fixture();
    tx.queryOne.mockResolvedValueOnce({ ...current }).mockResolvedValueOnce({ systemPrompt: 'old' }).mockResolvedValueOnce({ version: 3 });
    const restored = await repo.rollbackPrompt(4, 1, 7);
    expect(tx.queryOne).toHaveBeenNthCalledWith(2, expect.stringContaining('agent_id = ? AND version = ?'), [4, 1]);
    expect(tx.updateById).toHaveBeenCalledExactlyOnceWith('agent', 4, { systemPrompt: 'old' });
    expect(tx.insert).toHaveBeenCalledWith('agent_prompt_versions', {
      agentId: 4, version: 4, systemPrompt: 'old', operatorId: 7, sourceVersion: 1,
    });
    expect(restored).toEqual({ ...current, systemPrompt: 'old' });
  });

  it('does not write when rollback content already matches', async () => {
    const { repo, tx, current } = fixture();
    tx.queryOne.mockResolvedValueOnce(current).mockResolvedValueOnce({ systemPrompt: 'current' });
    await repo.rollbackPrompt(4, 1, 7);
    expect(tx.updateById).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('rejects missing agents and versions without writes', async () => {
    const { repo, tx, current } = fixture();
    tx.queryOne.mockResolvedValueOnce(null);
    await expect(repo.rollbackPrompt(4, 1, 7)).rejects.toThrow();
    tx.queryOne.mockResolvedValueOnce(current).mockResolvedValueOnce(null);
    await expect(repo.rollbackPrompt(4, 99, 7)).rejects.toThrow('提示词版本不存在');
    expect(tx.updateById).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it.each(['update', 'rollback'])('propagates snapshot failure from %s to the transaction', async (operation) => {
    const { repo, tx, current } = fixture();
    tx.queryOne.mockResolvedValueOnce(current);
    if (operation === 'rollback') tx.queryOne.mockResolvedValueOnce({ systemPrompt: 'old' });
    tx.queryOne.mockResolvedValueOnce({ version: 3 });
    tx.insert.mockRejectedValueOnce(new Error('snapshot failed'));
    const save = operation === 'rollback'
      ? repo.rollbackPrompt(4, 1, 7)
      : repo.updateById({ ...current, systemPrompt: 'changed' }, 7, true);
    await expect(save).rejects.toThrow('snapshot failed');
  });
});
