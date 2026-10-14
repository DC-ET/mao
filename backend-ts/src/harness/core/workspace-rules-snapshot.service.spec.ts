import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceRulesSnapshotService } from './workspace-rules-snapshot.service.js';
import type { SessionWorkspaceRulesRow, WorkspaceRulesSnapshotRepository } from './workspace-rules-snapshot.repository.js';
import * as harnessLogModule from '../log.js';

const RULES = '## 工作区规则\n\nrule-one\n';
const RULES_HASH = createHash('sha256').update(RULES).digest('hex');

function row(overrides: Partial<SessionWorkspaceRulesRow> = {}): SessionWorkspaceRulesRow {
  return {
    sessionId: 811,
    workspace: '/ws/a',
    rulesText: RULES,
    rulesHash: RULES_HASH,
    sourcePath: '/ws/a/AGENTS.md',
    sourceMtime: 1000,
    createdAt: '2026-10-14 10:00:00.000',
    updatedAt: '2026-10-14 10:00:00.000',
    ...overrides,
  };
}

function setup(initial: SessionWorkspaceRulesRow | null = null) {
  const repo = {
    selectBySessionId: vi.fn(async () => initial),
    upsert: vi.fn(async () => {}),
    deleteBySessionId: vi.fn(async () => 1),
  } as unknown as WorkspaceRulesSnapshotRepository;
  const service = new WorkspaceRulesSnapshotService(repo);
  return { repo, service };
}

const source = { sourcePath: '/ws/a/AGENTS.md', sourceMtime: 2000 };

