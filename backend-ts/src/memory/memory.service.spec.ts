import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { WEIXIN_PROJECT_KEY } from '../domain/types.js';
import {
  MemoryService,
  computeDedupHash,
  isRobotChannelProjectKey,
  memoryContentLength,
  normalizeMemoryContent,
} from './memory.service.js';
import type { MemoryRepository } from './memory.repository.js';
import type { MemoryItemRow } from './types.js';

function repo(): MemoryRepository {
  return {
    page: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    countActive: vi.fn(async () => 0),
    findById: vi.fn(async () => null),
    findByHash: vi.fn(async () => null),
    insert: vi.fn(async () => 1),
    updateContent: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
    touch: vi.fn(async () => undefined),
    deleteById: vi.fn(async () => undefined),
    listActiveUser: vi.fn(async () => []),
    listActiveProject: vi.fn(async () => []),
    findPreference: vi.fn(async () => null),
    insertPreference: vi.fn(async () => undefined),
    updatePreference: vi.fn(async () => undefined),
    transaction: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn({})),
  } as never as MemoryRepository;
}

function row(overrides: Partial<MemoryItemRow> = {}): MemoryItemRow {
  return {
    id: 1,
    userId: 7,
    scope: 'USER',
    projectKey: '',
    content: '输出报告用中文',
    source: 'MANUAL',
    status: 'ACTIVE',
    dedupHash: 'h',
    originSessionId: null,
    createdAt: '2026-10-02 10:00:00',
    updatedAt: '2026-10-02 10:00:00',
    ...overrides,
  };
}

function codeOf(fn: () => Promise<unknown>): Promise<number> {
  return fn().then(
    () => 0,
    (e) => (e instanceof BusinessException ? e.code : -1),
  );
}

