import { describe, expect, it, vi } from 'vitest';
import { WorkspaceRulesSnapshotRepository } from './workspace-rules-snapshot.repository.js';

function mockDb() {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => ({ affectedRows: 1, insertId: 0 })),
  };
}

describe('WorkspaceRulesSnapshotRepository', () => {
  it('selectBySessionId 命中与 miss', async () => {
    const db = mockDb();
    const repo = new WorkspaceRulesSnapshotRepository(db as never);

    expect(await repo.selectBySessionId(811)).toBeNull();
    expect(db.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM session_workspace_rules WHERE session_id = ?'),
      [811],
    );

    db.queryOne.mockResolvedValueOnce({ sessionId: 811, workspace: '/ws/a' });
    expect(await repo.selectBySessionId(811)).toEqual({ sessionId: 811, workspace: '/ws/a' });
  });

  it('upsert 首次插入', async () => {
    const db = mockDb();
    const repo = new WorkspaceRulesSnapshotRepository(db as never);

    await repo.upsert({
      sessionId: 811,
      workspace: '/ws/a',
      rulesText: '## 工作区规则\n\nr\n',
      rulesHash: 'h',
      sourcePath: '/ws/a/AGENTS.md',
      sourceMtime: 1000,
    });

    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO session_workspace_rules'),
      [811, '/ws/a', '## 工作区规则\n\nr\n', 'h', '/ws/a/AGENTS.md', 1000],
    );
  });

  it('upsert 冲突键时整列覆盖写回（不是 no-op）', async () => {
    const db = mockDb();
    const repo = new WorkspaceRulesSnapshotRepository(db as never);

    await repo.upsert({
      sessionId: 811,
      workspace: '/ws/b',
      rulesText: 'new',
      rulesHash: 'h2',
      sourcePath: null,
      sourceMtime: null,
    });

    const [sql] = db.execute.mock.calls[0] as [string];
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('workspace = VALUES(workspace)');
    expect(sql).toContain('rules_text = VALUES(rules_text)');
    expect(sql).toContain('rules_hash = VALUES(rules_hash)');
    expect(sql).toContain('source_path = VALUES(source_path)');
    expect(sql).toContain('source_mtime = VALUES(source_mtime)');
    expect(sql).not.toContain('session_id = VALUES(session_id)');
  });

  it('deleteBySessionId 返回影响行数', async () => {
    const db = mockDb();
    const repo = new WorkspaceRulesSnapshotRepository(db as never);

    expect(await repo.deleteBySessionId(811)).toBe(1);
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM session_workspace_rules WHERE session_id = ?'),
      [811],
    );

    db.execute.mockResolvedValueOnce({ affectedRows: 0, insertId: 0 });
    expect(await repo.deleteBySessionId(812)).toBe(0);
  });
});