describe('WorkspaceRulesSnapshotService resolve', () => {
  it('无快照时落库并用本次读盘文本', async () => {
    const { repo, service } = setup();
    const text = await service.resolve(811, '/ws/a', RULES, source);

    expect(text).toBe(RULES);
    expect(repo.upsert).toHaveBeenCalledOnce();
    const [arg] = vi.mocked(repo.upsert).mock.calls[0];
    expect(arg).toMatchObject({
      sessionId: 811,
      workspace: '/ws/a',
      rulesText: RULES,
      sourcePath: '/ws/a/AGENTS.md',
      sourceMtime: 2000,
    });
    expect(arg.rulesHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('有快照且同 workspace 时用快照文本，即使磁盘已变', async () => {
    const { repo, service } = setup(row());
    const changed = '## 工作区规则\n\nrule-two\n';

    const text = await service.resolve(811, '/ws/a', changed, source);

    expect(text).toBe(RULES);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('有快照且磁盘已变为空时仍注入快照文本（不摘节）', async () => {
    const { repo, service } = setup(row());

    const text = await service.resolve(811, '/ws/a', '', source);

    expect(text).toBe(RULES);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('LOCAL 桌面端漏报（rawText 为空）时仍注入快照文本', async () => {
    const { repo, service } = setup(row({ sourcePath: null, sourceMtime: null }));

    const text = await service.resolve(811, '/ws/a', '', { sourcePath: null, sourceMtime: null });

    expect(text).toBe(RULES);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('workspace 不一致时覆盖重写，不误用旧文本', async () => {
    const { repo, service } = setup(row({ workspace: '/ws/old' }));
    const fresh = '## 工作区规则\n\nrule-b\n';

    const text = await service.resolve(811, '/ws/b', fresh, { sourcePath: '/ws/b/AGENTS.md', sourceMtime: 3000 });

    expect(text).toBe(fresh);
    expect(repo.upsert).toHaveBeenCalledOnce();
    expect(vi.mocked(repo.upsert).mock.calls[0][0]).toMatchObject({
      workspace: '/ws/b',
      rulesText: fresh,
      sourcePath: '/ws/b/AGENTS.md',
    });
  });

  it('快照行为异常空值时用读盘内容覆盖修复', async () => {
    const { repo, service } = setup(row({ rulesText: '', rulesHash: '' }));

    const text = await service.resolve(811, '/ws/a', RULES, source);

    expect(text).toBe(RULES);
    expect(repo.upsert).toHaveBeenCalledOnce();
  });

  it('无快照且读盘为空时不落库、不注入该节', async () => {
    const { repo, service } = setup();

    const text = await service.resolve(811, '/ws/a', '', source);

    expect(text).toBe('');
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(repo.deleteBySessionId).not.toHaveBeenCalled();
  });

  it('workspace 不一致且空读：摘除该节并回收失效行，不留僵尸行', async () => {
    const { repo, service } = setup(row({ workspace: '/ws/old' }));

    const text = await service.resolve(811, '/ws/b', '', source);

    expect(text).toBe('');
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(repo.deleteBySessionId).toHaveBeenCalledWith(811);
  });

  it('快照行为空值且空读：回收异常行', async () => {
    const { repo, service } = setup(row({ rulesText: '', rulesHash: '' }));

    const text = await service.resolve(811, '/ws/a', '', source);

    expect(text).toBe('');
    expect(repo.deleteBySessionId).toHaveBeenCalledWith(811);
  });
});

describe('WorkspaceRulesSnapshotService logging', () => {
  it('同一 disk_hash 每会话只打一次，hash 再变时再打一次', async () => {
    const warn = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => {});
    try {
      const { service } = setup(row());
      const v2 = '## 工作区规则\n\nrule-two\n';
      const v3 = '## 工作区规则\n\nrule-three\n';

      await service.resolve(811, '/ws/a', v2, source);
      await service.resolve(811, '/ws/a', v2, source);
      const afterV2 = warn.mock.calls.filter((c) => String(c[1]).includes('changed on disk')).length;
      expect(afterV2).toBe(1);

      await service.resolve(811, '/ws/a', v3, source);
      const afterV3 = warn.mock.calls.filter((c) => String(c[1]).includes('changed on disk')).length;
      expect(afterV3).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('磁盘与快照一致时不打「已变」日志', async () => {
    const warn = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => {});
    try {
      const { service } = setup(row());
      await service.resolve(811, '/ws/a', RULES, source);
      expect(warn.mock.calls.filter((c) => String(c[1]).includes('changed on disk'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('空读打「empty on disk but snapshot retained」', async () => {
    const warn = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => {});
    try {
      const { service } = setup(row());
      await service.resolve(811, '/ws/a', '', source);
      expect(warn.mock.calls.some((c) => String(c[1]).includes('empty on disk but snapshot retained'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('空读日志每会话只打一次（LOCAL 重启后无桌面端上报的连续轮次）', async () => {
    const warn = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => {});
    try {
      const { service } = setup(row());
      for (let i = 0; i < 5; i++) {
        await service.resolve(811, '/ws/a', '', source);
      }
      expect(warn.mock.calls.filter((c) => String(c[1]).includes('empty on disk but snapshot retained'))).toHaveLength(1);

      // 失效/删除后重新冻结，空读日志应能再次打出
      service.resetForTest();
      await service.resolve(811, '/ws/a', '', source);
      expect(warn.mock.calls.filter((c) => String(c[1]).includes('empty on disk but snapshot retained'))).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('WorkspaceRulesSnapshotService invalidate / delete', () => {
  it('invalidate 删行并让下一次 resolve 落到新文本', async () => {
    let stored: SessionWorkspaceRulesRow | null = row();
    const repo = {
      selectBySessionId: vi.fn(async () => stored),
      upsert: vi.fn(async () => {}),
      deleteBySessionId: vi.fn(async () => {
        const had = stored != null;
        stored = null;
        return had ? 1 : 0;
      }),
    } as unknown as WorkspaceRulesSnapshotRepository;
    const service = new WorkspaceRulesSnapshotService(repo);

    await service.invalidate(811);
    expect(repo.deleteBySessionId).toHaveBeenCalledWith(811);

    const fresh = '## 工作区规则\n\nrule-new\n';
    const text = await service.resolve(811, '/ws/a', fresh, source);
    expect(text).toBe(fresh);
    expect(repo.upsert).toHaveBeenCalledOnce();
  });

  it('invalidate 对无快照会话不打 invalidated 日志', async () => {
    const warn = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => {});
    try {
      const repo = {
        selectBySessionId: vi.fn(async () => null),
        upsert: vi.fn(async () => {}),
        deleteBySessionId: vi.fn(async () => 0),
      } as unknown as WorkspaceRulesSnapshotRepository;
      const service = new WorkspaceRulesSnapshotService(repo);
      await service.invalidate(811);
      expect(repo.deleteBySessionId).toHaveBeenCalledWith(811);
      expect(warn.mock.calls.filter((c) => String(c[1]).includes('invalidated'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('deleteBySessionId 删行', async () => {
    const { repo, service } = setup();
    await service.deleteBySessionId(811);
    expect(repo.deleteBySessionId).toHaveBeenCalledWith(811);
  });

  it('resetForTest 清空日志去重状态', async () => {
    const warn = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => {});
    try {
      const { service } = setup(row());
      const v2 = '## 工作区规则\n\nrule-two\n';
      await service.resolve(811, '/ws/a', v2, source);
      expect(warn.mock.calls.filter((c) => String(c[1]).includes('changed on disk'))).toHaveLength(1);
      service.resetForTest();
      await service.resolve(811, '/ws/a', v2, source);
      expect(warn.mock.calls.filter((c) => String(c[1]).includes('changed on disk'))).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('DB 抛错时异常上抛（由调用方降级为读盘内容）', async () => {
    const repo = {
      selectBySessionId: vi.fn(async () => {
        throw new Error('db down');
      }),
      upsert: vi.fn(async () => {}),
      deleteBySessionId: vi.fn(async () => 1),
    } as unknown as WorkspaceRulesSnapshotRepository;
    const service = new WorkspaceRulesSnapshotService(repo);
    await expect(service.resolve(811, '/ws/a', RULES, source)).rejects.toThrow('db down');
  });
});