describe('memory content normalization and dedup hash', () => {
  it('normalizesTrimAndCollapsesWhitespace', () => {
    expect(normalizeMemoryContent('  输出  报告\t用\n\n中文  ')).toBe('输出 报告 用 中文');
    expect(normalizeMemoryContent(null)).toBe('');
    expect(memoryContentLength('a👍b')).toBe(3);
  });

  it('sameNormalizedContentYieldsSameHashRegardlessOfRawWhitespace', () => {
    const a = computeDedupHash('USER', '', normalizeMemoryContent('输出  报告用中文'));
    const b = computeDedupHash('USER', '', normalizeMemoryContent(' 输出 报告用中文 '));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it('hashSeparatesScopeAndProjectKey', () => {
    const user = computeDedupHash('USER', '', 'x');
    const project = computeDedupHash('PROJECT', 'mao', 'x');
    const otherProject = computeDedupHash('PROJECT', 'web', 'x');
    expect(new Set([user, project, otherProject]).size).toBe(3);
  });
});

describe('robot channel project keys', () => {
  it('flagsWeixinAndFeishuKeysButKeepsRealProjects', () => {
    expect(isRobotChannelProjectKey(WEIXIN_PROJECT_KEY, null)).toBe(true);
    expect(isRobotChannelProjectKey('feishu-2-private-9', null)).toBe(true);
    // 飞书群聊键仅靠 workspace 识别不到，前缀判定兜底（手工创建路径无 workspace）
    expect(isRobotChannelProjectKey('feishu-chat-1-oc_abc', null)).toBe(true);
    expect(isRobotChannelProjectKey('oc_abc', '/opt/mao-data/workspace/feishu-chat/3/oc_abc')).toBe(true);
    expect(isRobotChannelProjectKey('mao', null)).toBe(false);
    expect(isRobotChannelProjectKey(null, null)).toBe(false);
  });
});

describe('MemoryService.create', () => {
  it('rejectsBlankAndOverlongContent', async () => {
    const svc = new MemoryService(repo(), { listProjectKeyRows: async () => [] });
    expect(await codeOf(() => svc.create(7, { scope: 'USER', content: '   ' }))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(await codeOf(() => svc.create(7, { scope: 'USER', content: '长'.repeat(501) }))).toBe(ErrorCode.PARAM_INVALID.code);
  });

  it('projectScopeRequiresProjectKeyAndRejectsRobotKeys', async () => {
    const svc = new MemoryService(repo(), { listProjectKeyRows: async () => [] });
    expect(await codeOf(() => svc.create(7, { scope: 'PROJECT', content: 'x' }))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(await codeOf(() => svc.create(7, { scope: 'PROJECT', content: 'x', projectKey: WEIXIN_PROJECT_KEY }))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(await codeOf(() => svc.create(7, { scope: 'PROJECT', content: 'x', projectKey: 'feishu-1-private-2' }))).toBe(ErrorCode.PARAM_INVALID.code);
  });

  it('enforcesActiveLimit200', async () => {
    const r = repo();
    (r.countActive as ReturnType<typeof vi.fn>).mockResolvedValue(200);
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    expect(await codeOf(() => svc.create(7, { scope: 'USER', content: 'x' }))).toBe(ErrorCode.MEMORY_LIMIT_EXCEEDED.code);
    expect(r.insert).not.toHaveBeenCalled();
  });

  it('rejectsDuplicateContentWithinSameUser', async () => {
    const r = repo();
    (r.findByHash as ReturnType<typeof vi.fn>).mockResolvedValue(row());
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    expect(await codeOf(() => svc.create(7, { scope: 'USER', content: '输出报告用中文' }))).toBe(ErrorCode.MEMORY_CONTENT_DUPLICATE.code);
    // 不同 scope 的相同内容各自独立去重：命中 USER 级哈希不挡 PROJECT 级新增
    (r.findByHash as ReturnType<typeof vi.fn>).mockImplementation(async (_uid, hash) => (
      hash === computeDedupHash('USER', '', '输出报告用中文') ? row() : null
    ));
    (r.insert as ReturnType<typeof vi.fn>).mockResolvedValue(6);
    (r.findById as ReturnType<typeof vi.fn>).mockResolvedValue(row({ id: 6, scope: 'PROJECT', projectKey: 'mao', dedupHash: computeDedupHash('PROJECT', 'mao', '输出报告用中文') }));
    const vo = await svc.create(7, { scope: 'PROJECT', content: '输出报告用中文', projectKey: 'mao' });
    expect(vo.scope).toBe('PROJECT');
    expect(vo.projectKey).toBe('mao');
  });

  it('insertsAsManualActiveAndNormalizesContent', async () => {
    const r = repo();
    (r.insert as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    (r.findById as ReturnType<typeof vi.fn>).mockResolvedValue(row({ id: 5, content: '输出 报告用中文', dedupHash: computeDedupHash('USER', '', '输出 报告用中文') }));
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    const vo = await svc.create(7, { scope: 'USER', content: '  输出  报告用中文 ' });
    expect(vo.source).toBe('MANUAL');
    expect(vo.status).toBe('ACTIVE');
    const inserted = (r.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inserted.content).toBe('输出 报告用中文');
    expect(inserted.dedupHash).toBe(computeDedupHash('USER', '', '输出 报告用中文'));
  });
});

describe('MemoryService.update', () => {
  it('editRecomputesHashAndReportsConflict', async () => {
    const r = repo();
    (r.findById as ReturnType<typeof vi.fn>).mockResolvedValue(row({ content: '旧内容', dedupHash: 'old' }));
    (r.findByHash as ReturnType<typeof vi.fn>).mockResolvedValue(row({ id: 9, content: '新内容', dedupHash: 'new' }));
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    expect(await codeOf(() => svc.update(7, 1, { content: '新内容' }))).toBe(ErrorCode.MEMORY_CONTENT_DUPLICATE.code);
    expect(r.updateContent).not.toHaveBeenCalled();
  });

  it('editDoesNotChangeStatusAndKeepsDismissedAsDismissed', async () => {
    const r = repo();
    (r.findById as ReturnType<typeof vi.fn>).mockResolvedValue(row({ status: 'DISMISSED', content: '旧内容', dedupHash: 'old' }));
    (r.findByHash as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (r.updateContent as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    const vo = await svc.update(7, 1, { content: '编辑后的内容' });
    expect(vo.status).toBe('DISMISSED');
    expect(r.updateStatus).not.toHaveBeenCalled();
    expect(r.updateContent).toHaveBeenCalledWith(1, '编辑后的内容', computeDedupHash('USER', '', '编辑后的内容'), expect.anything());
  });

  it('restoreDismissedRequiresExplicitStatusSwitch', async () => {
    const r = repo();
    (r.findById as ReturnType<typeof vi.fn>).mockResolvedValue(row({ status: 'DISMISSED' }));
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    await svc.update(7, 1, { content: null, status: 'ACTIVE' });
    expect(r.updateStatus).toHaveBeenCalledWith(1, 'ACTIVE', expect.anything());
  });

  it('restoreDismissedRespectsActiveLimit', async () => {
    const r = repo();
    (r.findById as ReturnType<typeof vi.fn>).mockResolvedValue(row({ status: 'DISMISSED' }));
    (r.countActive as ReturnType<typeof vi.fn>).mockResolvedValue(200);
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    expect(await codeOf(() => svc.update(7, 1, { content: null, status: 'ACTIVE' }))).toBe(ErrorCode.MEMORY_LIMIT_EXCEEDED.code);
    expect(r.updateStatus).not.toHaveBeenCalled();
  });

  it('createMapsConcurrentDuplicateKeyRaceToBusinessCode', async () => {
    const r = repo();
    (r.insert as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('Duplicate entry'), { errno: 1062 }));
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    expect(await codeOf(() => svc.create(7, { scope: 'USER', content: '输出报告用中文' }))).toBe(ErrorCode.MEMORY_CONTENT_DUPLICATE.code);
  });

  it('crossUserUpdateIsNotFound', async () => {
    const r = repo();
    (r.findById as ReturnType<typeof vi.fn>).mockResolvedValue(row({ userId: 8 }));
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    expect(await codeOf(() => svc.update(7, 1, { content: 'x' }))).toBe(ErrorCode.MEMORY_ITEM_NOT_FOUND.code);
  });
});

describe('MemoryService.remove and settings', () => {
  it('crossUserRemoveIsNotFound', async () => {
    const r = repo();
    (r.findById as ReturnType<typeof vi.fn>).mockResolvedValue(row({ userId: 8 }));
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    expect(await codeOf(() => svc.remove(7, 1))).toBe(ErrorCode.MEMORY_ITEM_NOT_FOUND.code);
    expect(r.deleteById).not.toHaveBeenCalled();
  });

  it('settingsDefaultOffWithoutPreferenceRow', async () => {
    const r = repo();
    (r.findPreference as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    // 默认关闭：未开启的用户不做自动抽取，现有功能零影响
    expect(await svc.getAutoCaptureEnabled(7)).toBe(false);
    (r.findPreference as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 7, autoCaptureEnabled: 0 });
    expect(await svc.getAutoCaptureEnabled(7)).toBe(false);
    (r.findPreference as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 7, autoCaptureEnabled: 1 });
    expect(await svc.getAutoCaptureEnabled(7)).toBe(true);
  });

  it('settingsInsertOrUpdateByRowPresence', async () => {
    const r = repo();
    (r.findPreference as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null).mockResolvedValueOnce({ userId: 7, autoCaptureEnabled: 1 });
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    await svc.updateAutoCaptureEnabled(7, false);
    expect(r.insertPreference).toHaveBeenCalledWith(7, false);
    await svc.updateAutoCaptureEnabled(7, false);
    expect(r.updatePreference).toHaveBeenCalledWith(7, false);
  });

  // ── 并发首调开关的主键冲突回归（评审确认缺陷的修复回归：1062 必须回落更新分支而非冒泡 500） ──
  it('settingsToggleSurvivesConcurrentFirstCallDuplicateKey', async () => {
    // 两个端/标签页首次同时打开开关：findPreference 双方都拿到 null → 并发 insertPreference，
    // 后到者撞 user_id 主键冲突（errno 1062）。当前实现未像 create/update 那样把唯一键冲突
    // 转为兜底分支，原始 DB 错误直接冒泡到路由 → 用户侧看到 500 而非开关生效
    const r = repo();
    (r.findPreference as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (r.insertPreference as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("Duplicate entry '7' for key 'user_memory_preference.PRIMARY'"), { errno: 1062 }),
    );
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    await expect(svc.updateAutoCaptureEnabled(7, true)).resolves.toBe(true);
  });
});

describe('MemoryService.listProjectKeys', () => {
  it('dedupesAndExcludesRobotChannelKeys', async () => {
    const svc = new MemoryService(repo(), {
      listProjectKeyRows: async () => [
        { projectKey: 'web', workspace: '/x/web' },
        { projectKey: 'web', workspace: '/y/web' },
        { projectKey: WEIXIN_PROJECT_KEY, workspace: null },
        { projectKey: 'feishu-2-private-9', workspace: null },
        { projectKey: 'oc_abc', workspace: '/opt/mao-data/workspace/feishu-chat/3/oc_abc' },
        { projectKey: '', workspace: null },
        { projectKey: 'mao', workspace: null },
      ],
    });
    expect(await svc.listProjectKeys(7)).toEqual(['mao', 'web']);
  });
});

describe('MemoryService.listForInjection', () => {
  function userRows(n: number): MemoryItemRow[] {
    return Array.from({ length: n }, (_, i) => row({ id: i + 1, scope: 'USER', content: `user-${i}` }));
  }

  function projectRows(n: number): MemoryItemRow[] {
    return Array.from({ length: n }, (_, i) => row({ id: 100 + i, scope: 'PROJECT', projectKey: 'mao', content: `project-${i}` }));
  }

  it('truncatesTo8UserAnd12Project', async () => {
    const r = repo();
    (r.listActiveUser as ReturnType<typeof vi.fn>).mockResolvedValue(userRows(8));
    (r.listActiveProject as ReturnType<typeof vi.fn>).mockResolvedValue(projectRows(12));
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    const hints = await svc.listForInjection(7, 'mao', '/ws/mao');
    expect(r.listActiveUser).toHaveBeenCalledWith(7, 8);
    expect(r.listActiveProject).toHaveBeenCalledWith(7, 'mao', 12);
    expect(hints.filter((h) => h.scope === 'USER')).toHaveLength(8);
    expect(hints.filter((h) => h.scope === 'PROJECT')).toHaveLength(12);
    expect(hints.every((h) => h.scope === 'PROJECT' ? h.projectKey === 'mao' : h.projectKey === null)).toBe(true);
  });

  it('nullOrRobotProjectKeyQueriesUserScopeOnly', async () => {
    const r = repo();
    (r.listActiveUser as ReturnType<typeof vi.fn>).mockResolvedValue(userRows(2));
    const svc = new MemoryService(r, { listProjectKeyRows: async () => [] });
    expect(await svc.listForInjection(7, null, null)).toHaveLength(2);
    expect(await svc.listForInjection(7, WEIXIN_PROJECT_KEY, null)).toHaveLength(2);
    expect(await svc.listForInjection(7, 'feishu-2-private-9', null)).toHaveLength(2);
    expect(await svc.listForInjection(7, 'oc_abc', '/opt/mao-data/workspace/feishu-chat/3/oc_abc')).toHaveLength(2);
    expect(r.listActiveProject).not.toHaveBeenCalled();
  });
});
